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

import { linearToDb, SILENCE_DB } from '@/lib/db';
import type { EqBand, SendTiming } from '@/wasm/index.js';
import { canonicalJson, fnv1a32Hex } from './hash';

/** Explicit source namespaces accepted by an insert sidechain key command. */
export type MixerSidechainSource =
  | { kind: 'track'; trackId: number }
  | { kind: 'bus'; busId: string }
  | { kind: 'group'; trackId: number };

/** One insert effect slot referencing the wasm processor catalog by name. */
export interface InsertSlot {
  /** Stable identity used by automation lanes across reorder/serialization. */
  id?: string;
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
  /**
   * Bus that keys this insert.  This is the app-level bus id; the realtime
   * engine maps it to its compact bus ordinal when the mixer topology is
   * published.  Track sidechains keep using `sidechainSourceTrackId` for
   * backwards compatibility with existing documents and reference cleanup.
   */
  sidechainSourceBusId?: string;
  /**
   * Group track whose internal engine bus keys this insert.  Group buses do
   * not have a `MixerBus` entry, so they need a separate reference from a
   * user-created return bus.
   */
  sidechainSourceGroupTrackId?: number;
}

/** Channel layouts accepted by libsonare's mixer buses and scene JSON. */
export type MixerChannelLayout = 'mono' | 'stereo' | '5.1' | '7.1';

/** Channel-layout values in the order used by libsonare's realtime ABI. */
export const MIXER_CHANNEL_LAYOUTS: ReadonlyArray<MixerChannelLayout> = [
  'mono',
  'stereo',
  '5.1',
  '7.1',
];

/** True when a value is a supported mixer channel layout. */
export function isMixerChannelLayout(value: unknown): value is MixerChannelLayout {
  return typeof value === 'string' && MIXER_CHANNEL_LAYOUTS.includes(value as MixerChannelLayout);
}

/** Converts a scene/model channel layout to libsonare's numeric ABI code. */
export function mixerChannelLayoutCode(layout: MixerChannelLayout | undefined): number {
  if (layout === 'mono') return 0;
  if (layout === '5.1') return 2;
  if (layout === '7.1') return 3;
  return 1;
}

/** One strip's source position in a surround destination bus. */
export interface SurroundPan {
  /** Horizontal azimuth in degrees (-180..180; 0 = front-center). */
  azimuth: number;
  /** Reserved for future height beds; retained for scene round-trips. */
  elevation: number;
  /** Spread from a point source to the front bed (0..1). */
  divergence: number;
  /** Linear LFE send (0..1). */
  lfe: number;
  /** Reserved for future focus/spread controls; default is 1. */
  distance: number;
}

/** Default surround source position used by libsonare. */
export const DEFAULT_SURROUND_PAN: SurroundPan = {
  azimuth: 0,
  elevation: 0,
  divergence: 0,
  lfe: 0,
  distance: 1,
};

/** Retired processor ids the engine still reads, mapped to the catalog id it reports. */
const RENAMED_PROCESSORS: Readonly<Record<string, string>> = {
  'eq.pultec': 'eq.passiveTube',
  'eq.apiStyle': 'eq.steppedProportionalQ',
};

/** Rewrites retired processor ids in one strip/chain to their current catalog id. */
export function renameRetiredProcessors(slots: InsertSlot[]): void {
  for (const slot of slots) {
    const current = RENAMED_PROCESSORS[slot.processor];
    if (current !== undefined) slot.processor = current;
  }
}

/** Rewrites retired processor ids throughout a project mixer state. */
export function renameRetiredMixerProcessors(state: ProjectMixerState): void {
  renameRetiredProcessors(state.master.inserts);
  for (const bus of state.buses) {
    if (bus.strip) renameRetiredProcessors(bus.strip.inserts);
  }
  if (state.masteringChain) renameRetiredProcessors(state.masteringChain.processors);
}

let nextProcessorId = 1;

/** Creates a collision-resistant, document-persisted processor identity. */
export function createProcessorId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `processor-${randomUuid}`;
  return `processor-${Date.now().toString(36)}-${(nextProcessorId++).toString(36)}`;
}

