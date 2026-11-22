/**
 * Shared types, constants and parameter-id helpers for the engine-backed
 * offline export renderer (see engine-render.ts).
 */

import type { EngineClip, EngineTrackSend, RealtimeEngine } from '@libraz/libsonare';
import { resolveAutomationId } from '@/engine/automation-ids';
import type { InsertTailResolver } from '@/export/audio-preflight';
import type { ClipPageBindingFactory } from '@/export/clip-page-stream';
import type { MasteringCapabilityLookup } from '@/export/mastering-automation';
import type { MixdownDeps, MixdownRange, MixdownRangePpq, MixdownStem } from '@/export/mixdown';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import type { InsertLatencyResolver } from '@/project/insert-latency';

/** Frames processed per offline block. */
export const RENDER_BLOCK_FRAMES = 1024;

/**
 * Returns a source of silent stereo input planes for `process()`. The engine
 * renders into its inputs, so the pair is re-zeroed on every call and only
 * reallocated when the block length changes; read the output before the next call.
 */
export function silentBlockInputs(): (frames: number) => [Float32Array, Float32Array] {
  let pair: [Float32Array, Float32Array] | null = null;
  return (frames) => {
    if (pair?.[0].length === frames) {
      pair[0].fill(0);
      pair[1].fill(0);
    } else {
      pair = [new Float32Array(frames), new Float32Array(frames)];
    }
    return pair;
  };
}

/** Blocks between progress/cancellation checkpoints (~0.7 s at 48 kHz). */
export const BLOCKS_PER_CHECKPOINT = 32;

/** Release tail appended after the last clip for 'project' renders, in seconds. */
export const RELEASE_TAIL_SECONDS = 2;

/** Longest release tail an engine-derived tail may request, in seconds (an unbounded tail lands here). */
export const MAX_RELEASE_TAIL_SECONDS = 120;

/**
 * Audible pre-roll rendered and discarded before the capture window, in
 * seconds. settleParameters snaps parameter smoothers, but stateful DSP
 * (dynamics envelopes, sidechain keys, reverb tails) only converges while
 * audio actually renders; without the pre-roll the first blocks of every
 * windowed render carry an audible transient (e.g. an unducked sidechain).
 */
export const PREROLL_SECONDS = 0.5;

/** Maximum stateful-DSP history rendered before a windowed export begins. */
export const MAX_PREROLL_SECONDS = 10;

/** Minimal, real-ABI-derived surface of RealtimeEngine used by the renderer. */
export type OfflineRenderEngine = Pick<
  RealtimeEngine,
  | 'setTrackLanes'
  | 'setTrackBuses'
  | 'setStrip'
  | 'setBusStrip'
  | 'setStripSidechain'
  | 'setBusSidechain'
  | 'setStripInsertBypassed'
  | 'setBusInsertBypassed'
  | 'setStripEqBand'
  | 'setBusEqBand'
  | 'setTrackSoloMute'
  | 'setStripPanLaw'
  | 'setStripPanMode'
  | 'setStripDualPan'
  | 'setStripChannelDelaySamples'
  | 'setParameter'
  | 'resolveStripAutomationId'
  | 'resolveBusAutomationId'
  | 'resolveStripInsertAutomationId'
  | 'resolveBusInsertAutomationId'
  | 'resolveInstrumentAutomationId'
  | 'setAutomationLane'
  | 'setTempoSegments'
  | 'setClips'
  | 'setWarpVoiceCapacity'
  | 'warpStretchOverflowCount'
  | 'setMidiClips'
  | 'pushMidiUmp'
  | 'setSynthInstrument'
  | 'loadSoundFont'
  | 'setSf2Instrument'
  | 'setMidiFx'
  | 'seekSample'
  | 'settleParameters'
  | 'play'
  | 'stop'
  | 'destroy'
> &
  Partial<Pick<RealtimeEngine, 'tailSamples' | 'pushMidiSysex'>> & {
    /** Renders one block in place; the monitor-bus form is not used offline. */
    process(channels: Parameters<RealtimeEngine['process']>[0]): Float32Array[];
  };

/** One engine track send (numeric engine bus id). */
export type SendSpec = EngineTrackSend;

/** One engine audio clip schedule (planar PCM at the render rate). */
export interface EngineClipSpec extends EngineClip {
  trackId: number;
  channels: Float32Array[];
  startPpq: number;
  lengthSamples: number;
  gain?: number;
}

