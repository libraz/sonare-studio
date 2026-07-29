/**
 * Shared types, constants and parameter-id helpers for the engine-backed
 * offline export renderer (see engine-render.ts). The reserved engine mixer
 * parameter namespace mirrors the facade encoding the live sync layers use.
 */

import type { MixdownDeps, MixdownRange, MixdownRangePpq, MixdownStem } from '@/export/mixdown';
import type { AudioAssetMeta, LoadedAudioAsset } from '@/persistence/assets';
import type { InsertLatencyResolver } from '@/project/insert-latency';
import type { EngineClip, EngineTrackSend, RealtimeEngine } from '@/wasm/index.js';

/** Reserved engine mixer parameter namespace (mirrors the facade encoding). */
export const ENGINE_MIXER_TARGET_BASE = 0x4d580000;
/** Lane byte addressing the master strip in the reserved namespace. */
export const ENGINE_MIXER_LANE_MASTER = 0xff;
/** Parameter kind: lane/master fader gain in dB. */
export const ENGINE_MIXER_PARAM_FADER_DB = 1;
/** Parameter kind: lane/master stereo pan in [-1, 1]. */
export const ENGINE_MIXER_PARAM_PAN = 2;

/** Frames processed per offline block. */
export const RENDER_BLOCK_FRAMES = 1024;

/** Blocks between progress/cancellation checkpoints (~0.7 s at 48 kHz). */
export const BLOCKS_PER_CHECKPOINT = 32;

/** Release tail appended after the last clip for 'project' renders, in seconds. */
export const RELEASE_TAIL_SECONDS = 2;

/**
 * Audible pre-roll rendered and discarded before the capture window, in
 * seconds. settleParameters snaps parameter smoothers, but stateful DSP
 * (dynamics envelopes, sidechain keys, reverb tails) only converges while
 * audio actually renders; without the pre-roll the first blocks of every
 * windowed render carry an audible transient (e.g. an unducked sidechain).
 */
export const PREROLL_SECONDS = 0.5;

/** Tempo assumed when the document carries no tempo segment. */
export const DEFAULT_TEMPO_BPM = 120;

/** Minimal, real-ABI-derived surface of RealtimeEngine used by the renderer. */
export type OfflineRenderEngine = Pick<
  RealtimeEngine,
  | 'setTrackLanes'
  | 'setTrackBuses'
  | 'setTrackStripJson'
  | 'setBusStripJson'
  | 'setMasterStripJson'
  | 'setLaneSidechain'
  | 'setTrackStripInsertBypassed'
  | 'setMasterStripInsertBypassed'
  | 'setTrackStripEqBandJson'
  | 'setMasterStripEqBandJson'
  | 'setSoloMute'
  | 'setTrackStripPanLaw'
  | 'setTrackStripPanMode'
  | 'setTrackStripDualPan'
  | 'setTrackStripChannelDelaySamples'
  | 'setParameter'
  | 'resolveTrackInsertAutomationId'
  | 'resolveMasterInsertAutomationId'
  | 'resolveBusInsertAutomationId'
  | 'setAutomationLane'
  | 'setTempoSegments'
  | 'setClips'
  | 'setMidiClips'
  | 'setSynthInstrument'
  | 'loadSoundFont'
  | 'setSf2Instrument'
  | 'setMidiFx'
  | 'seekSample'
  | 'settleParameters'
  | 'play'
  | 'stop'
  | 'process'
  | 'destroy'
> & {
  /** Future ABI: per-bus insert bypass matching track/master strips. */
  setBusStripInsertBypassed?: (
    busId: number,
    insertIndex: number,
    bypassed: boolean,
    resetOnBypass?: boolean,
  ) => void;
  /** Future ABI: per-bus EQ band setter. Current engines may omit it. */
  setBusStripEqBandJson?: (busId: number, bandIndex: number, json: string) => void;
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
  /** Loop window used when range is 'loop'. */
  loopRegion?: MixdownRangePpq;
  /**
   * True (default) applies the master strip (inserts/EQ) and the project
   * mastering chain. False renders the raw engine mix (master gain/pan still
   * apply, as they are audible in live playback).
   */
  includeMasterChain?: boolean;
  /** True also returns one stereo stem per track (post-strip, pre-master). */
  stems?: boolean;
  /** When stems are enabled, also render one pre-master stem per mixer bus/return. */
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
  /** SoundFont loader for 'sf2' instruments (defaults to the OPFS font store). */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Synth preset name resolver (defaults to identity). */
  resolvePreset?: (preset: string) => string;
  /** Optional processor-latency resolver used for automatic track PDC. */
  insertLatency?: InsertLatencyResolver;
  /**
   * Realtime-insertable mastering processor ids. Normally derived from the
   * wasm catalog; injectable for alternate engine hosts and tests.
   */
  realtimeMasteringInsertCatalog?: ReadonlySet<string>;
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

/** Reserved engine parameter id for one lane parameter. */
export function laneParamId(laneIndex: number, kind: number): number {
  return ENGINE_MIXER_TARGET_BASE | ((laneIndex & 0xff) << 8) | (kind & 0xff);
}

/** Reserved engine parameter id for one master strip parameter. */
export function masterParamId(kind: number): number {
  return ENGINE_MIXER_TARGET_BASE | (ENGINE_MIXER_LANE_MASTER << 8) | (kind & 0xff);
}

/** Packed mixer parameter id for a bus fader lane (mirrors the live facade). */
export function busParamId(busId: number, kind = ENGINE_MIXER_PARAM_FADER_DB): number {
  return ENGINE_MIXER_TARGET_BASE | (((254 - busId) & 0xff) << 8) | (kind & 0xff);
}
