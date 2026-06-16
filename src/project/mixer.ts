/**
 * Mixer model: per-track channel strips, a master strip and optional send
 * buses.
 *
 * The state is app-level metadata persisted by the project document (schema
 * version 3); it lives on the store mirror.
 *
 * How it reaches the engine during playback — all of it in realtime, without
 * re-scheduling:
 * - track strip gainDb/pan and the master gainDb/pan are mixer-lane state,
 *   mirrored by src/engine/mixer-sync.ts,
 * - track/master inserts and EQ are engine channel-strip state, and buses and
 *   track sends are engine bus lanes, mirrored by src/engine/strip-sync.ts.
 *
 * What stays UI-only: master sends (the engine master strip has no bus
 * routing).
 *
 * Offline mixdown/export renders (src/export/engine-render.ts) replay this
 * state onto an offline engine instance, so buses/sends, strips and
 * automation render exactly as live playback; the project-level mastering
 * chain is an additional export-only stage.
 */

import type { EqBand } from '@/wasm/index.js';
import { canonicalJson, fnv1a32Hex } from './hash';

/** One insert effect slot referencing the wasm processor catalog by name. */
export interface InsertSlot {
  /** Processor catalog name (e.g. 'dynamics.compressor', 'saturation.tape'). */
  processor: string;
  /** Parameter overrides passed to the processor (camelCase keys). */
  params: Record<string, number | boolean>;
  /** False bypasses the slot without losing its parameters. */
  enabled: boolean;
  /**
   * Track whose audio keys this insert's sidechain (ducking/sidechainRouter
   * processors on track strips only); absent = the insert's internal key.
   */
  sidechainSourceTrackId?: number;
}

/** One send from a strip to a mixer bus (post-fader on the engine side). */
export interface StripSend {
  /** Destination bus id (must exist in the project mixer state). */
  busId: string;
  /** Send level in dB. */
  levelDb: number;
  /** False mutes the send without removing it. */
  enabled: boolean;
}

/** Channel EQ as a list of libsonare EqBand descriptors. */
export interface StripEq {
  /** False bypasses the whole EQ. */
  enabled: boolean;
  /** Up to 24 bands (StreamingEqualizer band slots). */
  bands: EqBand[];
}

/** One channel strip (per track, master, or a bus). */
export interface MixerStrip {
  /** Strip gain in dB (0 = unity). */
  gainDb: number;
  /** Stereo balance in [-1, 1] (0 = centered). */
  pan: number;
  /** Insert chain, applied in order. */
  inserts: InsertSlot[];
  /** Sends to mixer buses (audible on tracks; UI-only on the master strip). */
  sends: StripSend[];
  /** Channel EQ; absent = no EQ. */
  eq?: StripEq;
  /**
   * Send-bus id this track's post-fader output routes into instead of the
   * master mix (track strips only; group routing always wins, see
   * src/engine/strip-sync.ts). Absent = master. Must reference a declared bus
   * or the engine rejects the lane.
   */
  outputBusId?: string;
}

/**
 * Project-level mastering chain applied to the summed stereo mixdown after
 * the master strip — offline export/preview renders only (the realtime engine
 * has no master-bus insert point, so live playback never runs it).
 *
 * The preset names a wasm mastering preset (masteringPresetNames catalog) and
 * is applied as a whole chain (masterAudioStereo); the wasm API exposes no
 * per-preset stage list, so the preset stays a single opaque step. The
 * processor slots run after the preset, in order, through the same one-shot
 * stereo processors used by channel-strip inserts.
 */
export interface MasteringChainState {
  /** Wasm mastering preset name; absent = no preset stage. */
  preset?: string;
  /** Processor slots applied after the preset, in order. */
  processors: InsertSlot[];
}

/** One send bus, audible as a realtime engine bus lane. */
export interface MixerBus {
  /** Stable bus id (unique within the project). */
  id: string;
  /** Display name. */
  name: string;
  /** Bus gain in dB (0 = unity). */
  gainDb: number;
}

/**
 * A VCA control group: a named fader that offsets the gain of every track
 * assigned to it (see {@link EditorTrack.vcaId}). Unlike a bus, a VCA carries
 * no audio of its own — it only shifts member lane gains, so the offset is
 * applied in the frontend mixer sync as a per-member dB delta.
 */
export interface VcaGroup {
  /** Stable group id (unique within the project). */
  id: string;
  /** Display name. */
  name: string;
  /** Group fader offset in dB applied to every member (0 = unity). */
  gainDb: number;
}

/** Project-wide mixer state: the master strip plus optional buses. */
export interface ProjectMixerState {
  /** Master strip (gain/pan, inserts and EQ are all audible in realtime). */
  master: MixerStrip;
  /** Send buses (realtime engine bus lanes, at most {@link MAX_MIXER_BUSES}). */
  buses: MixerBus[];
  /** VCA control groups; absent/empty = none. */
  vcaGroups?: VcaGroup[];
  /** Mastering chain for offline mixdown renders; absent = none. */
  masteringChain?: MasteringChainState;
}