/** Options for {@link renderProjectWithEngine}. */
export interface EngineRenderOptions {
  /** Output sample rate in Hz; defaults to the document sample rate. */
  sampleRate?: number;
  /** Render range (default 'project'). */
  range?: MixdownRange;
  /** Release tail appended after the final clip for project-range renders (default 2 seconds). */
  releaseTailSeconds?: number;
  /**
   * Derive the release tail from the configured engine's reported tail (capped
   * at {@link MAX_RELEASE_TAIL_SECONDS}) instead of `releaseTailSeconds`, which
   * still applies when the engine cannot report one.
   */
  releaseTailFromEngine?: boolean;
  /** Also append the release tail to an explicit PPQ range (used by bounce-in-place). */
  appendReleaseTailForExplicitRange?: boolean;
  /** Loop window used when range is 'loop'. */
  loopRegion?: MixdownRangePpq;
  /**
   * True (default) applies the master strip (inserts/EQ) and the project
   * mastering chain. False renders the raw engine mix (master gain/pan still
   * apply, as they are audible in live playback).
   */
  includeMasterChain?: boolean;
  /**
   * True returns pre-master stems for exclusive source domains: standalone
   * tracks plus group submixes (not both a group and each of its members).
   */
  stems?: boolean;
  /**
   * When stems are enabled, render one pre-master return/output-bus stem per
   * mixer bus. Its routed sources and sends are omitted from track/group stems
   * so the complete stem set can be re-summed before master processing.
   */
  busStems?: boolean;
  /** When stems are enabled, also include the final stereo master as a stem. */
  masterStem?: boolean;
  /**
   * Optional sequential stem consumer. Each callback is awaited before the
   * next full-length stem is rendered, and consumed stems are not retained in
   * the returned result.
   */
  onStem?: (stem: MixdownStem, index: number, total: number) => Promise<void> | void;
  /**
   * Sequential mixdown PCM consumer. When eligible (no full-buffer mastering
   * stage or stems), the engine invokes this once per render block and does
   * not retain the complete master PCM result.
   */
  onMixdownChunk?: (
    channels: readonly [Float32Array, Float32Array],
    offsetFrames: number,
    totalFrames: number,
  ) => Promise<void> | void;
  /** Maximum retained full-length audio payload before allocation. */
  memoryBudgetBytes?: number;
  /**
   * Renders ONE track's pre-fader signal in isolation (freeze/bounce-in-
   * place): every other lane is muted, the track's sends, fader/pan and
   * fader/pan automation are excluded (they stay live on the frozen track)
   * and master strip/levels are skipped. The result is the mixdown channels.
   */
  freezeTrackIndex?: number;
  /** Mastering/metering seams; undefined derives them from the wasm module. */
  deps?: Pick<MixdownDeps, 'mastering' | 'metering'> | null;
  /** Audio asset loader (defaults to the OPFS asset store's loadAsset). */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  /** Metadata-only loader used for allocation-free memory preflight. */
  loadAudioAssetMeta?: (assetId: string) => Promise<AudioAssetMeta>;
  /**
   * Page-provider factory. Supplying one lets clips whose stored asset already
   * holds exactly the frames they play be read page by page instead of decoded,
   * so the render's peak payload stops growing with the project's total PCM.
   * Omitted (the default), every clip is decoded as before.
   */
  createClipPageStream?: ClipPageBindingFactory;
  /** PCM the paged clips may keep resident across the whole render. */
  clipStreamResidentBudgetBytes?: number;
  /** SoundFont loader for 'sf2' instruments (defaults to the OPFS font store). */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Synth preset name resolver (defaults to identity). */
  resolvePreset?: (preset: string) => string;
  /**
   * Offline-quality planar resampling seam. Defaults to libsonare WASM's
   * band-limited resampler and is intentionally separate from live playback's
   * lightweight linear conversion.
   */
  resampleAudio?: (samples: Float32Array, sourceRate: number, targetRate: number) => Float32Array;
  /** Optional processor-latency resolver used for automatic track PDC. */
  insertLatency?: InsertLatencyResolver;
  /** Optional insert tail resolver used to size the stateful-DSP pre-roll. */
  insertTail?: InsertTailResolver;
  /**
   * Mastering processor capability lookup deciding which automated rack stages
   * can run as engine strip inserts. Defaults to the wasm processor catalog;
   * a lookup that knows nothing keeps the whole rack on its whole-buffer path.
   */
  masteringCapability?: MasteringCapabilityLookup;
  /** Progress callback: fraction in [0, 1] plus the stage being entered. */
  onProgress?: (progress: number, stage: string) => void;
  /** Cancellation flag, checked between render checkpoints. */
  shouldCancel?: () => boolean;
  /** Awaited between checkpoints so worker cancel messages are processed. */
  yieldBetweenBlocks?: () => Promise<void>;
  /** Engine factory override (tests); defaults to the wasm RealtimeEngine. */
  createEngine?: (sampleRate: number, blockSize: number) => OfflineRenderEngine;
}