/** Ensures every processor in one strip/chain has a unique stable identity. */
export function ensureProcessorIds(slots: InsertSlot[]): void {
  const used = new Set<string>();
  for (const slot of slots) {
    const id = typeof slot.id === 'string' && slot.id.length > 0 ? slot.id : undefined;
    if (id !== undefined && !used.has(id)) {
      used.add(id);
      continue;
    }
    let next = createProcessorId();
    while (used.has(next)) next = createProcessorId();
    slot.id = next;
    used.add(next);
  }
}

/** Ensures stable processor identities throughout a project mixer state. */
export function ensureMixerProcessorIds(state: ProjectMixerState): void {
  ensureProcessorIds(state.master.inserts);
  for (const bus of state.buses) {
    if (bus.strip) ensureProcessorIds(bus.strip.inserts);
  }
  if (state.masteringChain) ensureProcessorIds(state.masteringChain.processors);
}

/** One send from a strip to a mixer bus. */
export interface StripSend {
  /** Destination bus id (must exist in the project mixer state). */
  busId: string;
  /** Send level in dB. */
  levelDb: number;
  /** False mutes the send without removing it. */
  enabled: boolean;
  /**
   * Tap point on the source strip: 'postFader' (default) taps after the
   * fader, 'preFader' before it (so the fader does not scale the send). Absent
   * = post-fader.
   */
  timing?: SendTiming;
}

/**
 * Strip pan law: the center-level compensation curve applied as a signal
 * pans across the stereo field. Mirrors libsonare's SonarePanLaw codes
 * (const3dB=0, const4.5dB=1, const6dB=2, linear0dB=3).
 */
export type PanLawId = 'const3dB' | 'const4.5dB' | 'const6dB' | 'linear0dB';

/**
 * Strip pan mode. 'balance' attenuates the opposite channel (default),
 * 'stereoPan' repositions the whole stereo image, 'dualPan' pans each input
 * channel independently (see {@link MixerStrip.dualPan}). Mirrors libsonare's
 * SonarePanMode codes (balance=0, stereoPan=1, dualPan=2).
 */
export type PanModeId = 'balance' | 'stereoPan' | 'dualPan';

/** Independent left/right pan positions used in 'dualPan' mode. */
export interface DualPan {
  /** Pan position of the left input channel, in [-1, 1]. */
  left: number;
  /** Pan position of the right input channel, in [-1, 1]. */
  right: number;
}

/** Selectable pan laws in display order. */
export const PAN_LAW_IDS: ReadonlyArray<PanLawId> = [
  'const3dB',
  'const4.5dB',
  'const6dB',
  'linear0dB',
];

/** Selectable pan modes in display order. */
export const PAN_MODE_IDS: ReadonlyArray<PanModeId> = ['balance', 'stereoPan', 'dualPan'];

/** Default pan law (constant-power -3 dB center), matching the engine default. */
export const DEFAULT_PAN_LAW: PanLawId = 'const3dB';

/** Default pan mode (balance). */
export const DEFAULT_PAN_MODE: PanModeId = 'balance';

/** Default dual-pan positions: preserve a stereo strip's left/right identity. */
export const DEFAULT_DUAL_PAN: DualPan = { left: -1, right: 1 };

/** Default stereo width (unchanged mid/side balance). */
export const DEFAULT_STRIP_WIDTH = 1;

/** Lowest accepted input trim in dB. */
export const MIN_INPUT_TRIM_DB = -48;

/** Highest accepted input trim in dB. */
export const MAX_INPUT_TRIM_DB = 48;

/** Lowest accepted stereo width multiplier. */
export const MIN_STRIP_WIDTH = 0;

