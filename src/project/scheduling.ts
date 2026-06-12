/**
 * Project-wide playback scheduling: prerenders and schedules every audible
 * MIDI clip and loads/schedules every audible audio clip of every track into
 * the engine. The single-implicit-track flow (scheduleMidiClip with one clip)
 * remains the degenerate case.
 *
 * Nothing here produces sound by itself: engine.addClip only places content
 * on the engine timeline, which stays silent until the transport plays.
 */

import type { EngineHandle } from '@/engine/engine';
import {
  type MidiNote,
  midiClipCacheKey,
  type PrerenderMidiClipOptions,
  type ScheduleMidiClipOptions,
  scheduleMidiClip,
} from '@/engine/instruments';
import { ensureWasm } from '@/lib/wasm';
import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { clampPan, dbToLinear, type MixerStrip, stripCacheSegment, stripHasDsp } from './mixer';
import {
  applyBalancePan,
  applyStripDsp,
  copyChannels,
  type StripEqualizer,
  type StripProcessorDeps,
} from './mixer-dsp';
import { useProjectStore } from './store';
import type { EditorClip, EditorNote, EditorTrack } from './types';
import { clipKind } from './types';

/**
 * Default peak level scheduled MIDI clips are normalized to (-6 dBFS),
 * matching the scheduleMidiClip default. Audio clips are never normalized.
 */
export const DEFAULT_TARGET_PEAK = 0.5;

/** The mute/solo subset of a track relevant to audibility. */
export type TrackAudibilityState = Pick<EditorTrack, 'mute' | 'solo'>;

/**
 * Decides whether a track is audible under the solo/mute rules: when any
 * track is soloed only soloed tracks play, and mute always silences a track
 * (mute wins over its own solo).
 *
 * @param track Track to test.
 * @param tracks All tracks of the project (to detect active solos).
 * @returns True when the track's clips should be scheduled.
 */
export function isTrackAudible(
  track: TrackAudibilityState,
  tracks: ReadonlyArray<TrackAudibilityState>,
): boolean {
  if (track.mute) return false;
  const anySolo = tracks.some((t) => t.solo);
  return anySolo ? track.solo : true;
}

/**
 * The note-window subset of a clip needed to derive its playback notes:
 * satisfied by editor mirror clips and by document clips alike.
 */
export interface ClipNoteWindow {
  /** Offset of the clip window into its source, in PPQ. */
  sourceOffsetPpq: number;
  /** Clip window length in PPQ. */
  lengthPpq: number;
  /** Source-relative note content. */
  notes: ReadonlyArray<Omit<EditorNote, 'id'>>;
}

/**
 * Extracts a clip's audible notes in clip-local PPQ: notes are stored in
 * source coordinates, so the clip window [sourceOffsetPpq, sourceOffsetPpq +
 * lengthPpq) is selected (by note start) and shifted to start at 0.
 *
 * @param clip Clip mirror or document entry.
 * @returns Engine-facing notes relative to the clip start.
 */
export function clipPlaybackNotes(clip: ClipNoteWindow): MidiNote[] {
  const windowEnd = clip.sourceOffsetPpq + clip.lengthPpq;
  return clip.notes
    .filter((note) => note.startPpq >= clip.sourceOffsetPpq && note.startPpq < windowEnd)
    .map((note) => ({
      note: note.pitch,
      velocity: note.velocity,
      startPpq: note.startPpq - clip.sourceOffsetPpq,
      durationPpq: note.durationPpq,
      channel: note.channel,
    }));
}

/**
 * Converts a PPQ span to seconds at a constant tempo.
 *
 * @param ppq Span in quarter-note PPQ.
 * @param tempoBpm Tempo in BPM (> 0).
 * @returns Span in seconds.
 */
export function ppqToSeconds(ppq: number, tempoBpm: number): number {
  return (ppq * 60) / tempoBpm;
}

