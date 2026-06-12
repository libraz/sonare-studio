/**
 * Offline mixdown renderer: turns a plain project document into stereo audio
 * without touching the realtime engine or any reactive state, so it runs on
 * the main thread and inside module workers alike.
 *
 * Audio clips reuse the exact transforms of live playback scheduling
 * (src/project/scheduling.ts): the same slice/fade/resample pipeline. MIDI
 * clips are prerendered per instrument (live playback instead drives the
 * engine's realtime instruments). Strip insert/EQ processing is baked in
 * offline (src/export/strip-render.ts) to mirror the strip DSP the realtime
 * engine applies live. The clips are then summed onto a stereo bus honoring
 * their timeline positions, where the master strip's inserts/EQ and the
 * project mastering chain are applied.
 *
 * Differences from live playback, by design:
 * - MIDI clip levels: this renderer normalizes each prerendered MIDI clip to
 *   the target peak times the clip gain, while live playback plays the
 *   instruments at their native level with the clip gain folded into note
 *   velocities — MIDI track loudness can therefore differ,
 * - buses and sends are not rendered here (live playback sums them through
 *   the engine's bus lanes),
 * - the mastering chain runs here only.
 */

import {
  type MidiNote,
  midiClipCacheKey,
  normalizeGain,
  type PrerenderMidiClipOptions,
  peakAmplitude,
  prerenderMidiClip,
} from '@/engine/instruments';
import { defaultStripDsp, makeStripProcessor } from '@/export/strip-render';
import { ensureWasm } from '@/lib/wasm';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import {
  clampPan,
  createDefaultStrip,
  dbToLinear,
  type MasteringChainState,
  type MixerStrip,
  masteringChainIsActive,
  stripHasDsp,
} from '@/project/mixer';
import { applyBalancePan, applyStripDsp, type StripProcessorDeps } from '@/project/mixer-dsp';
import {
  applyAudioClipFades,
  audioClipProcessingCacheKey,
  clipPlaybackNotes,
  DEFAULT_TARGET_PEAK,
  isTrackAudible,
  ppqToSeconds,
  resampleChannelsLinear,
  sliceAudioClipWindow,
} from '@/project/scheduling';
import type { DocumentClip, DocumentTrack, ProjectDocument } from '@/project/serialization';

/** Tempo assumed when the document carries no tempo segment. */
const DEFAULT_TEMPO_BPM = 120;

/** Thrown when a mixdown render is cancelled via {@link MixdownOptions.shouldCancel}. */
export class MixdownCancelledError extends Error {
  constructor() {
    super('Mixdown render was cancelled');
    this.name = 'MixdownCancelledError';
  }
}

/** An explicit PPQ window to render. */
export interface MixdownRangePpq {
  /** Window start in PPQ (>= 0). */
  startPpq: number;
  /** Window end in PPQ (> startPpq). */
  endPpq: number;
}

/**
 * Render range: 'project' renders from PPQ 0 to the end of the arrangement
 * (including instrument release tails), 'loop' renders the window given by
 * {@link MixdownOptions.loopRegion}, and an explicit object renders that
 * window.
 */
export type MixdownRange = 'project' | 'loop' | MixdownRangePpq;

/** Progress callback: fraction in [0, 1] plus the stage being entered. */
export type MixdownProgressFn = (progress: number, stage: string) => void;

/** Mastering seam used to apply the project mastering chain to the mix bus. */
export interface MasteringDeps {
  /** One-shot stereo processor invocation (masteringProcessStereo shape). */
  processStereo(
    name: string,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    params: Record<string, number | boolean>,
  ): { left: Float32Array; right: Float32Array };
  /**
   * Whole-chain preset application (masterAudioStereo shape). Omit when the
   * wasm module does not expose it; preset stages are then skipped.
   */
  applyPreset?(
    preset: string,
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
  ): { left: Float32Array; right: Float32Array };
}