/** Highest accepted stereo width multiplier. */
export const MAX_STRIP_WIDTH = 2;

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
  /**
   * Pre-insert input trim in dB. This is engine channel-strip DSP, separate
   * from the lane fader used for track volume/strip gain. Absent = 0 dB.
   */
  inputTrimDb?: number;
  /**
   * Stereo width multiplier applied in the channel strip (0 = mono, 1 =
   * unchanged, 2 = wide). Absent = {@link DEFAULT_STRIP_WIDTH}.
   */
  width?: number;
  /** Invert the left channel polarity before the strip output stage. */
  polarityInvertLeft?: boolean;
  /** Invert the right channel polarity before the strip output stage. */
  polarityInvertRight?: boolean;
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
  /**
   * Strip-panner channel alignment delay in whole samples (track strips only).
   * Mirrored to the engine via setTrackStripChannelDelaySamples and folded
   * into plugin-delay compensation. Absent/0 = no delay.
   */
  channelDelaySamples?: number;
  /**
   * Strip pan law; mirrored to the engine via the track or bus setter.
   * Absent = {@link DEFAULT_PAN_LAW}.
   */
  panLaw?: PanLawId;
  /**
   * Strip pan mode; mirrored to the engine via the track or bus setter.
   * Absent = {@link DEFAULT_PAN_MODE}.
   */
  panMode?: PanModeId;
  /**
   * Independent left/right pan positions for 'dualPan' mode; mirrored to the
   * engine via the track or bus setter. Absent = the engine's identity dual
   * pan (-1, +1) when dual-pan mode is selected.
   */
  dualPan?: DualPan;
  /** Source channel layout carried into a surround destination bus. */
  sourceLayout?: MixerChannelLayout;
  /** Surround position used when this strip feeds a 5.1/7.1 bus. */
  surroundPan?: SurroundPan;
}

/**
 * Project-level mastering chain applied to the summed stereo mixdown after
 * the master strip. Export/preview renders the full chain; live playback
 * mirrors only enabled processor slots that are valid realtime strip inserts
 * by appending them to the master strip scene.
 *
 * The preset names a wasm mastering preset (masteringPresetNames catalog) and
 * is applied as a whole chain (masterAudioStereo); the wasm API exposes no
 * per-preset stage list, so the preset stays a single opaque step. The
 * processor slots run after the preset, in order, through the same one-shot
 * stereo processors used by channel-strip inserts in export.
 */
export interface MasteringChainState {
  /** Wasm mastering preset name; absent = no preset stage. */
  preset?: string;
  /**
   * Flat mastering preset overrides passed to masterAudioStereo (dot-notation
   * keys such as 'loudness.targetLufs'). Absent/empty = preset defaults.
   */
  presetOverrides?: Record<string, number | boolean>;
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
  /** True silences this return without changing its fader value. */
  mute?: boolean;
  /**
   * True auditions this return alone: direct track outputs and every other
   * bus fall silent while the sends feeding this return keep running (see
   * {@link returnSoloRouting}).
   */
  solo?: boolean;
  /** Channel layout of this bus; absent keeps libsonare's stereo default. */
  channelLayout?: MixerChannelLayout;
  /** Optional return-bus insert strip. Sends sum through this chain. */
  strip?: MixerStrip;
}

/** Solo audition tap mode. In-place is the historical main-mix solo behavior. */
export type MixerSoloMode = 'inPlace' | 'pfl';

/** Default solo mode: existing in-place after-fader solo in the main mix. */
export const DEFAULT_MIXER_SOLO_MODE: MixerSoloMode = 'inPlace';

/**
 * A VCA control group: a named fader/mute/solo controller for every track
 * assigned to it (see {@link EditorTrack.vcaId}). Unlike a bus, a VCA carries
 * no audio of its own — it shifts member lane gains and folds its mute/solo
 * into the member lanes.
 */
export interface VcaGroup {
  /** Stable group id (unique within the project). */
  id: string;
  /** Display name. */
  name: string;
  /** Group fader offset in dB applied to every member (0 = unity). */
  gainDb: number;
  /** True mutes every member track. Absent/false = not muted. */
  mute?: boolean;
  /** True solos every member track. Absent/false = not soloed. */
  solo?: boolean;
}

/** Project-wide mixer state: the master strip plus optional buses. */
export interface ProjectMixerState {
  /** Solo audition mode. Absent = in-place for older projects. */
  soloMode?: MixerSoloMode;
  /** Master strip (gain/pan, inserts and EQ are all audible in realtime). */
  master: MixerStrip;
  /** Master output layout; absent keeps the stereo browser/output default. */
  masterLayout?: MixerChannelLayout;
  /** Send buses (realtime engine bus lanes, at most {@link MAX_MIXER_BUSES}). */
  buses: MixerBus[];
  /** VCA control groups; absent/empty = none. */
  vcaGroups?: VcaGroup[];
  /** Mastering chain for offline mixdown renders; absent = none. */
  masteringChain?: MasteringChainState;
}