/**
 * Cuts an audio clip's source window out of the asset buffers: the window
 * [sourceOffsetPpq, sourceOffsetPpq + lengthPpq) is converted to frames at
 * the asset sample rate (constant tempo) and sliced per channel, clamped to
 * the available frames. The returned buffers are fresh copies.
 *
 * @param channels Planar asset channel buffers.
 * @param sampleRate Asset sample rate in Hz.
 * @param sourceOffsetPpq Offset of the clip window into the source, in PPQ.
 * @param lengthPpq Clip window length in PPQ.
 * @param tempoBpm Tempo used to convert PPQ to time.
 * @returns One sliced copy per channel (possibly zero-length).
 */
export function sliceAudioClipWindow(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  sourceOffsetPpq: number,
  lengthPpq: number,
  tempoBpm: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  const start = Math.min(
    frames,
    Math.max(0, Math.round(ppqToSeconds(sourceOffsetPpq, tempoBpm) * sampleRate)),
  );
  const count = Math.max(0, Math.round(ppqToSeconds(lengthPpq, tempoBpm) * sampleRate));
  const end = Math.min(frames, start + count);
  return channels.map((channel) => channel.slice(start, end));
}

/**
 * Applies linear fade-in/fade-out ramps to the buffer edges in place.
 *
 * The engine clip options for fades are not part of the typed API, so fades
 * are baked into the scheduled buffer instead: the first fade-in frame is
 * silent and the ramp reaches unity right after the fade (multiplier i/n for
 * frame i of n); the fade-out mirrors that (the last frame is silent). Fades
 * longer than the buffer are clamped to its length.
 *
 * @param channels Planar buffers to modify (typically fresh slices).
 * @param sampleRate Buffer sample rate in Hz.
 * @param tempoBpm Tempo used to convert fade PPQ to time.
 * @param fadeInPpq Fade-in length in PPQ (0 = none).
 * @param fadeOutPpq Fade-out length in PPQ (0 = none).
 * @returns The same channel array, for chaining.
 */
export function applyAudioClipFades(
  channels: Float32Array[],
  sampleRate: number,
  tempoBpm: number,
  fadeInPpq: number,
  fadeOutPpq: number,
): Float32Array[] {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0) return channels;
  const inFrames = Math.min(
    frames,
    Math.max(0, Math.round(ppqToSeconds(fadeInPpq, tempoBpm) * sampleRate)),
  );
  const outFrames = Math.min(
    frames,
    Math.max(0, Math.round(ppqToSeconds(fadeOutPpq, tempoBpm) * sampleRate)),
  );
  for (const channel of channels) {
    for (let i = 0; i < inFrames; i++) {
      channel[i] *= i / inFrames;
    }
    for (let i = 0; i < outFrames; i++) {
      channel[frames - 1 - i] *= i / outFrames;
    }
  }
  return channels;
}

/**
 * Linearly resamples planar buffers to a new sample rate (endpoint-preserving
 * interpolation). Adequate for playback-rate matching; offline DSP-grade
 * resampling is out of scope here.
 *
 * @param channels Planar buffers at `sourceRate`.
 * @param sourceRate Source sample rate in Hz (> 0).
 * @param targetRate Target sample rate in Hz (> 0).
 * @returns New planar buffers at `targetRate` (the input when rates match).
 */
export function resampleChannelsLinear(
  channels: Float32Array[],
  sourceRate: number,
  targetRate: number,
): Float32Array[] {
  if (sourceRate === targetRate) return channels;
  if (
    !Number.isFinite(sourceRate) ||
    sourceRate <= 0 ||
    !Number.isFinite(targetRate) ||
    targetRate <= 0
  ) {
    throw new RangeError(`Sample rates must be finite and > 0, got ${sourceRate} -> ${targetRate}`);
  }
  return channels.map((channel) => {
    const frames = channel.length;
    if (frames === 0) return new Float32Array(0);
    const outFrames = Math.max(1, Math.round((frames * targetRate) / sourceRate));
    const out = new Float32Array(outFrames);
    if (outFrames === 1 || frames === 1) {
      out.fill(channel[0]);
      return out;
    }
    const step = (frames - 1) / (outFrames - 1);
    for (let i = 0; i < outFrames; i++) {
      const pos = i * step;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const next = Math.min(frames - 1, idx + 1);
      out[i] = channel[idx] + (channel[next] - channel[idx]) * frac;
    }
    return out;
  });
}