/** Maximum number of send buses (the realtime engine's bus lane limit). */
export const MAX_MIXER_BUSES = 8;

/** Maximum number of VCA control groups (UI/sanity bound, not an engine limit). */
export const MAX_VCA_GROUPS = 8;

/** Lowest accepted strip gain in dB. */
export const MIN_STRIP_GAIN_DB = -96;

/** Highest accepted strip gain in dB. */
export const MAX_STRIP_GAIN_DB = 24;

/** Builds a neutral strip: unity gain, centered, no inserts/sends/EQ. */
export function createDefaultStrip(): MixerStrip {
  return { gainDb: 0, pan: 0, inserts: [], sends: [] };
}

/** Builds the default project mixer state: a neutral master, no buses. */
export function createDefaultMixerState(): ProjectMixerState {
  return { master: createDefaultStrip(), buses: [] };
}

/** Builds an empty mastering chain: no preset, no processors. */
export function createDefaultMasteringChain(): MasteringChainState {
  return { processors: [] };
}

/** Deep-copies a strip (strips are plain JSON data). */
export function cloneStrip(strip: MixerStrip): MixerStrip {
  return JSON.parse(JSON.stringify(strip)) as MixerStrip;
}

/** Deep-copies a mastering chain (chains are plain JSON data). */
export function cloneMasteringChain(chain: MasteringChainState): MasteringChainState {
  return JSON.parse(JSON.stringify(chain)) as MasteringChainState;
}

/** Deep-copies the project mixer state. */
export function cloneMixerState(state: ProjectMixerState): ProjectMixerState {
  return JSON.parse(JSON.stringify(state)) as ProjectMixerState;
}

/** True when a strip is neutral (no audible or UI-only deviation). */
export function isDefaultStrip(strip: MixerStrip): boolean {
  return (
    strip.gainDb === 0 &&
    strip.pan === 0 &&
    strip.inserts.length === 0 &&
    strip.sends.length === 0 &&
    strip.eq === undefined &&
    strip.outputBusId === undefined
  );
}

/** True when a mastering chain is empty (no preset and no processors). */
export function isDefaultMasteringChain(chain: MasteringChainState | undefined): boolean {
  if (!chain) return true;
  return chain.preset === undefined && chain.processors.length === 0;
}

/**
 * True when a mastering chain would actually process audio: a preset is set
 * or at least one processor slot is enabled.
 */
export function masteringChainIsActive(chain: MasteringChainState | undefined): boolean {
  if (!chain) return false;
  return chain.preset !== undefined || chain.processors.some((slot) => slot.enabled);
}

/** True when the project mixer state is entirely default. */
export function isDefaultMixerState(state: ProjectMixerState): boolean {
  return (
    isDefaultStrip(state.master) &&
    state.buses.length === 0 &&
    (state.vcaGroups === undefined || state.vcaGroups.length === 0) &&
    isDefaultMasteringChain(state.masteringChain)
  );
}

/**
 * Converts decibels to a linear amplitude factor.
 *
 * @param db Gain in dB.
 * @returns Linear factor (1 for 0 dB).
 */
export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Clamps a pan value to [-1, 1]. */
export function clampPan(pan: number): number {
  return Math.min(1, Math.max(-1, pan));
}

/** True when an EQ is active: enabled with at least one non-bypassed band. */
export function eqIsActive(eq: StripEq | undefined): boolean {
  if (!eq?.enabled) return false;
  return eq.bands.some((band) => band.enabled !== false && band.bypassed !== true);
}

/**
 * True when a strip carries buffer-level DSP (enabled inserts or an active
 * EQ). Gain and pan are excluded: they are applied as cheap per-schedule
 * operations outside the processed-buffer cache.
 */
export function stripHasDsp(strip: MixerStrip | undefined): boolean {
  if (!strip) return false;
  if (strip.inserts.some((slot) => slot.enabled)) return true;
  return eqIsActive(strip.eq);
}

/**
 * Deterministic identity segment for processed-buffer cache keys: hashes the
 * DSP-relevant strip content (enabled inserts in order with their params,
 * plus the active EQ bands). Gain and pan are excluded on purpose (see
 * {@link stripHasDsp}).
 *
 * @param strip Strip to identify (undefined = neutral).
 * @returns A stable key segment ('none' for strips without DSP).
 */
export function stripCacheSegment(strip: MixerStrip | undefined): string {
  if (!strip || !stripHasDsp(strip)) return 'none';
  const identity = {
    inserts: strip.inserts
      .filter((slot) => slot.enabled)
      .map((slot) => ({ processor: slot.processor, params: slot.params })),
    eq: eqIsActive(strip.eq) ? strip.eq?.bands : null,
  };
  return fnv1a32Hex(canonicalJson(identity));
}
