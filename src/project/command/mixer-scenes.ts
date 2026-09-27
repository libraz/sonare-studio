import { isBusAutomationTarget, parseInsertAutomationParam } from '../automation';
import {
  assertEngineBusCapacity,
  cloneStrip,
  createDefaultStrip,
  createProcessorId,
  DEFAULT_DUAL_PAN,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  type InsertSlot,
  MAX_CHANNEL_DELAY_SAMPLES,
  MAX_INPUT_TRIM_DB,
  MAX_MIXER_BUSES,
  MAX_STRIP_GAIN_DB,
  MAX_STRIP_WIDTH,
  MAX_VCA_GROUPS,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_GAIN_DB,
  MIN_STRIP_WIDTH,
  type MixerBus,
  type MixerStrip,
  type PanLawId,
  type PanModeId,
  type ProjectMixerState,
  type StripEq,
  type StripSend,
} from '../mixer';
import { getWasmModule, useProjectStore } from '../store';
import { reconcileProcessorTargetReferences } from '../target-reference-registry';
import type { EditorTrack } from '../types';
import { executeApp } from './history';

interface SceneInsert {
  processor?: unknown;
  params?: unknown;
  sidechainKey?: unknown;
}

interface SceneSend {
  destinationBusId?: unknown;
  sendDb?: unknown;
  timing?: unknown;
}

interface SceneStrip {
  id?: unknown;
  faderDb?: unknown;
  pan?: unknown;
  inputTrimDb?: unknown;
  width?: unknown;
  polarityInvertLeft?: unknown;
  polarityInvertRight?: unknown;
  channelDelaySamples?: unknown;
  panLaw?: unknown;
  panMode?: unknown;
  dualPanLeft?: unknown;
  dualPanRight?: unknown;
  eq?: unknown;
  muted?: unknown;
  soloed?: unknown;
  soloSafe?: unknown;
  sends?: unknown;
  inserts?: unknown;
}

interface SceneBus {
  id?: unknown;
  role?: unknown;
  layout?: unknown;
  inputTrimDb?: unknown;
  width?: unknown;
  polarityInvertLeft?: unknown;
  polarityInvertRight?: unknown;
  pan?: unknown;
  panMode?: unknown;
  dualPanLeft?: unknown;
  dualPanRight?: unknown;
  panLaw?: unknown;
  eq?: unknown;
  inserts?: unknown;
}

interface SceneConnection {
  source?: unknown;
  destination?: unknown;
}

interface SceneVcaGroup {
  id?: unknown;
  gainDb?: unknown;
  members?: unknown;
}

interface MixerScene {
  strips: SceneStrip[];
  buses: SceneBus[];
  connections: SceneConnection[];
  vcaGroups: SceneVcaGroup[];
}

/** Summary returned after applying a mixer scene template. */
export interface ApplyMixerSceneResult {
  /** Number of current tracks that received a scene strip. */
  trackCount: number;
  /** Number of mixer buses created from the scene. */
  busCount: number;
  /** Number of VCA groups restored from the scene. */
  vcaCount: number;
}

const PAN_LAW_FROM_SCENE: ReadonlyArray<PanLawId> = [
  'const3dB',
  'const4.5dB',
  'const6dB',
  'linear0dB',
];

const PAN_MODE_FROM_SCENE: ReadonlyArray<PanModeId> = ['balance', 'stereoPan', 'dualPan'];

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Reads an EQ object from a scene while dropping malformed band entries. */
function sceneEq(value: unknown): StripEq | undefined {
  const record = objectRecord(value);
  if (!record || !Array.isArray(record.bands)) return undefined;
  const bands = record.bands.slice(0, 24).flatMap((entry) => {
    const band = objectRecord(entry);
    if (!band) return [];
    const clean: Record<string, number | boolean | string> = {};
    for (const [key, field] of Object.entries(band)) {
      if (typeof field === 'boolean' || typeof field === 'string') clean[key] = field;
      else if (typeof field === 'number' && Number.isFinite(field)) clean[key] = field;
    }
    return [clean];
  });
  return { enabled: booleanValue(record.enabled) ?? true, bands };
}

function readParams(value: unknown): Record<string, number | boolean> {
  let raw: unknown = value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      raw = JSON.parse(value);
    } catch {
      return {};
    }
  }
  const record = objectRecord(raw);
  if (!record) return {};
  const params: Record<string, number | boolean> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'boolean') params[key] = entry;
    else if (typeof entry === 'number' && Number.isFinite(entry)) params[key] = entry;
  }
  return params;
}