/**
 * Resolves a track's VCA group fader offset in dB.
 *
 * @param vcaId The track's VCA group id; absent = unassigned (0 dB).
 * @param vcaGainDb Group id -> fader offset map; omit when there are no groups.
 * @returns The group's dB offset, or 0 when unassigned/unknown.
 */
export function vcaOffsetDb(
  vcaId: string | undefined,
  vcaGainDb: ReadonlyMap<string, number> | undefined,
): number {
  return vcaId !== undefined ? (vcaGainDb?.get(vcaId) ?? 0) : 0;
}

/** VCA mute/solo fields needed when deriving effective member lane state. */
export type VcaControlState = Pick<VcaGroup, 'mute' | 'solo'>;

/** True when the assigned VCA group currently mutes its member tracks. */
export function vcaGroupMuted(
  vcaId: string | undefined,
  vcaControls: ReadonlyMap<string, VcaControlState> | undefined,
): boolean {
  return vcaId !== undefined && vcaControls?.get(vcaId)?.mute === true;
}

/** True when the assigned VCA group currently solos its member tracks. */
export function vcaGroupSoloed(
  vcaId: string | undefined,
  vcaControls: ReadonlyMap<string, VcaControlState> | undefined,
): boolean {
  return vcaId !== undefined && vcaControls?.get(vcaId)?.solo === true;
}

/** Effective mute of a track after its assigned VCA group is applied. */
export function effectiveTrackMute(
  trackMute: boolean,
  vcaId: string | undefined,
  vcaControls: ReadonlyMap<string, VcaControlState> | undefined,
): boolean {
  return trackMute || vcaGroupMuted(vcaId, vcaControls);
}

/**
 * Returns a track list whose solo flags include soloed VCA groups, leaving the
 * original objects untouched when no VCA solo is active.
 */
export function tracksWithVcaSolo<T extends { solo: boolean; vcaId?: string }>(
  tracks: ReadonlyArray<T>,
  vcaControls: ReadonlyMap<string, VcaControlState> | undefined,
): ReadonlyArray<T> {
  if (!vcaControls || !tracks.some((track) => vcaGroupSoloed(track.vcaId, vcaControls))) {
    return tracks;
  }
  return tracks.map((track) =>
    vcaGroupSoloed(track.vcaId, vcaControls) ? { ...track, solo: true } : track,
  );
}

/**
 * Effective lane fader gain in dB for a track: its linear volume converted to
 * dB plus the strip trim plus its VCA group offset. Shared by realtime
 * mixer-sync, the automation-clear restore path and the offline renderer so the
 * three derivations never drift (a VCA-attenuated track that loses its fader
 * automation must restore to the same level it plays at).
 *
 * @param volume Linear track volume (>= 0, 1 = unity).
 * @param stripGainDb Strip trim in dB; absent = 0.
 * @param vcaOffset The track's VCA group offset in dB (see {@link vcaOffsetDb}).
 * @returns The combined lane fader gain in dB.
 */
export function laneGainDb(
  volume: number,
  stripGainDb: number | undefined,
  vcaOffset: number,
): number {
  return linearToDb(volume) + (stripGainDb ?? 0) + vcaOffset;
}

/** Maximum number of send buses (the realtime engine's bus lane limit). */
export const MAX_MIXER_BUSES = 8;

/** Counts the engine bus lanes consumed by send buses plus group tracks. */
export function engineBusCount(
  sendBusCount: number,
  tracks: ReadonlyArray<{ kind: string }>,
): number {
  return sendBusCount + tracks.filter((track) => track.kind === 'group').length;
}

/** Validates a complete mixer/track plan against the realtime bus limit. */
export function assertEngineBusCapacity(
  sendBusCount: number,
  tracks: ReadonlyArray<{ kind: string }>,
): void {
  const count = engineBusCount(sendBusCount, tracks);
  if (count > MAX_MIXER_BUSES) {
    throw new RangeError(`Mixer bus limit exceeded (${count}/${MAX_MIXER_BUSES})`);
  }
}