/** Metering seam used for the post-render loudness/peak report. */
export interface MeteringDeps {
  /** Inter-sample (true) peak of one channel in dBFS. */
  truePeakDb?(samples: Float32Array, sampleRate: number): number;
  /** Integrated loudness of a mono downmix in LUFS. */
  integratedLufs?(samples: Float32Array, sampleRate: number): number;
}

/** All injectable wasm seams of a mixdown render. */
export interface MixdownDeps {
  /** Channel-strip insert/EQ seam; null = strips degrade to gain/pan only. */
  stripDsp: StripProcessorDeps | null;
  /** Mastering chain seam; null = the mastering chain is skipped. */
  mastering: MasteringDeps | null;
  /** Metering seam; null = the report carries the sample peak only. */
  metering: MeteringDeps | null;
}

/** Options for {@link renderMixdown}. */
export interface MixdownOptions {
  /** Output sample rate in Hz; defaults to the document sample rate. */
  sampleRate?: number;
  /** Render range (default 'project'). */
  range?: MixdownRange;
  /** Loop window used when range is 'loop' (documents carry no loop state). */
  loopRegion?: MixdownRangePpq;
  /**
   * True (default) applies master inserts/EQ and the mastering chain to the
   * summed bus. False renders the raw mix (master gain/pan still apply, as
   * they are audible in live playback).
   */
  includeMasterChain?: boolean;
  /** True also returns one stereo stem per track (post-strip, pre-master). */
  stems?: boolean;
  /**
   * Base peak level per MIDI clip before track volume and clip gain (default
   * 0.5 = -6 dBFS, matching live scheduling). Pass null to mix at the
   * rendered level (track volume and clip gain are then not applied to MIDI
   * clips). Audio clips are never normalized.
   */
  targetPeak?: number | null;
  /**
   * Wasm seams: undefined derives them from the loaded wasm module, null
   * disables them all (pure-TS render: gain/pan/fades only, sample-peak
   * report). Injectable for tests.
   */
  deps?: MixdownDeps | null;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** SoundFont loader for 'sf2' instruments (defaults to the OPFS font store). */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Progress callback (per clip and per master/mastering stage). */
  onProgress?: MixdownProgressFn;
  /**
   * Cancellation flag, checked between clips and between master/mastering
   * stages; returning true aborts the render with {@link MixdownCancelledError}.
   */
  shouldCancel?: () => boolean;
  /**
   * Awaited between clips. Workers pass a macrotask yield here so cancel
   * messages are processed even when every clip render hits a memory cache.
   */
  yieldBetweenClips?: () => Promise<void>;
}

/** One per-track stem of a mixdown render (post-strip, pre-master). */
export interface MixdownStem {
  /** Index of the track in the document's track list. */
  trackIndex: number;
  /** Track display name. */
  name: string;
  /** Planar stereo buffers covering the full render window. */
  channels: [Float32Array, Float32Array];
}

/** Loudness/peak measurements of the rendered mix. */
export interface MixdownReport {
  /** Sample peak in dBFS (-Infinity for silence). Always present. */
  peakDb: number;
  /** Inter-sample (true) peak in dBFS; absent without a metering seam. */
  truePeakDb?: number;
  /** Integrated loudness of the mono downmix in LUFS; absent without a metering seam. */
  lufs?: number;
}

/** Result of {@link renderMixdown}. */
export interface MixdownResult {
  /** Planar stereo mixdown buffers. */
  channels: [Float32Array, Float32Array];
  /** Output sample rate in Hz. */
  sampleRate: number;
  /** Render length in frames. */
  totalFrames: number;
  /** Loudness/peak report of the mixdown. */
  report: MixdownReport;
  /** Per-track stems; present only when options.stems is true. */
  stems?: MixdownStem[];
}