function loadRealtimeInsertCatalog(): ReadonlySet<string> | null {
  try {
    const wasm = getWasmModule() as unknown as {
      masteringInsertNames?: () => string[];
      masteringProcessorCatalog?: () => Array<{
        id: string;
        realtimeInsertable?: boolean;
      }>;
    };
    const entries = wasm.masteringProcessorCatalog?.();
    if (entries && entries.length > 0) {
      return new Set(
        entries
          .filter((entry) => entry.realtimeInsertable === true)
          .map((entry) => entry.id)
          .filter((id) => id.length > 0),
      );
    }
    const names = wasm.masteringInsertNames?.();
    if (names && names.length > 0) return new Set(names);
  } catch {
    // Store may not be initialized in isolated command tests; keep legacy behavior.
  }
  return null;
}

function sceneInserts(
  inserts: unknown,
  validProcessors: ReadonlySet<string> | null,
  sidechainBySceneId?: ReadonlyMap<string, number>,
): InsertSlot[] {
  if (!Array.isArray(inserts)) return [];
  return inserts.flatMap((entry): InsertSlot[] => {
    const record = objectRecord(entry) as SceneInsert | null;
    if (!record || typeof record.processor !== 'string' || record.processor.length === 0) return [];
    if (typeof record.sidechainKey === 'string' && sidechainBySceneId === undefined) {
      throw new RangeError(
        'Mixer scene bus/group/master inserts with sidechain keys need engine support',
      );
    }
    if (validProcessors && !validProcessors.has(record.processor)) return [];
    const slot: InsertSlot = {
      id: createProcessorId(),
      processor: record.processor,
      params: readParams(record.params),
      enabled: true,
    };
    if (typeof record.sidechainKey === 'string' && sidechainBySceneId?.has(record.sidechainKey)) {
      slot.sidechainSourceTrackId = sidechainBySceneId.get(record.sidechainKey);
    }
    return [slot];
  });
}

function sceneSends(sends: unknown, validBusIds: ReadonlySet<string>): StripSend[] {
  if (!Array.isArray(sends)) return [];
  return sends.flatMap((entry): StripSend[] => {
    const record = objectRecord(entry) as SceneSend | null;
    if (!record || typeof record.destinationBusId !== 'string') return [];
    if (!validBusIds.has(record.destinationBusId)) return [];
    const send: StripSend = {
      busId: record.destinationBusId,
      levelDb: clamp(finiteNumber(record.sendDb) ?? 0, MIN_STRIP_GAIN_DB, MAX_STRIP_GAIN_DB),
      enabled: true,
    };
    if (record.timing === 'pre' || record.timing === 'preFader') send.timing = 'preFader';
    return [send];
  });
}

