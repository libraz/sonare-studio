import { errorMessage } from '@/lib/errors';
import { clamp } from '@/lib/math';
import { isBusAutomationTarget, parseInsertAutomationParam } from '../automation';
import {
  assertValidMixerBusId,
  assertValidMixerBusTopology,
  mixerBusTopology,
} from '../bus-topology';
import {
  assertEngineBusCapacity,
  cloneStrip,
  createDefaultStrip,
  createProcessorId,
  DEFAULT_DUAL_PAN,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_SURROUND_PAN,
  type InsertSlot,
  isMixerChannelLayout,
  MAX_CHANNEL_DELAY_SAMPLES,
  MAX_INPUT_TRIM_DB,
  MAX_MIXER_BUSES,
  MAX_STRIP_EQ_BANDS,
  MAX_STRIP_GAIN_DB,
  MAX_STRIP_WIDTH,
  MAX_VCA_GROUPS,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_GAIN_DB,
  MIN_STRIP_WIDTH,
  type MixerBus,
  type MixerChannelLayout,
  type MixerStrip,
  type PanLawId,
  type PanModeId,
  type ProjectMixerState,
  type StripEq,
  type StripSend,
  type SurroundPan,
} from '../mixer';
import { getWasmModule, useProjectStore } from '../store';
import {
  pruneStripBusReferences,
  reconcileProcessorTargetReferences,
  reconcileStructureTargetReferences,
} from '../target-reference-registry';
import type { EditorTrack } from '../types';
import { executeApp } from './history';

interface SceneInsert {
  processor?: unknown;
  params?: unknown;
  sidechainKey?: unknown;
}

type SceneSidechainSource =
  | { kind: 'track'; trackId: number }
  | { kind: 'bus'; busId: string }
  | { kind: 'group'; trackId: number };

type SceneSidechainTarget = 'track' | 'group' | 'bus' | 'master';

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
  sourceLayout?: unknown;
  surroundPan?: unknown;
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

const MIX_ASSISTANT_INSERT_PREFIX = 'mix-assistant-';

/** Summary returned after applying a mixer scene template. */
export interface ApplyMixerSceneResult {
  /** Number of current tracks that received a scene strip. */
  trackCount: number;
  /** Number of mixer buses created from the scene. */
  busCount: number;
  /** Number of VCA groups restored from the scene. */
  vcaCount: number;
}

/** Scene file indices (a file format; independent of the display order in PAN_LAW_IDS). */
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