/** What one engine pass renders. */
export interface RenderPass {
  /** Apply the master strip scene (inserts/EQ). */
  masterStrip: boolean;
  /** Apply master gain/pan and master automation lanes. */
  masterLevels: boolean;
  /**
   * Non-null isolates these track indices (every other lane muted). A plain
   * track stem holds just its own index; a group stem holds the group and
   * its member indices so the submix renders through the group bus.
   */
  stemIndices: ReadonlySet<number> | null;
  /**
   * Routing policy for an isolated track stem. `direct` removes the selected
   * lane's output-bus assignment; `group` preserves member-to-group routing
   * while optionally stripping sends when return stems are rendered.
   */
  stemRouting: 'document' | 'direct' | 'group';
  /** True when return-bus stems carry all send/output-bus contributions. */
  separateReturnStems: boolean;
  /**
   * Non-null renders only this engine bus/return: source lanes keep their
   * document mute/solo state, sends/output routing to the selected bus stay
   * live, and all other direct outputs are discarded before master.
   */
  busStemId: number | null;
  /**
   * Non-null renders this track pre-fader (freeze): its sends are stripped,
   * its base fader/pan stay neutral and its fader/pan automation is skipped.
   */
  freezeIndex: number | null;
  /**
   * Null binds every active SF2 track (valid when they share one font). A set
   * binds only those track indices, keeping the engine's global font slot
   * fixed for an isolated pre-fader bounce; an empty set binds none because
   * the SF2 tracks are supplied by pre-rendered audio clips in this pass.
   */
  sf2TrackIndices: ReadonlySet<number> | null;
  /** Use pre-rendered SF2 audio clips and bypass their already-baked strip DSP. */
  usePreRenderedSf2: boolean;
}

/** Resolves the render window in PPQ; endPpq null = up to the content end. */
export function resolveRange(options: EngineRenderOptions): {
  startPpq: number;
  endPpq: number | null;
} {
  const range = options.range ?? 'project';
  if (range === 'project') return { startPpq: 0, endPpq: null };
  const window = range === 'loop' ? options.loopRegion : range;
  if (range === 'loop' && !window) {
    throw new RangeError("Render range 'loop' requires options.loopRegion");
  }
  const { startPpq, endPpq } = window as MixdownRangePpq;
  if (!Number.isFinite(startPpq) || startPpq < 0 || !Number.isFinite(endPpq)) {
    throw new RangeError('Render range PPQ values must be finite and >= 0');
  }
  if (endPpq <= startPpq) {
    throw new RangeError(`Render range end (${endPpq}) must be after its start (${startPpq})`);
  }
  return { startPpq, endPpq };
}

/**
 * Engine parameter id of a track's lane fader or pan. The id names the track,
 * so it is resolved after setTrackLanes declared the track.
 *
 * @throws Error when the engine has no lane for the track.
 */
export function trackLaneParamId(
  engine: Pick<OfflineRenderEngine, 'resolveStripAutomationId'>,
  trackId: number,
  param: 'faderDb' | 'pan',
): number {
  const id = resolveAutomationId(() => engine.resolveStripAutomationId(trackId, param));
  if (id === undefined) throw new Error(`Engine has no lane for track ${trackId}`);
  return id;
}

/**
 * Engine parameter id of the master fader or pan.
 *
 * @throws Error when the engine does not resolve the parameter.
 */
export function masterParamId(
  engine: Pick<OfflineRenderEngine, 'resolveStripAutomationId'>,
  param: 'faderDb' | 'pan',
): number {
  const id = resolveAutomationId(() => engine.resolveStripAutomationId('master', param));
  if (id === undefined) throw new Error(`Engine has no master ${param} parameter`);
  return id;
}

/**
 * Engine parameter id of a bus fader. The id names the bus, so it is resolved
 * after setTrackBuses declared the bus.
 *
 * @throws Error when the engine has no such bus.
 */
export function busFaderParamId(
  engine: Pick<OfflineRenderEngine, 'resolveBusAutomationId'>,
  busId: number,
): number {
  const id = resolveAutomationId(() => engine.resolveBusAutomationId(busId, 'faderDb'));
  if (id === undefined) throw new Error(`Engine has no bus ${busId}`);
  return id;
}