function sceneStripToMixerStrip(
  strip: SceneStrip,
  validBusIds: ReadonlySet<string>,
  validProcessors: ReadonlySet<string> | null,
  outputBusId: string | undefined,
  sidechainBySceneId?: ReadonlyMap<string, number>,
): MixerStrip {
  const next = createDefaultStrip();
  next.gainDb = clamp(finiteNumber(strip.faderDb) ?? 0, MIN_STRIP_GAIN_DB, MAX_STRIP_GAIN_DB);
  next.pan = clamp(finiteNumber(strip.pan) ?? 0, -1, 1);
  const inputTrimDb = finiteNumber(strip.inputTrimDb);
  if (inputTrimDb !== undefined && inputTrimDb !== 0) {
    next.inputTrimDb = clamp(inputTrimDb, MIN_INPUT_TRIM_DB, MAX_INPUT_TRIM_DB);
  }
  const width = finiteNumber(strip.width);
  if (width !== undefined && width !== 1) {
    next.width = clamp(width, MIN_STRIP_WIDTH, MAX_STRIP_WIDTH);
  }
  if (strip.polarityInvertLeft === true) next.polarityInvertLeft = true;
  if (strip.polarityInvertRight === true) next.polarityInvertRight = true;
  const channelDelaySamples = finiteNumber(strip.channelDelaySamples);
  if (channelDelaySamples !== undefined && channelDelaySamples !== 0) {
    next.channelDelaySamples = clamp(Math.round(channelDelaySamples), 0, MAX_CHANNEL_DELAY_SAMPLES);
  }
  const panLaw = finiteNumber(strip.panLaw);
  if (panLaw !== undefined && Number.isInteger(panLaw) && PAN_LAW_FROM_SCENE[panLaw]) {
    next.panLaw = PAN_LAW_FROM_SCENE[panLaw];
  }
  const panMode = finiteNumber(strip.panMode);
  if (
    panMode !== undefined &&
    Number.isInteger(panMode) &&
    PAN_MODE_FROM_SCENE[panMode] &&
    PAN_MODE_FROM_SCENE[panMode] !== DEFAULT_PAN_MODE
  ) {
    next.panMode = PAN_MODE_FROM_SCENE[panMode];
  }
  const dualPanLeft = finiteNumber(strip.dualPanLeft);
  const dualPanRight = finiteNumber(strip.dualPanRight);
  if (dualPanLeft !== undefined || dualPanRight !== undefined) {
    next.dualPan = {
      left: clamp(dualPanLeft ?? DEFAULT_DUAL_PAN.left, -1, 1),
      right: clamp(dualPanRight ?? DEFAULT_DUAL_PAN.right, -1, 1),
    };
  }
  if (next.panMode === 'dualPan' && next.dualPan === undefined) {
    next.dualPan = { ...DEFAULT_DUAL_PAN };
  }
  const eq = sceneEq(strip.eq);
  if (eq !== undefined) next.eq = eq;
  next.inserts = sceneInserts(strip.inserts, validProcessors, sidechainBySceneId);
  next.sends = sceneSends(strip.sends, validBusIds);
  if (outputBusId !== undefined && validBusIds.has(outputBusId)) next.outputBusId = outputBusId;
  return next;
}

/** Applies fields that libsonare stores directly on a scene bus. */
function applySceneBusStripFields(
  strip: MixerStrip,
  bus: SceneBus,
  validProcessors: ReadonlySet<string> | null,
): void {
  const busInputTrim = finiteNumber(bus.inputTrimDb);
  if (busInputTrim !== undefined) {
    if (busInputTrim === 0) delete strip.inputTrimDb;
    else strip.inputTrimDb = clamp(busInputTrim, MIN_INPUT_TRIM_DB, MAX_INPUT_TRIM_DB);
  }
  const busWidth = finiteNumber(bus.width);
  if (busWidth !== undefined) {
    if (busWidth === 1) delete strip.width;
    else strip.width = clamp(busWidth, MIN_STRIP_WIDTH, MAX_STRIP_WIDTH);
  }
  if (bus.polarityInvertLeft !== undefined) {
    if (bus.polarityInvertLeft === true) strip.polarityInvertLeft = true;
    else delete strip.polarityInvertLeft;
  }
  if (bus.polarityInvertRight !== undefined) {
    if (bus.polarityInvertRight === true) strip.polarityInvertRight = true;
    else delete strip.polarityInvertRight;
  }
  const busPan = finiteNumber(bus.pan);
  if (busPan !== undefined) strip.pan = clamp(busPan, -1, 1);
  const busPanLaw = finiteNumber(bus.panLaw);
  if (busPanLaw !== undefined && Number.isInteger(busPanLaw)) {
    const law = PAN_LAW_FROM_SCENE[busPanLaw];
    if (law !== undefined) {
      if (law === DEFAULT_PAN_LAW) delete strip.panLaw;
      else strip.panLaw = law;
    }
  }
  const busPanMode = finiteNumber(bus.panMode);
  if (busPanMode !== undefined && Number.isInteger(busPanMode)) {
    const mode = PAN_MODE_FROM_SCENE[busPanMode];
    if (mode !== undefined) {
      if (mode === DEFAULT_PAN_MODE) delete strip.panMode;
      else strip.panMode = mode;
    }
  }
  const busDualLeft = finiteNumber(bus.dualPanLeft);
  const busDualRight = finiteNumber(bus.dualPanRight);
  if (busDualLeft !== undefined || busDualRight !== undefined) {
    strip.dualPan = {
      left: clamp(busDualLeft ?? DEFAULT_DUAL_PAN.left, -1, 1),
      right: clamp(busDualRight ?? DEFAULT_DUAL_PAN.right, -1, 1),
    };
  } else if (strip.panMode === 'dualPan' && strip.dualPan === undefined) {
    strip.dualPan = { ...DEFAULT_DUAL_PAN };
  }
  const busEq = sceneEq(bus.eq);
  if (busEq !== undefined) strip.eq = busEq;
  const busInserts = sceneInserts(bus.inserts, validProcessors);
  // Older templates put return inserts on the connected strip. A new scene
  // can put them directly on the bus; prefer the direct bus form when it has
  // usable entries, otherwise retain the legacy connected-strip chain.
  if (busInserts.length > 0) strip.inserts = busInserts;
}

