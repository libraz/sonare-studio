/**
 * Shared types, constants and parameter-id helpers for the engine-backed
 * offline export renderer (see engine-render.ts). The reserved engine mixer
 * parameter namespace mirrors the facade encoding the live sync layers use.
 */

import type { MixdownDeps, MixdownRange, MixdownRangePpq } from '@/export/mixdown';
import type { LoadedAudioAsset } from '@/persistence/assets';
import type { PanLawId, PanModeId } from '@/project/mixer';

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

/**
 * Minimal surface of the wasm RealtimeEngine used by the renderer. Kept
 * structural so tests can inject a fake engine.
 */
export interface OfflineRenderEngine {
  setTrackLanes(lanes: Array<{ trackId: number; sends?: SendSpec[]; outputBusId?: number }>): void;
  setTrackBuses(buses: Array<{ busId: number; gainDb?: number }>): void;
  setTrackStripJson(trackId: number, sceneJson: string): void;
  setBusStripJson(busId: number, sceneJson: string): void;
  setMasterStripJson(sceneJson: string): void;
  setLaneSidechain(trackId: number, insertIndex: number, sourceTrackId: number): void;
  setTrackStripInsertBypassed(trackId: number, insertIndex: number, bypassed: boolean): void;
  setMasterStripInsertBypassed(insertIndex: number, bypassed: boolean): void;
  setTrackStripEqBandJson(trackId: number, bandIndex: number, bandJson: string): void;
  setMasterStripEqBandJson(bandIndex: number, bandJson: string): void;
  setSoloMute(laneIndex: number, solo: boolean, mute: boolean): void;
  setTrackStripPanLaw(trackId: number, panLaw: PanLawId | number): void;
  setTrackStripPanMode(trackId: number, panMode: PanModeId | number): void;
  setTrackStripDualPan(trackId: number, leftPan: number, rightPan: number): void;
  setTrackStripChannelDelaySamples(trackId: number, delaySamples: number): void;
  setParameter(paramId: number, value: number): void;
  busAutomationParamId(busId: number): number;
  resolveTrackInsertAutomationId(trackId: number, insertIndex: number, paramName: string): number;
  resolveMasterInsertAutomationId(insertIndex: number, paramName: string): number;
  resolveBusInsertAutomationId(busId: number, insertIndex: number, paramName: string): number;
  setAutomationLane(
    paramId: number,
    points: Array<{ ppq: number; value: number; curveToNext?: number }>,
  ): void;
  setTempoSegments(
    segments: ReadonlyArray<{ startPpq: number; bpm: number; endBpm?: number }>,
  ): void;
  setClips(clips: EngineClipSpec[]): void;
  setMidiClips(clips: ReadonlyArray<unknown>): void;
  setSynthInstrument(patch?: object | string, destinationId?: number): void;
  loadSoundFont(data: Uint8Array): void;
  setSf2Instrument(config?: object, destinationId?: number): void;
  setMidiFx(destinationId: number, configJson: string): void;
  seekSample(timelineSample: number): void;
  settleParameters(): void;
  play(): void;
  stop(): void;
  process(channels: Float32Array[]): Float32Array[];
  destroy(): void;
}

/** One engine track send (numeric engine bus id). */
export interface SendSpec {
  busId: number;
  levelDb?: number;
  enabled?: boolean;
  /** Pre/post-fader tap; absent = post-fader (the engine default). */
  sendTiming?: 'preFader';
}

/** One engine audio clip schedule (planar PCM at the render rate). */
export interface EngineClipSpec {
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
  /** SoundFont loader for 'sf2' instruments (defaults to the OPFS font store). */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Synth preset name resolver (defaults to identity). */
  resolvePreset?: (preset: string) => string;
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
   * Non-null renders this track pre-fader (freeze): its sends are stripped,
   * its base fader/pan stay neutral and its fader/pan automation is skipped.
   */
  freezeIndex: number | null;
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