/** Throws when adding more engine bus lanes would exceed the realtime limit. */
export function assertCanAddEngineBus(
  sendBusCount: number,
  tracks: ReadonlyArray<{ kind: string }>,
): void {
  const count = engineBusCount(sendBusCount, tracks);
  if (count >= MAX_MIXER_BUSES) {
    throw new RangeError(`Mixer bus limit reached (${MAX_MIXER_BUSES})`);
  }
}

/**
 * Whether a return solo can be routed: it parks the silenced direct outputs on
 * an extra engine bus, so one slot must be free.
 *
 * @param sendBusCount Number of user send buses in the project.
 * @param tracks Project tracks (group tracks consume engine buses too).
 */
export function canRouteReturnSolo(
  sendBusCount: number,
  tracks: ReadonlyArray<{ kind: string }>,
): boolean {
  return engineBusCount(sendBusCount, tracks) < MAX_MIXER_BUSES;
}

/** Maximum number of VCA control groups (UI/sanity bound, not an engine limit). */
export const MAX_VCA_GROUPS = 8;

/** Lowest accepted strip gain in dB. */
export const MIN_STRIP_GAIN_DB = -96;

/** Highest accepted strip gain in dB. */
export const MAX_STRIP_GAIN_DB = 24;

/**
 * Gain sent to an engine return-bus lane. A muted return must use the engine's
 * silence floor rather than changing its stored fader value, so undo and an
 * unmute restore the exact previous mix level.
 */
export function effectiveMixerBusGainDb(bus: Pick<MixerBus, 'gainDb' | 'mute'>): number {
  return bus.mute === true ? SILENCE_DB : bus.gainDb;
}

/**
 * Routing overrides that audition the soloed return buses alone.
 *
 * A return carries no lane of its own, so the track-solo mechanism (muting
 * lanes) would also kill the sends that feed the return. Instead every direct
 * output is parked on a silent discard bus while the sends keep running, and
 * every bus except the soloed returns is floored to silence. Group buses are
 * silenced the same way, which takes their member tracks with them.
 */
export interface ReturnSoloRouting {
  /** True while at least one return bus is soloed. */
  active: boolean;
  /** Whether a bus (by store id) stays audible. */
  isSoloed: (busId: string) => boolean;
  /** Gain for a return bus under the current solo state. */
  busGainDb: (bus: Pick<MixerBus, 'id' | 'gainDb' | 'mute' | 'solo'>) => number;
}

/** Builds the {@link ReturnSoloRouting} for a project's bus set. */
export function returnSoloRouting(
  buses: ReadonlyArray<Pick<MixerBus, 'id' | 'gainDb' | 'mute' | 'solo'>>,
): ReturnSoloRouting {
  const soloed = new Set(buses.filter((bus) => bus.solo === true).map((bus) => bus.id));
  const active = soloed.size > 0;
  return {
    active,
    isSoloed: (busId) => soloed.has(busId),
    busGainDb: (bus) => {
      if (!active) return effectiveMixerBusGainDb(bus);
      return soloed.has(bus.id) ? effectiveMixerBusGainDb(bus) : SILENCE_DB;
    },
  };
}

/** Highest accepted channel alignment delay in samples (2 s at 48 kHz). */
export const MAX_CHANNEL_DELAY_SAMPLES = 96000;

/** Builds a neutral strip: unity gain, centered, no inserts/sends/EQ. */
export function createDefaultStrip(): MixerStrip {
  return { gainDb: 0, pan: 0, inserts: [], sends: [] };
}

/** Builds the default project mixer state: a neutral master, no buses. */
export function createDefaultMixerState(): ProjectMixerState {
  return { master: createDefaultStrip(), buses: [] };
}