/** Whether a scene strip carries a non-neutral serial DSP stage. */
function sceneStripHasDsp(strip: SceneStrip | SceneBus | undefined): boolean {
  if (!strip) return false;
  const inputTrim = finiteNumber(strip.inputTrimDb);
  const width = finiteNumber(strip.width);
  if (inputTrim !== undefined && inputTrim !== 0) return true;
  if (width !== undefined && width !== 1) return true;
  if (strip.polarityInvertLeft === true || strip.polarityInvertRight === true) return true;
  if (Array.isArray(strip.inserts) && strip.inserts.length > 0) return true;
  const eq = sceneEq(strip.eq);
  return eq !== undefined && (eq.bands.length > 0 || eq.enabled === false);
}

/** Whether a scene entry carries a non-neutral output panner stage. */
function sceneEntryHasPanner(strip: SceneStrip | SceneBus | undefined): boolean {
  if (!strip) return false;
  const pan = finiteNumber(strip.pan);
  const mode = finiteNumber(strip.panMode);
  const law = finiteNumber(strip.panLaw);
  const left = finiteNumber(strip.dualPanLeft);
  const right = finiteNumber(strip.dualPanRight);
  return (
    (pan !== undefined && pan !== 0) ||
    (mode !== undefined && mode !== 0) ||
    (law !== undefined && law !== 0) ||
    (left !== undefined && left !== DEFAULT_DUAL_PAN.left) ||
    (right !== undefined && right !== DEFAULT_DUAL_PAN.right)
  );
}

/** Rejects two non-neutral stages that one Studio bus strip cannot preserve. */
function assertNoBusReturnDspConflict(bus: SceneBus, returnStrip: SceneStrip | undefined): void {
  if (!returnStrip) return;
  if (
    (sceneStripHasDsp(bus) || sceneEntryHasPanner(bus)) &&
    (sceneStripHasDsp(returnStrip) || sceneEntryHasPanner(returnStrip))
  ) {
    throw new RangeError(
      `Mixer scene bus ${String(bus.id)} carries direct DSP or pan and a legacy return strip also carries DSP or pan; use one representation`,
    );
  }
}

