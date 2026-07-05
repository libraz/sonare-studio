import { isBusAutomationTarget } from '../automation';
import {
  cloneStrip,
  createDefaultStrip,
  type InsertSlot,
  MAX_MIXER_BUSES,
  MAX_STRIP_GAIN_DB,
  MAX_VCA_GROUPS,
  MIN_STRIP_GAIN_DB,
  type MixerBus,
  type MixerStrip,
  type PanLawId,
  type PanModeId,
  type ProjectMixerState,
  type StripSend,
} from '../mixer';
import { getWasmModule, useProjectStore } from '../store';
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
  muted?: unknown;
  soloed?: unknown;
  soloSafe?: unknown;
  sends?: unknown;
  inserts?: unknown;
}

interface SceneBus {
  id?: unknown;
  role?: unknown;
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
    if (validProcessors && !validProcessors.has(record.processor)) return [];
    const slot: InsertSlot = {
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
  if (inputTrimDb !== undefined && inputTrimDb !== 0) next.inputTrimDb = inputTrimDb;
  const width = finiteNumber(strip.width);
  if (width !== undefined && width !== 1) next.width = width;
  if (strip.polarityInvertLeft === true) next.polarityInvertLeft = true;
  if (strip.polarityInvertRight === true) next.polarityInvertRight = true;
  const channelDelaySamples = finiteNumber(strip.channelDelaySamples);
  if (channelDelaySamples !== undefined && channelDelaySamples !== 0) {
    next.channelDelaySamples = Math.max(0, Math.round(channelDelaySamples));
  }
  const panLaw = finiteNumber(strip.panLaw);
  if (panLaw !== undefined && PAN_LAW_FROM_SCENE[panLaw]) next.panLaw = PAN_LAW_FROM_SCENE[panLaw];
  const panMode = finiteNumber(strip.panMode);
  if (panMode !== undefined && PAN_MODE_FROM_SCENE[panMode]) {
    next.panMode = PAN_MODE_FROM_SCENE[panMode];
  }
  const dualPanLeft = finiteNumber(strip.dualPanLeft);
  const dualPanRight = finiteNumber(strip.dualPanRight);
  if (dualPanLeft !== undefined || dualPanRight !== undefined) {
    next.dualPan = {
      left: clamp(dualPanLeft ?? next.pan, -1, 1),
      right: clamp(dualPanRight ?? next.pan, -1, 1),
    };
  }
  next.inserts = sceneInserts(strip.inserts, validProcessors, sidechainBySceneId);
  next.sends = sceneSends(strip.sends, validBusIds);
  if (outputBusId !== undefined && validBusIds.has(outputBusId)) next.outputBusId = outputBusId;
  return next;
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

function buildScenePlan(
  scene: MixerScene,
  tracks: ReadonlyArray<EditorTrack>,
  validProcessors: ReadonlySet<string> | null,
): {
  mixer: ProjectMixerState;
  tracks: EditorTrack[];
  result: ApplyMixerSceneResult;
} {
  const stripsById = new Map<string, SceneStrip>();
  for (const strip of scene.strips) {
    const id = sceneId(strip);
    if (id) stripsById.set(id, strip);
  }

  const busEntries = scene.buses.filter((bus) => {
    if (typeof bus.id !== 'string' || bus.id === 'master') return false;
    return bus.role === 'aux' || bus.role === 'subgroup' || bus.role === undefined;
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
  const sidechainBySceneId = new Map<string, number>();
  for (let i = 0; i < Math.min(tracks.length, trackSceneStrips.length); i += 1) {
    const id = sceneId(trackSceneStrips[i]);
    if (id) sidechainBySceneId.set(id, tracks[i].id);
  }

  const mixerBuses: MixerBus[] = busEntries.map((bus) => {
    const busId = bus.id as string;
    const returnStrip = stripsById.get(returnStripByBus.get(busId) ?? '');
    const strip = returnStrip
      ? sceneStripToMixerStrip(returnStrip, busIds, validProcessors, undefined, sidechainBySceneId)
      : createDefaultStrip();
    const gainDb = strip.gainDb;
    strip.gainDb = 0;
    strip.pan = 0;
    return {
      id: busId,
      name: busDisplayName(busId) || busId,
      gainDb,
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

  const nextTracks = tracks.map((track, index) => {
    const sceneStrip = trackSceneStrips[index];
    if (!sceneStrip) return track;
    const id = sceneId(sceneStrip);
    const outputBusId = id && track.kind !== 'group' ? outputBusByStrip.get(id) : undefined;
    const next: EditorTrack = {
      ...track,
      mixer: sceneStripToMixerStrip(
        sceneStrip,
        busIds,
        validProcessors,
        outputBusId,
        track.kind === 'group' ? undefined : sidechainBySceneId,
      ),
      mute: booleanValue(sceneStrip.muted) ?? track.mute,
      solo: booleanValue(sceneStrip.soloed) ?? track.solo,
    };
    if (sceneStrip.soloSafe === true) next.soloSafe = true;
    else delete next.soloSafe;
    if (id && vcaByMember.has(id)) next.vcaId = vcaByMember.get(id);
    else delete next.vcaId;
    return next;
  });

  const masterBus = scene.buses.find((bus) => bus.id === 'master');
  const master = cloneStrip(createDefaultStrip());
  master.inserts = sceneInserts(masterBus?.inserts, validProcessors);

  return {
    mixer: {
      master,
      buses: mixerBuses,
      ...(vcaGroups.length > 0 ? { vcaGroups } : {}),
    },
    tracks: nextTracks,
    result: {
      trackCount: Math.min(tracks.length, trackSceneStrips.length),
      busCount: mixerBuses.length,
      vcaCount: vcaGroups.length,
    },
  };
}

/**
 * Applies a libsonare mixer-scene JSON template to the current project as one
 * undoable edit. Existing tracks are kept; scene strips are mapped onto them in
 * order, while scene buses/sends/VCA groups replace the project mixer template.
 */
export function applyMixerSceneJson(sceneJson: string): ApplyMixerSceneResult {
  const scene = parseSceneJson(sceneJson);
  const store = useProjectStore();
  const plan = buildScenePlan(scene, store.tracks, loadRealtimeInsertCatalog());
  return executeApp(() => {
    store.mixer = plan.mixer;
    store.tracks = plan.tracks;
    store.automationLanes = store.automationLanes.filter(
      (lane) => !isBusAutomationTarget(lane.target),
    );
    store.refresh();
    return plan.result;
  });
}