/** Narrow runtime view of the wasm module used to build the default seams. */
interface MixdownWasmSurface {
  masteringProcessStereo?: (
    name: never,
    left: Float32Array,
    right: Float32Array,
    sampleRate?: number,
    params?: Record<string, number | boolean>,
  ) => { left: Float32Array; right: Float32Array };
  masterAudioStereo?: (
    left: Float32Array,
    right: Float32Array,
    sampleRate?: number,
    presetName?: never,
    overrides?: Record<string, number | boolean>,
  ) => { left: Float32Array; right: Float32Array };
  meteringTruePeakDb?: (samples: Float32Array, sampleRate?: number) => number;
  lufs?: (samples: Float32Array, sampleRate?: number) => { integratedLufs: number };
}

/**
 * Builds the default mixdown seams from the loaded wasm module, degrading
 * each seam to null/absent when the module (an older build or a minimal test
 * mock) does not expose the underlying function.
 */
export async function createWasmMixdownDeps(): Promise<MixdownDeps> {
  const wasm = (await ensureWasm()) as unknown as MixdownWasmSurface;
  const stripDsp = await defaultStripDsp();
  const processStereo = wasm.masteringProcessStereo;
  let mastering: MasteringDeps | null = null;
  if (typeof processStereo === 'function') {
    mastering = {
      processStereo: (name, left, right, sampleRate, params) => {
        const out = processStereo(name as never, left, right, sampleRate, params);
        return { left: out.left, right: out.right };
      },
    };
    const masterAudioStereo = wasm.masterAudioStereo;
    if (typeof masterAudioStereo === 'function') {
      mastering.applyPreset = (preset, left, right, sampleRate) => {
        const out = masterAudioStereo(left, right, sampleRate, preset as never);
        return { left: out.left, right: out.right };
      };
    }
  }
  const metering: MeteringDeps = {};
  const truePeakDb = wasm.meteringTruePeakDb;
  if (typeof truePeakDb === 'function') {
    metering.truePeakDb = (samples, sampleRate) => truePeakDb(samples, sampleRate);
  }
  const lufs = wasm.lufs;
  if (typeof lufs === 'function') {
    metering.integratedLufs = (samples, sampleRate) => lufs(samples, sampleRate).integratedLufs;
  }
  return {
    stripDsp,
    mastering,
    metering: metering.truePeakDb || metering.integratedLufs ? metering : null,
  };
}

/** Converts a PPQ position to a frame index at a constant tempo. */
function ppqToFrames(ppq: number, tempoBpm: number, sampleRate: number): number {
  return Math.round(ppqToSeconds(ppq, tempoBpm) * sampleRate);
}

/** One rendered clip awaiting summation. */
interface RenderedClip {
  channels: Float32Array[];
  startFrame: number;
  gain: number;
}

/** One audible track with its rendered clips. */
interface RenderedTrack {
  trackIndex: number;
  name: string;
  clips: RenderedClip[];
}

/** Resolved render window: endPpq null = up to the end of the content. */
interface ResolvedRange {
  startPpq: number;
  endPpq: number | null;
}

/** Validates and resolves the requested range into a PPQ window. */
function resolveRange(options: MixdownOptions): ResolvedRange {
  const range = options.range ?? 'project';
  if (range === 'project') return { startPpq: 0, endPpq: null };
  const window = range === 'loop' ? options.loopRegion : range;
  if (range === 'loop' && !window) {
    throw new RangeError("Mixdown range 'loop' requires options.loopRegion");
  }
  const { startPpq, endPpq } = window as MixdownRangePpq;
  if (!Number.isFinite(startPpq) || startPpq < 0 || !Number.isFinite(endPpq)) {
    throw new RangeError(`Mixdown range PPQ values must be finite and >= 0`);
  }
  if (endPpq <= startPpq) {
    throw new RangeError(`Mixdown range end (${endPpq}) must be after its start (${startPpq})`);
  }
  return { startPpq, endPpq };
}

/**
 * Adds a clip's buffers onto a stereo bus with a linear gain, honoring the
 * clip's frame offset (which may be negative when the clip starts before the
 * render window) and clamping to the bus length.
 */