function busDisplayName(id: string): string {
  return id
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function parseSceneJson(sceneJson: string): MixerScene {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sceneJson);
  } catch (err) {
    throw new Error(
      `Invalid mixer scene JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const root = objectRecord(parsed);
  if (!root) throw new Error('Invalid mixer scene JSON: expected an object');
  return {
    strips: Array.isArray(root.strips) ? (root.strips as SceneStrip[]) : [],
    buses: Array.isArray(root.buses) ? (root.buses as SceneBus[]) : [],
    connections: Array.isArray(root.connections) ? (root.connections as SceneConnection[]) : [],
    vcaGroups: Array.isArray(root.vcaGroups) ? (root.vcaGroups as SceneVcaGroup[]) : [],
  };
}

function sceneId(strip: SceneStrip): string | null {
  return typeof strip.id === 'string' && strip.id.length > 0 ? strip.id : null;
}

/** Track id a scene strip names through the `track-<id>` spelling the engine sync writes. */
function sceneStripTrackId(strip: SceneStrip): number | undefined {
  const match = /^track-(\d+)$/.exec(sceneId(strip) ?? '');
  return match ? Number(match[1]) : undefined;
}

function buildScenePlan(
  scene: MixerScene,
  tracks: ReadonlyArray<EditorTrack>,
  validProcessors: ReadonlySet<string> | null,
): {
  mixer: ProjectMixerState;
  tracks: EditorTrack[];
  /** Tracks whose strips the scene replaced. */
  replacedTrackIds: Set<number>;
  /** Whether the scene carries an audible master strip stage of its own. */
  replacesMaster: boolean;
  result: ApplyMixerSceneResult;
} {
  const stripsById = new Map<string, SceneStrip>();
  for (const strip of scene.strips) {
    const id = sceneId(strip);
    if (id) stripsById.set(id, strip);
  }
  for (const bus of scene.buses) {
    if (bus.layout !== undefined && bus.layout !== 'stereo') {
      throw new RangeError(
        `Mixer scene bus ${String(bus.id)} uses unsupported channel layout ${String(bus.layout)}`,
      );
    }
  }

  const masterBus =
    scene.buses.find((bus) => bus.role === 'master') ??
    scene.buses.find((bus) => bus.id === 'master');

  const busEntries = scene.buses.filter((bus) => {
    if (typeof bus.id !== 'string' || bus === masterBus) return false;
    return bus.role !== 'master';
  });
  if (busEntries.length > MAX_MIXER_BUSES) {
    throw new RangeError(`Mixer scene declares too many buses: ${busEntries.length}`);
  }

  const busIds = new Set(busEntries.map((bus) => bus.id as string));
  const returnStripByBus = new Map<string, string>();
  const outputBusByStrip = new Map<string, string>();
  for (const connection of scene.connections) {
    if (typeof connection.source !== 'string' || typeof connection.destination !== 'string') {
      continue;
    }
    if (busIds.has(connection.source) && stripsById.has(connection.destination)) {
      returnStripByBus.set(connection.source, connection.destination);
    } else if (stripsById.has(connection.source) && busIds.has(connection.destination)) {
      outputBusByStrip.set(connection.source, connection.destination);
    }
  }

  const returnStripIds = new Set(returnStripByBus.values());
  const trackSceneStrips = scene.strips.filter((strip) => {
    const id = sceneId(strip);
    return id !== null && !returnStripIds.has(id);
  });
  // A scene written for this project names its strips by track id; a template
  // does not, and its strips map onto the tracks in order.
  const trackIds = new Set(tracks.map((track) => track.id));
  const byTrackId =
    trackSceneStrips.length > 0 &&
    trackSceneStrips.every((strip) => trackIds.has(sceneStripTrackId(strip) ?? -1));
  const stripForTrack = (track: EditorTrack, index: number): SceneStrip | undefined =>
    byTrackId
      ? trackSceneStrips.find((strip) => sceneStripTrackId(strip) === track.id)
      : trackSceneStrips[index];
  const sidechainBySceneId = new Map<string, number>();
  tracks.forEach((track, index) => {
    const strip = stripForTrack(track, index);
    const id = strip ? sceneId(strip) : null;
    if (id) sidechainBySceneId.set(id, track.id);
  });

  const mixerBuses: MixerBus[] = busEntries.map((bus) => {
    const busId = bus.id as string;
    const returnStrip = stripsById.get(returnStripByBus.get(busId) ?? '');
    if (Array.isArray(returnStrip?.sends) && returnStrip.sends.length > 0) {
      throw new RangeError(`Mixer scene return strip for bus ${busId} has unsupported sends`);
    }
    assertNoBusReturnDspConflict(bus, returnStrip);
    const strip = returnStrip
      ? sceneStripToMixerStrip(returnStrip, busIds, validProcessors, undefined)
      : createDefaultStrip();
    const legacyHasDsp = sceneStripHasDsp(returnStrip) || sceneEntryHasPanner(returnStrip);
    if (!legacyHasDsp) applySceneBusStripFields(strip, bus, validProcessors);
    const gainDb = strip.gainDb;
    strip.gainDb = 0;
    return {
      id: busId,
      name: busDisplayName(busId) || busId,
      gainDb,
      ...(booleanValue(returnStrip?.muted) === true ? { mute: true } : {}),
      ...(booleanValue(returnStrip?.soloed) === true ? { solo: true } : {}),
      strip,
    };
  });

  const vcaGroups = scene.vcaGroups.slice(0, MAX_VCA_GROUPS).flatMap((group, index) => {
    const id = typeof group.id === 'string' && group.id.length > 0 ? group.id : `vca-${index + 1}`;
    return [
      {
        id,
        name: busDisplayName(id) || id,
        gainDb: clamp(finiteNumber(group.gainDb) ?? 0, MIN_STRIP_GAIN_DB, MAX_STRIP_GAIN_DB),
      },
    ];
  });
  const vcaByMember = new Map<string, string>();
  for (const group of scene.vcaGroups.slice(0, MAX_VCA_GROUPS)) {
    const id = typeof group.id === 'string' && group.id.length > 0 ? group.id : undefined;
    if (!id || !Array.isArray(group.members)) continue;
    for (const member of group.members) {
      if (typeof member === 'string') vcaByMember.set(member, id);
    }
  }

  const replacedTrackIds = new Set<number>();
  const nextTracks = tracks.map((track, index) => {
    const sceneStrip = stripForTrack(track, index);
    if (!sceneStrip) return track;
    replacedTrackIds.add(track.id);
    const id = sceneId(sceneStrip);
    const outputBusId = id && track.kind !== 'group' ? outputBusByStrip.get(id) : undefined;
    const mixer = sceneStripToMixerStrip(
      sceneStrip,
      busIds,
      validProcessors,
      outputBusId,
      track.kind === 'group' ? undefined : sidechainBySceneId,
    );
    const next: EditorTrack = {
      ...track,
      mixer,
      mute: booleanValue(sceneStrip.muted) ?? track.mute,
      solo: booleanValue(sceneStrip.soloed) ?? track.solo,
    };
    // Keep the legacy track-level pan mirror in sync for all strip kinds,
    // including group tracks whose mixer bus now has an audible panner.
    next.pan = mixer.pan;
    if (sceneStrip.soloSafe === true) next.soloSafe = true;
    else delete next.soloSafe;
    if (id && vcaByMember.has(id)) next.vcaId = vcaByMember.get(id);
    else delete next.vcaId;
    return next;
  });

  const master = cloneStrip(createDefaultStrip());
  if (masterBus) applySceneBusStripFields(master, masterBus, validProcessors);
  // The historical scene contract uses an empty master bus as a marker and
  // leaves the app's existing master chain intact. Direct bus fields are a
  // newer, explicit master strip representation, so they must opt into the
  // replacement even when they do not contain inserts.
  const replacesMaster =
    master.inserts.length > 0 ||
    (masterBus !== undefined &&
      (sceneStripHasDsp({ ...masterBus, inserts: [] }) || sceneEntryHasPanner(masterBus)));

  assertEngineBusCapacity(mixerBuses.length, nextTracks);

  return {
    mixer: {
      master,
      buses: mixerBuses,
      ...(vcaGroups.length > 0 ? { vcaGroups } : {}),
    },
    tracks: nextTracks,
    replacedTrackIds,
    replacesMaster,
    result: {
      trackCount: replacedTrackIds.size,
      busCount: mixerBuses.length,
      vcaCount: vcaGroups.length,
    },
  };
}

/**
 * Applies a libsonare mixer-scene JSON template to the current project as one
 * undoable edit. Existing tracks are kept; scene strips named `track-<id>` map
 * onto those tracks, other scene strips map onto the tracks in order. Scene
 * buses/sends/VCA groups replace the project mixer template. The master's
 * inserts are replaced only by a scene that names master inserts: every scene
 * declares a master bus, and an empty one says nothing about the user's chain.
 * Direct master bus DSP or panner fields opt into replacing the master strip.
 */
export function applyMixerSceneJson(sceneJson: string): ApplyMixerSceneResult {
  const scene = parseSceneJson(sceneJson);
  const store = useProjectStore();
  const plan = buildScenePlan(scene, store.tracks, loadRealtimeInsertCatalog());
  const { replacedTrackIds, replacesMaster } = plan;
  return executeApp(() => {
    // Scene templates replace routing and strip state, not project-wide
    // monitoring/mastering preferences that the scene format cannot express.
    store.mixer = {
      ...plan.mixer,
      master: replacesMaster ? plan.mixer.master : store.mixer.master,
      ...(store.mixer.soloMode !== undefined ? { soloMode: store.mixer.soloMode } : {}),
      ...(store.mixer.masteringChain !== undefined
        ? { masteringChain: store.mixer.masteringChain }
        : {}),
    };
    store.tracks = plan.tracks;
    store.automationLanes = store.automationLanes.filter((lane) => {
      // A scene replaces every bus and the master strip/chain. It also
      // replaces the mapped track strips. Processor lanes from the previous
      // structures must not survive merely because a new slot has the same
      // numeric index; executeApp keeps them in the undo snapshot.
      if (isBusAutomationTarget(lane.target)) return false;
      if (lane.target === 'master') {
        return !replacesMaster || parseInsertAutomationParam(lane.param) === undefined;
      }
      if (replacedTrackIds.has(lane.target)) {
        return parseInsertAutomationParam(lane.param) === undefined;
      }
      return true;
    });
    reconcileProcessorTargetReferences(store);
    store.refresh();
    return plan.result;
  });
}