/**
 * Strip-processed buffers keyed by render identity + strip identity, so
 * re-scheduling an unchanged project re-runs no insert/EQ DSP. Pan and gain
 * are excluded from the cache (applied per schedule).
 */
const processedRenderCache = new Map<string, Float32Array[]>();

/** Clears the strip-processed buffer cache (tests, memory pressure). */
export function clearStripProcessingCache(): void {
  processedRenderCache.clear();
}

/**
 * Builds the strip DSP seam from the loaded wasm module. Returns null when
 * the module exposes no one-shot stereo processor (older builds, minimal test
 * mocks); strips then degrade to gain/pan only. Shared with the offline
 * mixdown renderer (src/export/mixdown.ts).
 */
export async function defaultStripDsp(): Promise<StripProcessorDeps | null> {
  const wasm = (await ensureWasm()) as unknown as {
    masteringProcessStereo?: (
      name: never,
      left: Float32Array,
      right: Float32Array,
      sampleRate?: number,
      params?: Record<string, number | boolean>,
    ) => { left: Float32Array; right: Float32Array };
    StreamingEqualizer?: new (config: {
      sampleRate: number;
      maxBlockSize: number;
    }) => StripEqualizer;
  };
  const processStereo = wasm.masteringProcessStereo;
  if (typeof processStereo !== 'function') return null;
  const deps: StripProcessorDeps = {
    processStereo: (name, left, right, sampleRate, params) => {
      const out = processStereo(name as never, left, right, sampleRate, params);
      return { left: out.left, right: out.right };
    },
  };
  const Equalizer = wasm.StreamingEqualizer;
  if (typeof Equalizer === 'function') {
    deps.createEqualizer = (config) => new Equalizer(config);
  }
  return deps;
}

/**
 * Deterministic processed-buffer cache key for an audio clip render: covers
 * everything that shapes the buffer fed to the strip processor (asset, source
 * window, tempo, fades and target sample rate). Shared by live scheduling and
 * the offline mixdown renderer so both reuse the same processed buffers.
 */
export function audioClipProcessingCacheKey(
  clip: Pick<EditorClip, 'assetId' | 'sourceOffsetPpq' | 'lengthPpq' | 'fadeInPpq' | 'fadeOutPpq'>,
  tempoBpm: number,
  sampleRate: number,
): string {
  return (
    `audio|${clip.assetId}|off=${clip.sourceOffsetPpq}|len=${clip.lengthPpq}` +
    `|bpm=${tempoBpm}|fi=${clip.fadeInPpq ?? 0}|fo=${clip.fadeOutPpq ?? 0}|sr=${sampleRate}`
  );
}

/**
 * Returns a hook that applies a strip's insert/EQ chain (cached by render +
 * strip identity) and bakes the combined pan into a fresh copy. Shared with
 * the offline mixdown renderer (src/export/mixdown.ts).
 */
export function makeStripProcessor(
  cacheKey: string,
  sampleRate: number,
  strip: MixerStrip | undefined,
  deps: StripProcessorDeps | null,
  pan: number,
): (channels: Float32Array[]) => Float32Array[] {
  return (channels) => {
    let out = channels;
    if (strip && deps && stripHasDsp(strip)) {
      const key = `${cacheKey}|strip=${stripCacheSegment(strip)}`;
      const cached = processedRenderCache.get(key);
      if (cached) {
        out = cached;
      } else {
        out = applyStripDsp(out, sampleRate, strip, deps);
        processedRenderCache.set(key, out);
      }
    }
    // Pan always works on a copy: the cached buffers stay pan-free so one
    // processed render serves every pan position.
    if (pan !== 0) out = applyBalancePan(copyChannels(out), pan);
    return out;
  };
}