function mixInto(
  bus: [Float32Array, Float32Array],
  channels: ReadonlyArray<Float32Array>,
  offsetFrames: number,
  gain: number,
): void {
  const sources = [channels[0], channels[1] ?? channels[0]];
  for (let c = 0; c < 2; c++) {
    const src = sources[c];
    const dst = bus[c];
    if (!src) continue;
    const start = Math.max(0, offsetFrames);
    const end = Math.min(dst.length, offsetFrames + src.length);
    for (let i = start; i < end; i++) {
      dst[i] += src[i - offsetFrames] * gain;
    }
  }
}

/** Renders one audio clip into placement-ready buffers, or null to skip it. */
async function renderAudioClip(
  clip: DocumentClip,
  track: DocumentTrack,
  strip: MixerStrip | undefined,
  context: {
    tempoBpm: number;
    sampleRate: number;
    stripGain: number;
    pan: number;
    stripDsp: StripProcessorDeps | null;
    loadAudio: (assetId: string) => Promise<LoadedAudioAsset>;
  },
): Promise<RenderedClip | null> {
  if (!clip.assetId) return null;
  const gain = track.volume * clip.gain * context.stripGain;
  if (gain <= 0) return null;
  let asset: LoadedAudioAsset;
  try {
    asset = await context.loadAudio(clip.assetId);
  } catch {
    // Missing or unreadable asset: leave the clip silent, like live playback.
    return null;
  }
  let channels = sliceAudioClipWindow(
    asset.channels,
    asset.meta.sampleRate,
    clip.sourceOffsetPpq,
    clip.lengthPpq,
    context.tempoBpm,
  );
  channels = applyAudioClipFades(
    channels,
    asset.meta.sampleRate,
    context.tempoBpm,
    clip.fadeInPpq ?? 0,
    clip.fadeOutPpq ?? 0,
  );
  channels = resampleChannelsLinear(channels, asset.meta.sampleRate, context.sampleRate);
  if (channels.length === 0 || channels[0].length === 0) return null;
  const hasDsp = stripHasDsp(strip) && context.stripDsp !== null;
  if (hasDsp || context.pan !== 0) {
    const cacheKey = audioClipProcessingCacheKey(clip, context.tempoBpm, context.sampleRate);
    channels = makeStripProcessor(
      cacheKey,
      context.sampleRate,
      strip,
      context.stripDsp,
      context.pan,
    )(channels);
  }
  return {
    channels,
    startFrame: ppqToFrames(clip.startPpq, context.tempoBpm, context.sampleRate),
    gain,
  };
}

/** Renders one MIDI clip into placement-ready buffers, or null to skip it. */
async function renderMidiClip(
  clip: DocumentClip,
  track: DocumentTrack,
  strip: MixerStrip | undefined,
  context: {
    tempoBpm: number;
    sampleRate: number;
    stripGain: number;
    pan: number;
    basePeak: number | null;
    stripDsp: StripProcessorDeps | null;
    loadFont?: (fontId: string) => Promise<Uint8Array>;
  },
): Promise<RenderedClip | null> {
  const notes: MidiNote[] = clipPlaybackNotes(clip);
  if (notes.length === 0) return null;
  const targetPeak = context.basePeak === null ? null : context.basePeak * track.volume * clip.gain;
  if (targetPeak !== null && targetPeak <= 0) return null;
  const renderOptions: PrerenderMidiClipOptions = {
    sampleRate: context.sampleRate,
    tempoBpm: context.tempoBpm,
    ...(track.instrument !== undefined ? { instrument: track.instrument } : {}),
    ...(context.loadFont !== undefined ? { loadFont: context.loadFont } : {}),
  };
  const channels = await prerenderMidiClip(notes, renderOptions);
  const hasDsp = stripHasDsp(strip) && context.stripDsp !== null;
  const processed =
    hasDsp || context.pan !== 0
      ? makeStripProcessor(
          midiClipCacheKey(notes, renderOptions),
          context.sampleRate,
          strip,
          context.stripDsp,
          context.pan,
        )(channels)
      : channels;
  const baseGain = targetPeak === null ? 1 : normalizeGain(peakAmplitude(processed), targetPeak);
  return {
    channels: processed,
    startFrame: ppqToFrames(clip.startPpq, context.tempoBpm, context.sampleRate),
    gain: baseGain * context.stripGain,
  };
}