/** Normalizes a mixer solo mode from untrusted documents/UI input. */
export function normalizeMixerSoloMode(mode: unknown): MixerSoloMode {
  return mode === 'pfl' || mode === 'inPlace' ? mode : DEFAULT_MIXER_SOLO_MODE;
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
  const surroundPan = strip.surroundPan;
  const hasNonDefaultSurroundPan =
    surroundPan !== undefined &&
    (surroundPan.azimuth !== DEFAULT_SURROUND_PAN.azimuth ||
      surroundPan.elevation !== DEFAULT_SURROUND_PAN.elevation ||
      surroundPan.divergence !== DEFAULT_SURROUND_PAN.divergence ||
      surroundPan.lfe !== DEFAULT_SURROUND_PAN.lfe ||
      surroundPan.distance !== DEFAULT_SURROUND_PAN.distance);
  return (
    strip.gainDb === 0 &&
    strip.pan === 0 &&
    strip.inserts.length === 0 &&
    strip.sends.length === 0 &&
    strip.eq === undefined &&
    strip.outputBusId === undefined &&
    (strip.inputTrimDb ?? 0) === 0 &&
    (strip.width ?? DEFAULT_STRIP_WIDTH) === DEFAULT_STRIP_WIDTH &&
    strip.polarityInvertLeft !== true &&
    strip.polarityInvertRight !== true &&
    (strip.channelDelaySamples ?? 0) === 0 &&
    (strip.panLaw ?? DEFAULT_PAN_LAW) === DEFAULT_PAN_LAW &&
    (strip.panMode ?? DEFAULT_PAN_MODE) === DEFAULT_PAN_MODE &&
    strip.dualPan === undefined &&
    (strip.sourceLayout ?? 'stereo') === 'stereo' &&
    !hasNonDefaultSurroundPan
  );
}

/** True when a mastering chain is empty (no preset and no processors). */
export function isDefaultMasteringChain(chain: MasteringChainState | undefined): boolean {
  if (!chain) return true;
  return (
    chain.preset === undefined &&
    Object.keys(chain.presetOverrides ?? {}).length === 0 &&
    chain.processors.length === 0
  );
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
    (state.masterLayout ?? 'stereo') === 'stereo' &&
    normalizeMixerSoloMode(state.soloMode) === DEFAULT_MIXER_SOLO_MODE &&
    state.buses.length === 0 &&
    (state.vcaGroups === undefined || state.vcaGroups.length === 0) &&
    isDefaultMasteringChain(state.masteringChain)
  );
}

// dB <-> linear conversions live in the shared @/lib/db module; re-exported
// here so existing mixer importers keep a single import site.
export { dbToLinear } from '@/lib/db';

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
 * EQ), including the strip-local input trim, width and polarity stages. Gain
 * and pan are excluded: they are applied as cheap per-schedule operations
 * outside the processed-buffer cache.
 */
export function stripHasDsp(strip: MixerStrip | undefined): boolean {
  if (!strip) return false;
  if ((strip.inputTrimDb ?? 0) !== 0) return true;
  if ((strip.width ?? DEFAULT_STRIP_WIDTH) !== DEFAULT_STRIP_WIDTH) return true;
  if (strip.polarityInvertLeft === true || strip.polarityInvertRight === true) return true;
  if (strip.inserts.some((slot) => slot.enabled)) return true;
  return eqIsActive(strip.eq);
}

/**
 * Deterministic identity segment for processed-buffer cache keys: hashes the
 * DSP-relevant strip content (input trim, width, polarity, enabled inserts in
 * order with their params, plus the active EQ bands). Gain and pan are
 * excluded on purpose (see {@link stripHasDsp}).
 *
 * @param strip Strip to identify (undefined = neutral).
 * @returns A stable key segment ('none' for strips without DSP).
 */
export function stripCacheSegment(strip: MixerStrip | undefined): string {
  if (!strip || !stripHasDsp(strip)) return 'none';
  const identity = {
    inputTrimDb: strip.inputTrimDb ?? 0,
    width: strip.width ?? DEFAULT_STRIP_WIDTH,
    polarityInvertLeft: strip.polarityInvertLeft === true,
    polarityInvertRight: strip.polarityInvertRight === true,
    inserts: strip.inserts
      .filter((slot) => slot.enabled)
      .map((slot) => ({ processor: slot.processor, params: slot.params })),
    eq: eqIsActive(strip.eq) ? strip.eq?.bands : null,
  };
  return fnv1a32Hex(canonicalJson(identity));
}