/** Reads an EQ object from a scene while dropping malformed band entries. */
function sceneEq(value: unknown): StripEq | undefined {
  const record = objectRecord(value);
  if (!record || !Array.isArray(record.bands)) return undefined;
  const bands = record.bands.slice(0, MAX_STRIP_EQ_BANDS).flatMap((entry) => {
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
  sidechainBySceneId?: ReadonlyMap<string, SceneSidechainSource>,
  sidechainTarget: SceneSidechainTarget = 'track',
): InsertSlot[] {
  if (!Array.isArray(inserts)) return [];
  return inserts.flatMap((entry): InsertSlot[] => {
    const record = objectRecord(entry) as SceneInsert | null;
    if (!record || typeof record.processor !== 'string' || record.processor.length === 0) return [];
    if (validProcessors && !validProcessors.has(record.processor)) return [];
    const slot: InsertSlot = {
      id: createProcessorId(),
      processor: record.processor,
      params: readParams(record.params),
      enabled: true,
    };
    if (typeof record.sidechainKey === 'string') {
      const source = sidechainBySceneId?.get(record.sidechainKey);
      if (source && sidechainTarget === 'track' && source.kind !== 'track') {
        throw new RangeError(
          `Mixer scene track sidechain key ${record.sidechainKey} must reference a track`,
        );
      }
      if (source?.kind === 'track') slot.sidechainSourceTrackId = source.trackId;
      if (source?.kind === 'bus') slot.sidechainSourceBusId = source.busId;
      if (source?.kind === 'group') slot.sidechainSourceGroupTrackId = source.trackId;
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
  sidechainBySceneId?: ReadonlyMap<string, SceneSidechainSource>,
  sidechainTarget: SceneSidechainTarget = 'track',
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
  const sourceLayout = sceneChannelLayout(strip.sourceLayout);
  if (sourceLayout !== undefined && sourceLayout !== 'stereo') next.sourceLayout = sourceLayout;
  const surroundPan = sceneSurroundPan(strip.surroundPan);
  if (surroundPan !== undefined) next.surroundPan = surroundPan;
  next.inserts = sceneInserts(strip.inserts, validProcessors, sidechainBySceneId, sidechainTarget);
  next.sends = sceneSends(strip.sends, validBusIds);
  if (outputBusId !== undefined && validBusIds.has(outputBusId)) next.outputBusId = outputBusId;
  return next;
}

function sceneChannelLayout(value: unknown): MixerChannelLayout | undefined {
  return isMixerChannelLayout(value) ? value : undefined;
}

function sceneSurroundPan(value: unknown): SurroundPan | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const azimuth = finiteNumber(record.azimuth);
  const elevation = finiteNumber(record.elevation);
  const divergence = finiteNumber(record.divergence);
  const lfe = finiteNumber(record.lfe);
  const distance = finiteNumber(record.distance);
  const next: SurroundPan = {
    azimuth: clamp(azimuth ?? DEFAULT_SURROUND_PAN.azimuth, -180, 180),
    elevation: elevation ?? DEFAULT_SURROUND_PAN.elevation,
    divergence: clamp(divergence ?? DEFAULT_SURROUND_PAN.divergence, 0, 1),
    lfe: clamp(lfe ?? DEFAULT_SURROUND_PAN.lfe, 0, 1),
    distance: distance ?? DEFAULT_SURROUND_PAN.distance,
  };
  if (
    next.azimuth === DEFAULT_SURROUND_PAN.azimuth &&
    next.elevation === DEFAULT_SURROUND_PAN.elevation &&
    next.divergence === DEFAULT_SURROUND_PAN.divergence &&
    next.lfe === DEFAULT_SURROUND_PAN.lfe &&
    next.distance === DEFAULT_SURROUND_PAN.distance
  ) {
    return undefined;
  }
  return next;
}

/** Applies fields that libsonare stores directly on a scene bus. */
function applySceneBusStripFields(
  strip: MixerStrip,
  bus: SceneBus,
  validProcessors: ReadonlySet<string> | null,
  sidechainBySceneId?: ReadonlyMap<string, SceneSidechainSource>,
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
  const busInserts = sceneInserts(bus.inserts, validProcessors, sidechainBySceneId, 'bus');
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
function sceneEntryHasPanner(
  strip: SceneStrip | SceneBus | undefined,
  allowSurroundPan = false,
): boolean {
  if (!strip) return false;
  // Surround position is a source-strip property. Callers pass true only for
  // a SceneStrip; SceneBus has no such field and must keep it inert.
  if (allowSurroundPan && sceneSurroundPan((strip as SceneStrip).surroundPan) !== undefined) {
    return true;
  }
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
    (sceneStripHasDsp(returnStrip) || sceneEntryHasPanner(returnStrip, true))
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
    throw new Error(`Invalid mixer scene JSON: ${errorMessage(err)}`);
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
  preserveTrackInserts = false,
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
    if (bus.layout !== undefined && !isMixerChannelLayout(bus.layout)) {
      throw new RangeError(`Mixer scene bus ${String(bus.id)} uses unknown channel layout`);
    }
    if (
      (bus.layout === '5.1' || bus.layout === '7.1') &&
      ((finiteNumber(bus.width) !== undefined && finiteNumber(bus.width) !== 1) ||
        (finiteNumber(bus.pan) !== undefined && finiteNumber(bus.pan) !== 0) ||
        (finiteNumber(bus.panMode) !== undefined && finiteNumber(bus.panMode) !== 0) ||
        (finiteNumber(bus.panLaw) !== undefined && finiteNumber(bus.panLaw) !== 0) ||
        (finiteNumber(bus.dualPanLeft) !== undefined && finiteNumber(bus.dualPanLeft) !== -1) ||
        (finiteNumber(bus.dualPanRight) !== undefined && finiteNumber(bus.dualPanRight) !== 1))
    ) {
      throw new RangeError(`Mixer scene bus ${String(bus.id)} cannot carry stereo pan or width`);
    }
  }

  const masterBus =
    scene.buses.find((bus) => bus.role === 'master') ??
    scene.buses.find((bus) => bus.id === 'master');

  const sceneBusIds = new Set<string>();
  for (const bus of scene.buses) {
    // Only the scene's resolved master entry may use the reserved `master`
    // id. An aux entry with that id would survive scene import but fail when
    // the resulting project is serialized.
    assertValidMixerBusId(bus.id, sceneBusIds, { allowMaster: bus === masterBus });
    sceneBusIds.add(bus.id);
  }

  const busEntries = scene.buses.filter((bus) => {
    if (bus === masterBus) return false;
    return bus.role !== 'master';
  });
  if (busEntries.length > MAX_MIXER_BUSES) {
    throw new RangeError(`Mixer scene declares too many buses: ${busEntries.length}`);
  }

  const busIds = new Set(busEntries.map((bus) => bus.id as string));
  const returnStripByBus = new Map<string, string>();
  const outputBusByStrip = new Map<string, string>();
  const outputBusByBus = new Map<string, string>();
  for (const connection of scene.connections) {
    if (typeof connection.source !== 'string' || typeof connection.destination !== 'string') {
      continue;
    }
    if (busIds.has(connection.source) && stripsById.has(connection.destination)) {
      returnStripByBus.set(connection.source, connection.destination);
    } else if (busIds.has(connection.source) && busIds.has(connection.destination)) {
      outputBusByBus.set(connection.source, connection.destination);
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
  const sceneTrackIds = trackSceneStrips.map(sceneStripTrackId);
  const byTrackId =
    trackSceneStrips.length > 0 && sceneTrackIds.every((id) => trackIds.has(id ?? -1));
  const stripByTrackId = new Map<number, SceneStrip>();
  if (byTrackId) {
    trackSceneStrips.forEach((strip, index) => {
      const id = sceneTrackIds[index];
      if (id !== undefined && !stripByTrackId.has(id)) stripByTrackId.set(id, strip);
    });
  }
  const stripForTrack = (track: EditorTrack, index: number): SceneStrip | undefined =>
    byTrackId ? stripByTrackId.get(track.id) : trackSceneStrips[index];
  const sidechainBySceneId = new Map<string, SceneSidechainSource>();
  tracks.forEach((track, index) => {
    const strip = stripForTrack(track, index);
    const id = strip ? sceneId(strip) : null;
    if (id) {
      sidechainBySceneId.set(
        id,
        track.kind === 'group'
          ? { kind: 'group', trackId: track.id }
          : { kind: 'track', trackId: track.id },
      );
    }
  });
  for (const bus of busEntries) {
    if (typeof bus.id === 'string' && bus.id.length > 0) {
      sidechainBySceneId.set(bus.id, { kind: 'bus', busId: bus.id });
    }
  }
  // Legacy scenes attach a return strip to a bus through a connection. Once
  // collapsed into the Studio bus strip, that return strip's id must resolve
  // as the owning bus when another insert keys it.
  for (const bus of busEntries) {
    const returnStripId = returnStripByBus.get(bus.id as string);
    if (returnStripId !== undefined) {
      sidechainBySceneId.set(returnStripId, { kind: 'bus', busId: bus.id as string });
    }
  }

  const mixerBuses: MixerBus[] = busEntries.map((bus) => {
    const busId = bus.id as string;
    const returnStrip = stripsById.get(returnStripByBus.get(busId) ?? '');
    assertNoBusReturnDspConflict(bus, returnStrip);
    const strip = returnStrip
      ? sceneStripToMixerStrip(
          returnStrip,
          busIds,
          validProcessors,
          undefined,
          sidechainBySceneId,
          'bus',
        )
      : createDefaultStrip();
    const legacyHasDsp = sceneStripHasDsp(returnStrip) || sceneEntryHasPanner(returnStrip, true);
    if (!legacyHasDsp) applySceneBusStripFields(strip, bus, validProcessors, sidechainBySceneId);
    const gainDb = strip.gainDb;
    strip.gainDb = 0;
    const outputBusId = outputBusByBus.get(busId);
    if (outputBusId !== undefined) strip.outputBusId = outputBusId;
    return {
      id: busId,
      name: busDisplayName(busId) || busId,
      gainDb,
      ...(booleanValue(returnStrip?.muted) === true ? { mute: true } : {}),
      ...(booleanValue(returnStrip?.soloed) === true ? { solo: true } : {}),
      ...(sceneChannelLayout(bus.layout) && sceneChannelLayout(bus.layout) !== 'stereo'
        ? { channelLayout: sceneChannelLayout(bus.layout) }
        : {}),
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
    if (!sceneStrip) {
      // The scene owns bus and VCA structure; a track it does not map keeps
      // neither membership nor routing into structure that was replaced.
      const kept: EditorTrack = { ...track };
      delete kept.vcaId;
      if (track.mixer) kept.mixer = pruneStripBusReferences(track.mixer, busIds);
      return kept;
    }
    replacedTrackIds.add(track.id);
    const id = sceneId(sceneStrip);
    const outputBusId = id ? outputBusByStrip.get(id) : undefined;
    const mixer = sceneStripToMixerStrip(
      sceneStrip,
      busIds,
      validProcessors,
      outputBusId,
      sidechainBySceneId,
      track.kind === 'group' ? 'group' : 'track',
    );
    if (preserveTrackInserts) {
      // Keep the user's chain and its stable ids. A later suggestion replaces
      // the previous suggestion's processors instead of stacking duplicates.
      const userInserts = (track.mixer ? cloneStrip(track.mixer).inserts : []).filter(
        (slot) => slot.id?.startsWith(MIX_ASSISTANT_INSERT_PREFIX) !== true,
      );
      mixer.inserts = [
        ...userInserts,
        ...mixer.inserts.map((slot) => ({
          ...slot,
          id: `${MIX_ASSISTANT_INSERT_PREFIX}${slot.id ?? createProcessorId()}`,
        })),
      ];
    }
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
  if (masterBus) {
    applySceneBusStripFields(master, masterBus, validProcessors, sidechainBySceneId);
  }
  const masterLayout = sceneChannelLayout(masterBus?.layout);

  // Include group strips as topology nodes so a scene cannot restore a
  // reciprocal bus/group sidechain pair that the engine would reject.
  assertValidMixerBusTopology(
    mixerBusTopology(
      { buses: mixerBuses },
      nextTracks
        .filter((track) => track.kind === 'group')
        .map((track) => ({ id: track.id, mixer: track.mixer })),
    ),
  );
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
      ...(masterLayout !== undefined && masterLayout !== 'stereo' ? { masterLayout } : {}),
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
export function applyMixerSceneJson(
  sceneJson: string,
  options: { preserveTrackInserts?: boolean } = {},
): ApplyMixerSceneResult {
  const scene = parseSceneJson(sceneJson);
  const store = useProjectStore();
  const plan = buildScenePlan(
    scene,
    store.tracks,
    loadRealtimeInsertCatalog(),
    options.preserveTrackInserts === true,
  );
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
        const insert = parseInsertAutomationParam(lane.param);
        if (options.preserveTrackInserts === true) {
          return !insert?.processorId?.startsWith(MIX_ASSISTANT_INSERT_PREFIX);
        }
        return insert === undefined;
      }
      return true;
    });
    reconcileProcessorTargetReferences(store);
    reconcileStructureTargetReferences(store);
    store.refresh();
    return plan.result;
  });
}