/**
 * Renders a project document to a stereo mixdown (and optional per-track
 * stems), entirely offline. See the module doc comment for the relation to
 * live playback.
 *
 * @param doc Plain project document (serializeProject output or equivalent).
 * @param options Render options and injectable seams.
 * @returns The mixdown, its loudness/peak report and optional stems.
 * @throws MixdownCancelledError when options.shouldCancel returns true.
 */
export async function renderMixdown(
  doc: ProjectDocument,
  options: MixdownOptions = {},
): Promise<MixdownResult> {
  const sampleRate = options.sampleRate ?? doc.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Mixdown sample rate must be finite and > 0, got ${sampleRate}`);
  }
  const tempoBpm = doc.tempoSegments[0]?.bpm ?? DEFAULT_TEMPO_BPM;
  const range = resolveRange(options);
  const includeMasterChain = options.includeMasterChain ?? true;
  const basePeak = options.targetPeak === undefined ? DEFAULT_TARGET_PEAK : options.targetPeak;
  const deps = options.deps !== undefined ? options.deps : await createWasmMixdownDeps();
  const stripDsp = deps?.stripDsp ?? null;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const master = doc.mixer?.master ?? createDefaultStrip();
  const chain: MasteringChainState | undefined = doc.mixer?.masteringChain;
  const checkCancel = () => {
    if (options.shouldCancel?.()) throw new MixdownCancelledError();
  };

  // Progress accounting: one step per clip on an audible track, one for the
  // master stage, one per mastering stage, one for metering.
  const audibleTracks = doc.tracks
    .map((track, trackIndex) => ({ track, trackIndex }))
    .filter(({ track }) => isTrackAudible(track, doc.tracks));
  const clipSteps = audibleTracks.reduce((sum, { track }) => sum + track.clips.length, 0);
  const chainActive = Boolean(
    includeMasterChain && masteringChainIsActive(chain) && deps?.mastering,
  );
  const masteringSteps = chainActive
    ? (chain?.preset !== undefined ? 1 : 0) +
      (chain?.processors.filter((slot) => slot.enabled).length ?? 0)
    : 0;
  const totalSteps = clipSteps + 1 + masteringSteps + 1;
  let doneSteps = 0;
  const progress = (stage: string) => {
    options.onProgress?.(doneSteps / totalSteps, stage);
    doneSteps += 1;
  };

  // Pass 1: render every audible clip into placement-ready buffers.
  const renderedTracks: RenderedTrack[] = [];
  let contentEndFrame = 0;
  for (const { track, trackIndex } of audibleTracks) {
    const strip = track.mixer;
    const stripGain = strip ? dbToLinear(strip.gainDb) : 1;
    const pan = clampPan(strip?.pan ?? 0);
    const rendered: RenderedTrack = { trackIndex, name: track.name, clips: [] };
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
      checkCancel();
      if (options.yieldBetweenClips) await options.yieldBetweenClips();
      const clip = track.clips[clipIndex];
      progress(`clip:${trackIndex}:${clipIndex}`);
      // Clips starting at or after the window end cannot contribute.
      if (range.endPpq !== null && clip.startPpq >= range.endPpq) continue;
      const isAudio = (clip.kind ?? 'midi') === 'audio';
      const renderedClip = isAudio
        ? await renderAudioClip(clip, track, strip, {
            tempoBpm,
            sampleRate,
            stripGain,
            pan,
            stripDsp,
            loadAudio,
          })
        : await renderMidiClip(clip, track, strip, {
            tempoBpm,
            sampleRate,
            stripGain,
            pan,
            basePeak,
            stripDsp,
            ...(options.loadFont !== undefined ? { loadFont: options.loadFont } : {}),
          });
      if (!renderedClip) continue;
      rendered.clips.push(renderedClip);
      const end = renderedClip.startFrame + (renderedClip.channels[0]?.length ?? 0);
      if (end > contentEndFrame) contentEndFrame = end;
    }
    renderedTracks.push(rendered);
  }

  // Resolve the render window in frames and sum the clips.
  const rangeStartFrame = ppqToFrames(range.startPpq, tempoBpm, sampleRate);
  const totalFrames =
    range.endPpq === null
      ? Math.max(0, contentEndFrame - rangeStartFrame)
      : Math.max(0, ppqToFrames(range.endPpq, tempoBpm, sampleRate) - rangeStartFrame);

  const makeBus = (): [Float32Array, Float32Array] => [
    new Float32Array(totalFrames),
    new Float32Array(totalFrames),
  ];
  const mixBus = makeBus();
  const stems: MixdownStem[] = [];
  for (const rendered of renderedTracks) {
    const trackBus = options.stems ? makeBus() : mixBus;
    for (const clip of rendered.clips) {
      mixInto(trackBus, clip.channels, clip.startFrame - rangeStartFrame, clip.gain);
    }
    if (options.stems) {
      stems.push({ trackIndex: rendered.trackIndex, name: rendered.name, channels: trackBus });
      mixInto(mixBus, trackBus, 0, 1);
    }
  }

  // Master stage: inserts/EQ (honest, on the summed bus), then gain and pan.
  checkCancel();
  progress('master.strip');
  let [left, right] = mixBus;
  if (includeMasterChain && stripDsp && stripHasDsp(master)) {
    [left, right] = applyStripDsp([left, right], sampleRate, master, stripDsp);
  }
  const masterGain = dbToLinear(master.gainDb);
  if (masterGain !== 1) {
    for (let i = 0; i < left.length; i++) left[i] *= masterGain;
    for (let i = 0; i < right.length; i++) right[i] *= masterGain;
  }
  [left, right] = applyBalancePan([left, right], master.pan) as [Float32Array, Float32Array];

  // Mastering chain: the preset (whole-chain application), then the enabled
  // processor slots, in order.
  if (chainActive && chain && deps?.mastering) {
    const mastering = deps.mastering;
    if (chain.preset !== undefined) {
      checkCancel();
      progress(`mastering.preset:${chain.preset}`);
      if (mastering.applyPreset) {
        const out = mastering.applyPreset(chain.preset, left, right, sampleRate);
        left = out.left;
        right = out.right;
      }
    }
    for (const slot of chain.processors) {
      if (!slot.enabled) continue;
      checkCancel();
      progress(`mastering.${slot.processor}`);
      const out = mastering.processStereo(slot.processor, left, right, sampleRate, slot.params);
      left = out.left;
      right = out.right;
    }
  }

  // Loudness/peak report.
  checkCancel();
  progress('metering');
  const peak = peakAmplitude([left, right]);
  const report: MixdownReport = {
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
  };
  const metering = deps?.metering ?? null;
  if (metering?.truePeakDb && totalFrames > 0) {
    try {
      report.truePeakDb = Math.max(
        metering.truePeakDb(left, sampleRate),
        metering.truePeakDb(right, sampleRate),
      );
    } catch {
      // True peak stays absent when the metering call fails.
    }
  }
  if (metering?.integratedLufs && totalFrames > 0) {
    try {
      const mono = new Float32Array(totalFrames);
      for (let i = 0; i < totalFrames; i++) mono[i] = 0.5 * (left[i] + right[i]);
      report.lufs = metering.integratedLufs(mono, sampleRate);
    } catch {
      // Loudness stays absent when the metering call fails.
    }
  }
  options.onProgress?.(1, 'done');

  const result: MixdownResult = {
    channels: [left, right],
    sampleRate,
    totalFrames,
    report,
  };
  if (options.stems) result.stems = stems;
  return result;
}