/** One clip scheduled by {@link scheduleProjectClips}. */
export interface ScheduledProjectClip {
  /** Engine clip id (pass to engine.removeClip to unschedule). */
  engineClipId: number;
  /** Project clip id the render came from. */
  clipId: number;
  /** Project track id the clip belongs to. */
  trackId: number;
}

/** Options for {@link scheduleProjectClips}. */
export interface ScheduleProjectClipsOptions {
  /** Render sample rate; defaults to the engine context rate. */
  sampleRate?: number;
  /** Tempo used for the bounce; defaults to the store's tempo. */
  tempoBpm?: number;
  /** NativeSynth preset name; defaults to the scheduleMidiClip default. */
  preset?: string;
  /**
   * Base peak level per MIDI clip before track volume and clip gain are
   * applied (default 0.5 = -6 dBFS). Pass null to schedule at the rendered
   * level; track volume and clip gain are then NOT applied (the engine has no
   * separate track-gain control for prerendered clips). Audio clips ignore
   * this option entirely: they always play at their native level times
   * (clip gain x track volume).
   */
  targetPeak?: number | null;
  /**
   * Audio asset loader (defaults to the OPFS asset store's loadAsset).
   * Injectable for tests and alternative storage backends.
   */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /**
   * Strip DSP seam: undefined derives the processors from the wasm module
   * (only when some audible track actually carries insert/EQ DSP), null
   * disables strip DSP entirely (gain/pan still apply). Injectable for tests.
   */
  stripDsp?: StripProcessorDeps | null;
}

/**
 * Schedules every audible clip of every track into the engine.
 *
 * Audibility follows {@link isTrackAudible} (solo-any => only solo tracks,
 * mute => skip).
 *
 * MIDI clips are prerendered and normalized: track volume and clip gain are
 * folded into the per-clip normalization target (the engine exposes only
 * per-clip gain for prerendered audio), so volume 0.5 plays the clip 6 dB
 * below the base peak. Empty clips and fully attenuated clips are skipped.
 *
 * Audio clips load their asset from the asset store, slice the source window
 * (sourceOffsetPpq/lengthPpq at the schedule tempo), bake fades into the
 * buffer edges, resample to the engine rate when needed, and are scheduled
 * with gain = clip gain x track volume — never loudness-normalized. Clips
 * whose asset is missing or unreadable are skipped silently.
 *
 * Mixer state is applied offline (the engine node has no channel-strip
 * surface): a track's instrument selects the MIDI bounce, strip gain (and the
 * master strip gain) multiplies the engine per-clip gain, strip pan plus
 * master pan are baked into the buffers as a balance law, and the track
 * strip's enabled inserts/EQ run over the buffers through the wasm one-shot
 * processors (results cached by render + strip identity). Master inserts/EQ,
 * buses and sends are UI-only in this iteration.
 *
 * The legacy track.pan field and clip looping are not applied (no engine
 * support for prerendered clips).
 *
 * The caller owns unscheduling: keep the returned list and call
 * engine.removeClip(engineClipId) for each entry before re-scheduling.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional render/level overrides.
 * @returns One entry per scheduled clip.
 */
export async function scheduleProjectClips(
  handle: EngineHandle,
  options: ScheduleProjectClipsOptions = {},
): Promise<ScheduledProjectClip[]> {
  const store = useProjectStore();
  const tempoBpm = options.tempoBpm ?? store.tempoBpm;
  const basePeak = options.targetPeak === undefined ? DEFAULT_TARGET_PEAK : options.targetPeak;
  const loadAudio = options.loadAudioAsset ?? loadAsset;
  const master = store.mixer.master;
  const masterGain = dbToLinear(master.gainDb);
  // Resolve the wasm DSP seam only when an audible track actually needs it,
  // so DSP-less projects never touch the processor module.
  const anyStripDsp = store.tracks.some(
    (track) => isTrackAudible(track, store.tracks) && stripHasDsp(track.mixer),
  );
  const dsp =
    options.stripDsp !== undefined
      ? options.stripDsp
      : anyStripDsp
        ? await defaultStripDsp()
        : null;
  const scheduled: ScheduledProjectClip[] = [];
  for (const track of store.tracks) {
    if (!isTrackAudible(track, store.tracks)) continue;
    const strip = track.mixer;
    const stripGain = strip ? dbToLinear(strip.gainDb) : 1;
    const extraGain = stripGain * masterGain;
    const pan = clampPan((strip?.pan ?? 0) + master.pan);
    const hasDsp = stripHasDsp(strip) && dsp !== null;
    const clips = store.clips.filter((clip) => clip.trackId === track.id);
    for (const clip of clips) {
      if (clipKind(clip) === 'audio') {
        if (!clip.assetId) continue;
        const gain = track.volume * clip.gain * extraGain;
        if (gain <= 0) continue;
        let asset: LoadedAudioAsset;
        try {
          asset = await loadAudio(clip.assetId);
        } catch {
          // Missing or unreadable asset: leave the clip silent.
          continue;
        }
        let channels = sliceAudioClipWindow(
          asset.channels,
          asset.meta.sampleRate,
          clip.sourceOffsetPpq,
          clip.lengthPpq,
          tempoBpm,
        );
        channels = applyAudioClipFades(
          channels,
          asset.meta.sampleRate,
          tempoBpm,
          clip.fadeInPpq ?? 0,
          clip.fadeOutPpq ?? 0,
        );
        const targetRate = options.sampleRate ?? handle.ctx.sampleRate;
        channels = resampleChannelsLinear(channels, asset.meta.sampleRate, targetRate);
        if (channels.length === 0 || channels[0].length === 0) continue;
        if (hasDsp || pan !== 0) {
          const cacheKey = audioClipProcessingCacheKey(clip, tempoBpm, targetRate);
          channels = makeStripProcessor(cacheKey, targetRate, strip, dsp, pan)(channels);
        }
        const engineClipId = handle.engine.addClip(track.id, channels, clip.startPpq, { gain });
        scheduled.push({ engineClipId, clipId: clip.id, trackId: track.id });
        continue;
      }
      const notes = clipPlaybackNotes(clip);
      if (notes.length === 0) continue;
      const targetPeak = basePeak === null ? null : basePeak * track.volume * clip.gain;
      if (targetPeak !== null && targetPeak <= 0) continue;
      const midiOptions: ScheduleMidiClipOptions = {
        ...(options.sampleRate !== undefined ? { sampleRate: options.sampleRate } : {}),
        ...(options.preset !== undefined ? { preset: options.preset } : {}),
        ...(track.instrument !== undefined ? { instrument: track.instrument } : {}),
        tempoBpm,
        targetPeak,
      };
      if (extraGain !== 1) midiOptions.extraGain = extraGain;
      if (hasDsp || pan !== 0) {
        const renderRate = options.sampleRate ?? handle.ctx.sampleRate;
        const renderOptions: PrerenderMidiClipOptions = {
          sampleRate: renderRate,
          tempoBpm,
          ...(options.preset !== undefined ? { preset: options.preset } : {}),
          ...(track.instrument !== undefined ? { instrument: track.instrument } : {}),
        };
        midiOptions.processChannels = makeStripProcessor(
          midiClipCacheKey(notes, renderOptions),
          renderRate,
          strip,
          dsp,
          pan,
        );
      }
      const engineClipId = await scheduleMidiClip(
        handle,
        track.id,
        notes,
        clip.startPpq,
        midiOptions,
      );
      scheduled.push({ engineClipId, clipId: clip.id, trackId: track.id });
    }
  }
  return scheduled;
}
