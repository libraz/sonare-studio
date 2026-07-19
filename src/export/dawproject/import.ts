/**
 * Minimal DAWproject importer.
 *
 * This intentionally starts with the portable subset that sonare already
 * exports well: project title, transport tempo/meter, track/channel basics,
 * arrangement markers, MIDI and audio clips. Nested event timelines are
 * flattened into Sonare clips, standard beats-to-seconds Warps become Sonare
 * warp metadata, and referenced media is ingested separately because archives
 * may point at external paths.
 */

import { strFromU8 } from 'fflate';
import { linearToDb } from '@/lib/db';
import { preflightXmlBytes, preflightXmlDocument, XmlPreflightError } from '@/lib/xml-preflight';
import {
  ArchivePreflightError,
  preflightAndUnzip,
  preflightAndUnzipInWorker,
} from '@/persistence/archive-preflight';
import {
  MAX_DAWPROJECT_ARCHIVE_BYTES,
  MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
} from '@/persistence/resource-limits';
import { decodeAndIngest } from '@/project/audio-import';
import { type AutomationParam, insertAutomationParam } from '@/project/automation';
import {
  createDefaultStrip,
  type InsertSlot,
  type MixerBus,
  type StripSend,
  type VcaGroup,
} from '@/project/mixer';
import {
  type DocumentAutomationLane,
  type DocumentClip,
  type DocumentTempoSegment,
  type DocumentTimeSignature,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { type NormalizedTempoMap, normalizeTempoMap } from '@/project/tempo-map';
import { TRACK_COLOR_PALETTE, type TrackKind } from '@/project/types';
import {
  audioContentOriginFromPlayStartSeconds,
  audioContentOriginPpq,
  audioContentSecondsToPpq,
  audioFadeSecondsToPpq,
} from './audio-time';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_TEMPO = 120;
const DEFAULT_METER: DocumentTimeSignature = { startPpq: 0, numerator: 4, denominator: 4 };
const SONARE_DEVICE_VENDOR = 'sonare-studio';

export class DawprojectImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DawprojectImportError';
  }
}

/** One embedded DAWproject media file offered to the audio ingest callback. */
export interface DawprojectAudioMedia {
  /** Zip entry path referenced by the DAWproject File element. */
  path: string;
  /** True when the DAWproject File was marked external. */
  external: boolean;
  /** Best-effort display name for the stored asset. */
  name: string;
  /** Raw bytes of the embedded media file. */
  bytes: Uint8Array;
}

/** Options for {@link importDawprojectWithMedia}. */
export interface DawprojectImportOptions {
  /** Decodes/stores one embedded audio file and returns its asset id. */
  ingestAudio?: (media: DawprojectAudioMedia) => Promise<{ id: string }>;
  /** Resolves an external File path to raw bytes. Omitted paths stay placement-only. */
  resolveExternalAudio?: (path: string) => Promise<Uint8Array | null | undefined>;
  /** Cancels archive/media processing between every asynchronous boundary. */
  signal?: AbortSignal;
}

export interface DawprojectMediaIssue {
  path: string;
  external: boolean;
  reason: 'missing' | 'resolve-failed' | 'ingest-failed';
  message?: string;
}

export interface DawprojectImportResult {
  document: ProjectDocument;
  media: {
    imported: string[];
    issues: DawprojectMediaIssue[];
  };
  losses: DawprojectImportLoss[];
}

/** A DAWproject value that could not be interpreted without a lossy fallback. */
export type DawprojectImportLoss =
  | {
      kind: 'unsupported-time-unit';
      clipName: string;
      attribute: 'contentTimeUnit' | 'fadeTimeUnit';
      unit: string;
    }
  | {
      kind: 'unsupported-warp';
      clipName: string;
      reason: 'time-units' | 'insufficient-points' | 'non-monotonic';
      timeUnit?: string;
      contentTimeUnit?: string;
    }
  | {
      kind: 'unsupported-nested-clip';
      clipName: string;
      reason: 'mixed-time-units' | 'loop-with-multiple-events' | 'missing-content';
    };

function parseXml(bytes: Uint8Array, entryName: string): Document {
  let doc: Document;
  try {
    preflightXmlBytes(bytes.byteLength, entryName);
    doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
    preflightXmlDocument(doc, entryName);
  } catch (error) {
    if (error instanceof XmlPreflightError) {
      throw new DawprojectImportError(`Invalid DAWproject archive: ${error.message}`);
    }
    throw error;
  }
  if (doc.querySelector('parsererror')) {
    throw new DawprojectImportError(`Invalid DAWproject archive: ${entryName} is not valid XML`);
  }
  return doc;
}

function children(element: Element | null | undefined, name?: string): Element[] {
  if (!element) return [];
  return Array.from(element.children).filter((child) => !name || child.tagName === name);
}

function numberAttr(element: Element | null | undefined, name: string): number | null {
  const raw = element?.getAttribute(name);
  if (raw === null || raw === undefined) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function boolAttr(element: Element | null | undefined, name: string): boolean {
  return element?.getAttribute(name) === 'true';
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizedVelocity(value: number | null): number {
  if (value === null) return 96;
  return clampInt(value * 127, 1, 127);
}

function readTitle(project: Document, metadata: Document | null): string {
  const fromMeta = metadata?.querySelector('MetaData > Title')?.textContent?.trim();
  if (fromMeta) return fromMeta;
  const application = project.querySelector('Project > Application');
  return application?.getAttribute('name')?.trim() || 'Imported DAWproject';
}

function fileNameFromPath(path: string): string {
  const clean = path.replaceAll('\\', '/');
  const slash = clean.lastIndexOf('/');
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || 'Imported audio';
}

interface ImportedTrack {
  id: string;
  channelId: string;
  destination: string | null;
  name: string;
  kind: TrackKind;
  role: string;
  /** Foreign effect channels canonicalized as mixer buses, not project tracks. */
  isEffectBus: boolean;
  color: string;
  mute: boolean;
  solo: boolean;
  volume: number;
  sonareVolume?: number;
  pan: number;
  clips: DocumentClip[];
  groupIndex?: number;
  vcaId?: string;
  mixerOutputBusId?: string;
  sendRefs: DawprojectSendRef[];
  mixerSends?: StripSend[];
  inserts: InsertSlot[];
  mixerBusId?: string;
  automation: DocumentAutomationLane[];
  automationRefs: Map<string, AutomationParameterRef>;
}

interface DawprojectSendRef {
  destination: string;
  levelDb: number;
  enabled: boolean;
  timing?: 'preFader';
}

interface AutomationParameterRef {
  param: AutomationParam;
  fromDawValue(value: number): number;
}

interface ImportedMaster {
  trackId: string;
  strip: ReturnType<typeof createDefaultStrip>;
  automationRefs: Map<string, AutomationParameterRef>;
}

function readSendRefs(channel: Element | null | undefined): DawprojectSendRef[] {
  return children(children(channel, 'Sends')[0], 'Send')
    .map((send) => {
      const destination = send.getAttribute('destination')?.trim();
      if (!destination) return null;
      const type = send.getAttribute('type');
      return {
        destination,
        levelDb: linearToDb(Math.max(0, numberAttr(send.querySelector('Volume'), 'value') ?? 1)),
        enabled: !boolAttr(send.querySelector('Mute'), 'value'),
        ...(type === 'pre' ? { timing: 'preFader' as const } : {}),
      };
    })
    .filter((send): send is DawprojectSendRef => send !== null);
}

function readInsertDevices(
  channel: Element | null | undefined,
  allowSidechain = true,
): InsertSlot[] {
  return children(children(channel, 'Devices')[0])
    .map((device): InsertSlot | null => {
      if (device.tagName !== 'BuiltinDevice') return null;
      if (device.getAttribute('deviceVendor') !== SONARE_DEVICE_VENDOR) return null;
      const processor = device.getAttribute('deviceName')?.trim();
      if (!processor) return null;
      const params: Record<string, number | boolean> = {};
      for (const parameter of children(children(device, 'Parameters')[0])) {
        const name = parameter.getAttribute('name')?.trim();
        if (!name) continue;
        if (parameter.tagName === 'RealParameter') {
          const value = numberAttr(parameter, 'value');
          if (value !== null) params[name] = value;
        } else if (parameter.tagName === 'BoolParameter') {
          params[name] = boolAttr(parameter, 'value');
        }
      }
      const slot: InsertSlot & { sidechainSourceIndex?: number } = {
        processor,
        params,
        enabled:
          !device.querySelector('Enabled') || boolAttr(device.querySelector('Enabled'), 'value'),
      };
      const sidechainSourceIndex = numberAttr(device, 'sonareSidechainSourceIndex');
      if (
        allowSidechain &&
        typeof sidechainSourceIndex === 'number' &&
        Number.isInteger(sidechainSourceIndex) &&
        sidechainSourceIndex >= 0
      ) {
        slot.sidechainSourceIndex = sidechainSourceIndex;
      }
      return slot;
    })
    .filter((slot): slot is InsertSlot => slot !== null);
}

function readSonareVcaGroups(project: Document): VcaGroup[] {
  return children(project.querySelector('Structure > SonareVcaGroups'), 'SonareVcaGroup')
    .map((group): VcaGroup | null => {
      const id = group.getAttribute('id')?.trim();
      if (!id) return null;
      return {
        id,
        name: group.getAttribute('name')?.trim() || id,
        gainDb: numberAttr(group, 'gainDb') ?? 0,
        ...(boolAttr(group, 'mute') ? { mute: true } : {}),
        ...(boolAttr(group, 'solo') ? { solo: true } : {}),
      };
    })
    .filter((group): group is VcaGroup => group !== null);
}

function panFromNormalized(value: number): number {
  return Math.min(1, Math.max(-1, value * 2 - 1));
}

function readAutomationParameterRefs(
  channel: Element | null | undefined,
): Map<string, AutomationParameterRef> {
  const refs = new Map<string, AutomationParameterRef>();
  // Read only the channel's own direct Volume/Pan: querySelector would descend
  // into the Sends emitted earlier in the channel and grab a send's nested
  // Volume instead, mapping fader automation to the wrong parameter id.
  const volumeId = children(channel, 'Volume')[0]?.getAttribute('id')?.trim();
  if (volumeId)
    refs.set(volumeId, { param: 'faderDb', fromDawValue: (value) => linearToDb(value) });
  const panId = children(channel, 'Pan')[0]?.getAttribute('id')?.trim();
  if (panId) refs.set(panId, { param: 'pan', fromDawValue: panFromNormalized });

  let insertIndex = 0;
  for (const device of children(children(channel, 'Devices')[0])) {
    if (device.tagName !== 'BuiltinDevice') continue;
    if (device.getAttribute('deviceVendor') !== SONARE_DEVICE_VENDOR) continue;
    const processor = device.getAttribute('deviceName')?.trim();
    if (!processor) continue;
    for (const parameter of children(children(device, 'Parameters')[0])) {
      if (parameter.tagName !== 'RealParameter' && parameter.tagName !== 'BoolParameter') continue;
      const id = parameter.getAttribute('id')?.trim();
      const name = parameter.getAttribute('name')?.trim();
      if (!id || !name) continue;
      refs.set(id, {
        param: insertAutomationParam(insertIndex, name),
        fromDawValue:
          parameter.tagName === 'BoolParameter'
            ? (value) => (value >= 0.5 ? 1 : 0)
            : (value) => value,
      });
    }
    insertIndex += 1;
  }
  return refs;
}

function readTracks(
  project: Document,
  validVcaIds: ReadonlySet<string> = new Set(),
): ImportedTrack[] {
  const tracks: ImportedTrack[] = [];
  let fallbackIndex = 0;

  function visit(track: Element, parentGroupIndex?: number): void {
    const channel = children(track, 'Channel')[0];
    const contentType = track.getAttribute('contentType');
    const role = channel?.getAttribute('role');
    const sonareTrackKind = track.getAttribute('sonareTrackKind');
    if (role === 'master') return;
    const pan = numberAttr(children(channel, 'Pan')[0], 'value');
    const kind: TrackKind =
      contentType === 'tracks'
        ? 'group'
        : role === 'effect'
          ? 'aux'
          : contentType === 'notes'
            ? 'midi'
            : 'audio';
    const index = fallbackIndex++;
    const groupIndex = kind === 'group' ? undefined : parentGroupIndex;
    // Direct child only: a Send nested inside <Sends> also carries a <Volume>,
    // and querySelector would return that send level as the track's fader gain.
    const channelVolume = Math.max(0, numberAttr(children(channel, 'Volume')[0], 'value') ?? 1);
    const sonareVcaId = track.getAttribute('sonareVcaId')?.trim();
    const vcaId = sonareVcaId && validVcaIds.has(sonareVcaId) ? sonareVcaId : undefined;
    const sonareVolume = numberAttr(track, 'sonareVolume');
    tracks.push({
      id: track.getAttribute('id') || `track-${index}`,
      channelId: channel?.getAttribute('id') || `channel-${index}`,
      destination: channel?.getAttribute('destination') ?? null,
      name: track.getAttribute('name') || `Track ${tracks.length + 1}`,
      kind,
      role: role ?? 'regular',
      isEffectBus: role === 'effect' && sonareTrackKind !== 'aux',
      color:
        track.getAttribute('color') ||
        TRACK_COLOR_PALETTE[tracks.length % TRACK_COLOR_PALETTE.length],
      mute: boolAttr(children(channel, 'Mute')[0], 'value'),
      solo: boolAttr(channel, 'solo'),
      volume:
        vcaId !== undefined && sonareVolume !== null ? Math.max(0, sonareVolume) : channelVolume,
      ...(sonareVolume !== null ? { sonareVolume } : {}),
      // Group-channel pan cannot be represented by Sonare's current group-bus
      // DSP. Center it at the import boundary instead of persisting a silent
      // control. Regular track pan is promoted into MixerStrip.pan on load.
      pan: kind === 'group' || pan === null ? 0 : Math.min(1, Math.max(-1, pan * 2 - 1)),
      clips: [],
      sendRefs: readSendRefs(channel),
      inserts: readInsertDevices(channel, kind !== 'group'),
      automation: [],
      automationRefs: readAutomationParameterRefs(channel),
      ...(groupIndex !== undefined ? { groupIndex } : {}),
      ...(vcaId !== undefined ? { vcaId } : {}),
    });
    const currentIndex = tracks.length - 1;
    for (const child of children(track, 'Track')) {
      visit(child, kind === 'group' ? currentIndex : parentGroupIndex);
    }
  }

  for (const track of children(project.querySelector('Structure'), 'Track')) {
    visit(track);
  }
  return tracks;
}

function readMaster(project: Document): ImportedMaster {
  const masterTrack = Array.from(project.querySelectorAll('Structure Track')).find((track) => {
    return children(track, 'Channel')[0]?.getAttribute('role') === 'master';
  });
  const masterChannel = children(masterTrack, 'Channel')[0];
  const strip = createDefaultStrip();
  strip.inserts = readInsertDevices(masterChannel);
  return {
    trackId: masterTrack?.getAttribute('id') || 'master-track',
    strip,
    automationRefs: readAutomationParameterRefs(masterChannel),
  };
}

function scrubImportedSidechainSourceIndexes(
  tracks: ImportedTrack[],
  master: ReturnType<typeof createDefaultStrip>,
): void {
  const trackCount = tracks.length;
  const scrubStrip = (strip: { inserts: InsertSlot[] }): void => {
    for (const slot of strip.inserts) {
      const sourceIndex = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      if (
        typeof sourceIndex !== 'number' ||
        !Number.isInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= trackCount
      ) {
        delete (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      }
    }
  };
  for (const track of tracks) scrubStrip(track);
  scrubStrip(master);
}

function applyMixerRouting(
  tracks: ImportedTrack[],
  master: ReturnType<typeof createDefaultStrip>,
  vcaGroups: VcaGroup[],
): ProjectDocument['mixer'] | undefined {
  const buses: MixerBus[] = [];
  const busByChannelId = new Map<string, string>();
  for (const track of tracks) {
    if (!track.isEffectBus) continue;
    const busId = `daw-bus-${buses.length + 1}`;
    track.mixerBusId = busId;
    busByChannelId.set(track.channelId, busId);
    const strip = createDefaultStrip();
    strip.pan = track.pan;
    strip.inserts = track.inserts;
    buses.push({
      id: busId,
      name: track.name,
      gainDb: linearToDb(track.volume),
      ...(track.pan !== 0 || track.inserts.length > 0 ? { strip } : {}),
    });
  }
  const hasMasterState = master.inserts.length > 0;
  if (buses.length === 0 && !hasMasterState && vcaGroups.length === 0) return undefined;
  for (const track of tracks) {
    if (track.isEffectBus) continue;
    if (track.destination !== null) {
      const busId = busByChannelId.get(track.destination);
      if (busId) track.mixerOutputBusId = busId;
    }
    const sends = track.sendRefs.flatMap((send): StripSend[] => {
      const busId = busByChannelId.get(send.destination);
      return busId
        ? [
            {
              busId,
              levelDb: send.levelDb,
              enabled: send.enabled,
              ...(send.timing ? { timing: send.timing } : {}),
            },
          ]
        : [];
    });
    if (sends.length > 0) track.mixerSends = sends;
  }
  return { master, buses, ...(vcaGroups.length > 0 ? { vcaGroups } : {}) };
}

function importedTrackMixer(track: ImportedTrack): {
  mixer?: ReturnType<typeof createDefaultStrip>;
} {
  if (
    track.isEffectBus ||
    (track.mixerOutputBusId === undefined &&
      track.mixerSends === undefined &&
      track.inserts.length === 0)
  ) {
    return {};
  }
  const mixer = createDefaultStrip();
  if (track.mixerOutputBusId !== undefined) mixer.outputBusId = track.mixerOutputBusId;
  if (track.mixerSends !== undefined) mixer.sends = track.mixerSends;
  mixer.inserts = track.inserts;
  return { mixer };
}

function readTempo(project: Document): DocumentTempoSegment[] {
  const transportTempo =
    numberAttr(project.querySelector('Transport > Tempo'), 'value') ?? DEFAULT_TEMPO;
  const points = Array.from(project.querySelectorAll('Arrangement > TempoAutomation > RealPoint'))
    .map((point) => ({
      time: numberAttr(point, 'time'),
      value: numberAttr(point, 'value'),
      interpolation: point.getAttribute('interpolation') ?? 'hold',
    }))
    .filter((point): point is { time: number; value: number; interpolation: string } => {
      return point.time !== null && point.value !== null && point.value > 0;
    })
    .sort((a, b) => a.time - b.time);
  if (points.length === 0) return [{ startPpq: 0, bpm: transportTempo }];

  const grouped = new Map<number, (typeof points)[number][]>();
  for (const point of points) {
    const group = grouped.get(point.time);
    if (group) group.push(point);
    else grouped.set(point.time, [point]);
  }

  return [...grouped.entries()].map(([time, group]) => {
    const point = group[group.length - 1];
    const segment: DocumentTempoSegment = { startPpq: time, bpm: point.value };
    if (point.interpolation === 'linear') {
      const end = points.find((candidate) => candidate.time > time);
      if (end) segment.endBpm = end.value;
    }
    return segment;
  });
}

function readTimeSignatures(project: Document): DocumentTimeSignature[] {
  const points = Array.from(
    project.querySelectorAll('Arrangement > TimeSignatureAutomation > TimeSignaturePoint'),
  )
    .map((point) => ({
      startPpq: numberAttr(point, 'time'),
      numerator: numberAttr(point, 'numerator'),
      denominator: numberAttr(point, 'denominator'),
    }))
    .filter(
      (point): point is DocumentTimeSignature =>
        point.startPpq !== null &&
        point.numerator !== null &&
        point.denominator !== null &&
        point.numerator > 0 &&
        point.denominator > 0,
    );
  if (points.length > 0) return points;

  const transport = project.querySelector('Transport > TimeSignature');
  return [
    {
      startPpq: 0,
      numerator: numberAttr(transport, 'numerator') ?? DEFAULT_METER.numerator,
      denominator: numberAttr(transport, 'denominator') ?? DEFAULT_METER.denominator,
    },
  ];
}

interface FlattenedClipPlacement {
  startPpq: number;
  lengthPpq: number;
  /** Visible start in this clip's content coordinate. */
  contentWindowStart: number;
  contentTimeUnit: string;
  name: string;
  loopEnabled?: boolean;
  loopLengthPpq?: number;
  fadeElement: Element;
}

interface FlattenedClipLeaf {
  element: Element;
  placement: FlattenedClipPlacement;
}

function clipLoopState(
  clip: Element,
  inherited?: Pick<FlattenedClipPlacement, 'loopEnabled' | 'loopLengthPpq'>,
): Pick<FlattenedClipPlacement, 'loopEnabled' | 'loopLengthPpq'> {
  const contentTimeUnit = clip.getAttribute('contentTimeUnit')?.trim() || 'beats';
  const loopStart = numberAttr(clip, 'loopStart');
  const loopEnd = numberAttr(clip, 'loopEnd');
  if (
    contentTimeUnit === 'beats' &&
    loopStart !== null &&
    loopEnd !== null &&
    loopEnd > loopStart
  ) {
    return { loopEnabled: true, loopLengthPpq: loopEnd - loopStart };
  }
  return inherited
    ? {
        ...(inherited.loopEnabled !== undefined ? { loopEnabled: inherited.loopEnabled } : {}),
        ...(inherited.loopLengthPpq !== undefined
          ? { loopLengthPpq: inherited.loopLengthPpq }
          : {}),
      }
    : {};
}

/**
 * Flattens nested DAWproject clip timelines by recursively composing each
 * parent's visible content window with its child event placement. DAWproject
 * permits this structure (DAWs commonly emit an outer arrangement clip
 * containing one inner audio event); Sonare stores the resulting audible
 * events as ordinary flat clips.
 */
function flattenClipLeaves(root: Element, losses: DawprojectImportLoss[]): FlattenedClipLeaf[] {
  const rootStart = numberAttr(root, 'time') ?? 0;
  const rootLength = Math.max(0.0001, numberAttr(root, 'duration') ?? 4);
  const rootName = root.getAttribute('name') || 'Audio clip';
  const rootUnit = root.getAttribute('contentTimeUnit')?.trim() || 'beats';
  const rootLoop = clipLoopState(root);
  const initial: FlattenedClipPlacement = {
    startPpq: rootStart,
    lengthPpq: rootLength,
    contentWindowStart: numberAttr(root, 'playStart') ?? 0,
    contentTimeUnit: rootUnit,
    name: rootName,
    ...rootLoop,
    fadeElement: root,
  };

  const walk = (clip: Element, placement: FlattenedClipPlacement): FlattenedClipLeaf[] => {
    const nested = children(children(clip, 'Clips')[0], 'Clip');
    if (nested.length === 0) {
      // A content-less audio Clip is still a valid placement placeholder when
      // its external media is unavailable, so it must survive for relinking.
      return [{ element: clip, placement }];
    }
    if (placement.contentTimeUnit !== 'beats') {
      losses.push({
        kind: 'unsupported-nested-clip',
        clipName: placement.name,
        reason: 'mixed-time-units',
      });
      return [];
    }
    if (placement.loopEnabled && nested.length > 1) {
      losses.push({
        kind: 'unsupported-nested-clip',
        clipName: placement.name,
        reason: 'loop-with-multiple-events',
      });
    }

    const windowStart = placement.contentWindowStart;
    const windowEnd = windowStart + placement.lengthPpq;
    return nested.flatMap((child): FlattenedClipLeaf[] => {
      const childTime = numberAttr(child, 'time') ?? 0;
      const childLength = Math.max(0.0001, numberAttr(child, 'duration') ?? placement.lengthPpq);
      const visibleStart = Math.max(windowStart, childTime);
      const visibleEnd = Math.min(windowEnd, childTime + childLength);
      if (!(visibleEnd > visibleStart)) return [];
      const childUnit = child.getAttribute('contentTimeUnit')?.trim() || 'beats';
      const childLoop = clipLoopState(child, placement);
      return walk(child, {
        startPpq: placement.startPpq + visibleStart - windowStart,
        lengthPpq: visibleEnd - visibleStart,
        contentWindowStart: (numberAttr(child, 'playStart') ?? 0) + (visibleStart - childTime),
        contentTimeUnit: childUnit,
        name: child.getAttribute('name') || placement.name,
        ...childLoop,
        fadeElement:
          child.hasAttribute('fadeInTime') || child.hasAttribute('fadeOutTime')
            ? child
            : placement.fadeElement,
      });
    });
  };

  return walk(root, initial);
}

function readMidiClip(clip: Element, placement?: FlattenedClipPlacement): DocumentClip {
  const playStart = placement?.contentWindowStart ?? numberAttr(clip, 'playStart') ?? 0;
  const loopStart = numberAttr(clip, 'loopStart');
  const loopEnd = numberAttr(clip, 'loopEnd');
  const out: DocumentClip = {
    name: placement?.name ?? clip.getAttribute('name') ?? 'MIDI clip',
    startPpq: placement?.startPpq ?? numberAttr(clip, 'time') ?? 0,
    lengthPpq: placement?.lengthPpq ?? Math.max(0.0001, numberAttr(clip, 'duration') ?? 4),
    sourceOffsetPpq: playStart,
    gain: 1,
    loopEnabled:
      placement?.loopEnabled ?? (loopStart !== null && loopEnd !== null && loopEnd > loopStart),
    loopLengthPpq:
      placement?.loopLengthPpq ??
      (loopStart !== null && loopEnd !== null ? Math.max(0, loopEnd - loopStart) : 0),
    kind: 'midi',
    notes: Array.from(clip.querySelectorAll('Notes > Note')).map((note) => {
      const rel = numberAttr(note, 'rel');
      return {
        pitch: clampInt(numberAttr(note, 'key') ?? 60, 0, 127),
        velocity: normalizedVelocity(numberAttr(note, 'vel')),
        startPpq: Math.max(0, numberAttr(note, 'time') ?? 0),
        durationPpq: Math.max(0.0001, numberAttr(note, 'duration') ?? 1),
        channel: clampInt(numberAttr(note, 'channel') ?? 0, 0, 15),
        // Only materialize a release velocity when the note declares one, so an
        // absent 'rel' stays absent instead of defaulting to a fixed value.
        ...(rel !== null ? { offVelocity: clampInt(rel * 127, 1, 127) } : {}),
      };
    }),
  };
  readMidiExpressionPoints(clip, out);
  return out;
}

function readRealPoints(points: Element): Array<{ ppq: number; value: number }> {
  return children(points, 'RealPoint')
    .map((point) => ({
      ppq: numberAttr(point, 'time'),
      value: numberAttr(point, 'value'),
    }))
    .filter((point): point is { ppq: number; value: number } => {
      return point.ppq !== null && point.value !== null;
    });
}

function readMidiExpressionPoints(clipElement: Element, clip: DocumentClip): void {
  const ccLanes: NonNullable<DocumentClip['ccLanes']> = [];
  const pitchBendLanes: NonNullable<DocumentClip['pitchBendLanes']> = [];
  const programChangeLanes: NonNullable<DocumentClip['programChangeLanes']> = [];
  const channelPressureLanes: NonNullable<DocumentClip['channelPressureLanes']> = [];
  const polyPressureLanes: NonNullable<DocumentClip['polyPressureLanes']> = [];
  for (const points of children(clipElement, 'Points')) {
    const target = points.querySelector('Target')?.getAttribute('parameter')?.trim() ?? '';
    const parts = target.split('.');
    if (parts[0] !== 'midi') continue;
    const realPoints = readRealPoints(points);
    if (realPoints.length === 0) continue;
    if (parts[1] === 'cc' && parts.length === 4) {
      ccLanes.push({
        channel: clampInt(Number(parts[2]), 0, 15),
        controller: clampInt(Number(parts[3]), 0, 127),
        points: realPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 127),
        })),
      });
    } else if (parts[1] === 'pitchBend' && parts.length === 3) {
      pitchBendLanes.push({
        channel: clampInt(Number(parts[2]), 0, 15),
        points: realPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 16383),
        })),
      });
    } else if (parts[1] === 'program' && parts.length === 3) {
      programChangeLanes.push({
        channel: clampInt(Number(parts[2]), 0, 15),
        points: realPoints.map((point) => ({
          ppq: point.ppq,
          program: clampInt(point.value, 0, 127),
        })),
      });
    } else if (parts[1] === 'channelPressure' && parts.length === 3) {
      channelPressureLanes.push({
        channel: clampInt(Number(parts[2]), 0, 15),
        points: realPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 127),
        })),
      });
    } else if (parts[1] === 'polyPressure' && parts.length === 4) {
      polyPressureLanes.push({
        channel: clampInt(Number(parts[2]), 0, 15),
        pitch: clampInt(Number(parts[3]), 0, 127),
        points: realPoints.map((point) => ({
          ppq: point.ppq,
          value: clampInt(point.value, 0, 127),
        })),
      });
    }
  }
  if (ccLanes.length > 0) clip.ccLanes = ccLanes;
  if (pitchBendLanes.length > 0) clip.pitchBendLanes = pitchBendLanes;
  if (programChangeLanes.length > 0) clip.programChangeLanes = programChangeLanes;
  if (channelPressureLanes.length > 0) clip.channelPressureLanes = channelPressureLanes;
  if (polyPressureLanes.length > 0) clip.polyPressureLanes = polyPressureLanes;
}

interface DawprojectAudioFileRef {
  path: string;
  external: boolean;
}

function audioFileRef(clip: Element): DawprojectAudioFileRef | null {
  const warps = children(clip, 'Warps')[0];
  const audio = children(clip, 'Audio')[0] ?? children(warps, 'Audio')[0];
  const file = children(audio, 'File')[0];
  if (!file) return null;
  const path = file.getAttribute('path')?.trim();
  const external = file.getAttribute('external') === 'true';
  if (!path) return null;
  if (!external && path.startsWith('/')) return null;
  return { path, external };
}

function reportUnknownTimeUnit(
  clip: Element,
  attribute: Extract<DawprojectImportLoss, { kind: 'unsupported-time-unit' }>['attribute'],
  supported: readonly string[],
  losses: DawprojectImportLoss[],
): string | null {
  const unit = clip.getAttribute(attribute)?.trim() || null;
  if (unit !== null && !supported.includes(unit)) {
    losses.push({
      kind: 'unsupported-time-unit',
      clipName: clip.getAttribute('name') || 'Audio clip',
      attribute,
      unit,
    });
  }
  return unit;
}

function clipContentPpq(
  clip: Element,
  attr: string,
  tempoMap: NormalizedTempoMap,
  contentOriginPpq: number,
  contentTimeUnit: string | null,
): number | null {
  const value = numberAttr(clip, attr);
  if (value === null) return null;
  return contentTimeUnit === 'seconds'
    ? audioContentSecondsToPpq(tempoMap, contentOriginPpq, value)
    : value;
}

function clipFadePpq(
  clip: Element,
  attr: 'fadeInTime' | 'fadeOutTime',
  tempoMap: NormalizedTempoMap,
  startPpq: number,
  lengthPpq: number,
  fadeTimeUnit: string | null,
): number | null {
  const value = numberAttr(clip, attr);
  if (value === null || value <= 0) return null;
  return fadeTimeUnit === 'seconds'
    ? audioFadeSecondsToPpq(
        tempoMap,
        startPpq,
        lengthPpq,
        value,
        attr === 'fadeInTime' ? 'in' : 'out',
      )
    : value;
}

function readAudioClip(
  clip: Element,
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string> = new Map(),
  losses: DawprojectImportLoss[] = [],
  placement?: FlattenedClipPlacement,
): DocumentClip {
  const file = audioFileRef(clip);
  const startPpq = placement?.startPpq ?? numberAttr(clip, 'time') ?? 0;
  const lengthPpq = placement?.lengthPpq ?? Math.max(0.0001, numberAttr(clip, 'duration') ?? 4);
  const contentTimeUnit = reportUnknownTimeUnit(
    clip,
    'contentTimeUnit',
    ['beats', 'seconds'],
    losses,
  );
  const playStartValue = placement?.contentWindowStart ?? numberAttr(clip, 'playStart') ?? 0;
  const contentOriginPpq =
    contentTimeUnit === 'seconds'
      ? audioContentOriginFromPlayStartSeconds(tempoMap, startPpq, playStartValue)
      : audioContentOriginPpq(startPpq, Math.max(0, playStartValue));
  const playStart = clipContentPpq(clip, 'playStart', tempoMap, contentOriginPpq, contentTimeUnit);
  const loopStart = clipContentPpq(clip, 'loopStart', tempoMap, contentOriginPpq, contentTimeUnit);
  const loopEnd = clipContentPpq(clip, 'loopEnd', tempoMap, contentOriginPpq, contentTimeUnit);
  const fadeElement = placement?.fadeElement ?? clip;
  const fadeTimeUnit = reportUnknownTimeUnit(
    fadeElement,
    'fadeTimeUnit',
    ['beats', 'seconds'],
    losses,
  );
  const fadeInPpq = clipFadePpq(
    fadeElement,
    'fadeInTime',
    tempoMap,
    startPpq,
    lengthPpq,
    fadeTimeUnit,
  );
  const fadeOutPpq = clipFadePpq(
    fadeElement,
    'fadeOutTime',
    tempoMap,
    startPpq,
    lengthPpq,
    fadeTimeUnit,
  );
  const warp = readAudioWarp(clip, placement, lengthPpq, losses);
  return {
    name: placement?.name ?? clip.getAttribute('name') ?? 'Audio clip',
    startPpq,
    lengthPpq,
    sourceOffsetPpq: Math.max(0, warp?.sourceOffsetPpq ?? playStart ?? 0),
    gain: 1,
    loopEnabled:
      placement?.loopEnabled ?? (loopStart !== null && loopEnd !== null && loopEnd > loopStart),
    loopLengthPpq:
      placement?.loopLengthPpq ??
      (loopStart !== null && loopEnd !== null ? Math.max(0, loopEnd - loopStart) : 0),
    kind: 'audio',
    notes: [],
    ...(file && mediaAssets.has(file.path)
      ? { assetId: mediaAssets.get(file.path) as string }
      : {}),
    ...(fadeInPpq !== null ? { fadeInPpq } : {}),
    ...(fadeOutPpq !== null ? { fadeOutPpq } : {}),
    ...(warp ? { warp: warp.warp } : {}),
  };
}

function readAudioWarp(
  clip: Element,
  placement: FlattenedClipPlacement | undefined,
  lengthPpq: number,
  losses: DawprojectImportLoss[],
): { sourceOffsetPpq: number; warp: NonNullable<DocumentClip['warp']> } | null {
  const warps = children(clip, 'Warps')[0];
  if (!warps) return null;
  const timeUnit = warps.getAttribute('timeUnit')?.trim() || 'beats';
  const contentTimeUnit = warps.getAttribute('contentTimeUnit')?.trim() || 'seconds';
  const clipName = placement?.name ?? clip.getAttribute('name') ?? 'Audio clip';
  if (timeUnit !== 'beats' || contentTimeUnit !== 'seconds') {
    losses.push({
      kind: 'unsupported-warp',
      clipName,
      reason: 'time-units',
      timeUnit,
      contentTimeUnit,
    });
    return null;
  }
  const points = children(warps, 'Warp')
    .map((point) => ({
      time: numberAttr(point, 'time'),
      contentTime: numberAttr(point, 'contentTime'),
    }))
    .filter(
      (point): point is { time: number; contentTime: number } =>
        point.time !== null && point.contentTime !== null,
    )
    .sort((a, b) => a.time - b.time);
  if (points.length < 2) {
    losses.push({ kind: 'unsupported-warp', clipName, reason: 'insufficient-points' });
    return null;
  }
  if (
    points.some(
      (point, index) =>
        index > 0 &&
        (point.time <= points[index - 1].time ||
          point.contentTime <= points[index - 1].contentTime),
    )
  ) {
    losses.push({ kind: 'unsupported-warp', clipName, reason: 'non-monotonic' });
    return null;
  }
  const interpolate = (time: number): number | null => {
    for (let index = 0; index < points.length - 1; index += 1) {
      const left = points[index];
      const right = points[index + 1];
      if (time < left.time || time > right.time) continue;
      const ratio = (time - left.time) / (right.time - left.time);
      return left.contentTime + (right.contentTime - left.contentTime) * ratio;
    }
    return null;
  };
  const windowStart = placement?.contentWindowStart ?? numberAttr(clip, 'playStart') ?? 0;
  const windowEnd = windowStart + lengthPpq;
  const sourceStartSeconds = interpolate(windowStart);
  const sourceEndSeconds = interpolate(windowEnd);
  if (
    sourceStartSeconds === null ||
    sourceEndSeconds === null ||
    !(sourceEndSeconds > sourceStartSeconds)
  ) {
    losses.push({ kind: 'unsupported-warp', clipName, reason: 'insufficient-points' });
    return null;
  }
  const sourceBpm = (60 * lengthPpq) / (sourceEndSeconds - sourceStartSeconds);
  const anchors = points
    .filter((point) => point.time > windowStart && point.time < windowEnd)
    .map((point) => ({
      ppq: point.time - windowStart,
      sourceSeconds: point.contentTime - sourceStartSeconds,
    }));
  return {
    sourceOffsetPpq: (sourceStartSeconds * sourceBpm) / 60,
    warp: {
      enabled: true,
      sourceBpm,
      ...(anchors.length > 0 ? { anchors } : {}),
    },
  };
}

function attachArrangementClips(
  project: Document,
  tracks: ImportedTrack[],
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string> = new Map(),
  losses: DawprojectImportLoss[] = [],
): void {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  for (const lane of children(arrangementLanes, 'Lanes')) {
    const track = byId.get(lane.getAttribute('track') ?? '');
    if (!track) continue;
    const clips = children(children(lane, 'Clips')[0], 'Clip');
    for (const clip of clips) {
      for (const leaf of flattenClipLeaves(clip, losses)) {
        track.clips.push(
          children(leaf.element, 'Notes').length > 0
            ? readMidiClip(leaf.element, leaf.placement)
            : readAudioClip(leaf.element, tempoMap, mediaAssets, losses, leaf.placement),
        );
      }
    }
  }
}

function readAutomationLane(
  points: Element,
  refs: ReadonlyMap<string, AutomationParameterRef>,
): DocumentAutomationLane | null {
  const parameter = points.querySelector('Target')?.getAttribute('parameter')?.trim();
  if (!parameter) return null;
  const ref = refs.get(parameter);
  if (!ref) return null;
  const automationPoints: DocumentAutomationLane['points'] = [];
  for (const point of children(points, 'RealPoint')) {
    const ppq = numberAttr(point, 'time');
    const value = numberAttr(point, 'value');
    if (ppq === null || value === null) continue;
    automationPoints.push({
      ppq,
      value: ref.fromDawValue(value),
      ...(point.getAttribute('interpolation') === 'hold'
        ? { curve: 'hold' as const }
        : { curve: 'linear' as const }),
    });
  }
  return automationPoints.length > 0
    ? { param: ref.param, points: automationPoints, enabled: true }
    : null;
}

function attachArrangementAutomation(
  project: Document,
  tracks: ImportedTrack[],
  mixer: ProjectDocument['mixer'] | undefined,
  master: ImportedMaster,
): DocumentAutomationLane[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const masterAutomation: DocumentAutomationLane[] = [];
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  for (const lane of children(arrangementLanes, 'Lanes')) {
    const laneTrackId = lane.getAttribute('track') ?? '';
    const points = children(lane, 'Points');
    if (points.length === 0) continue;
    const track = byId.get(laneTrackId);
    if (track) {
      const lanes = points
        .map((entry) => readAutomationLane(entry, track.automationRefs))
        .filter(
          (entry): entry is DocumentAutomationLane =>
            entry !== null && !(track.kind === 'group' && entry.param === 'pan'),
        );
      if (lanes.length === 0) continue;
      if (track.mixerBusId) {
        const bus = mixer?.buses.find((entry) => entry.id === track.mixerBusId);
        if (bus) bus.automation = [...(bus.automation ?? []), ...lanes];
      } else {
        track.automation.push(...lanes);
      }
      continue;
    }
    if (laneTrackId === master.trackId) {
      masterAutomation.push(
        ...points
          .map((entry) => readAutomationLane(entry, master.automationRefs))
          .filter((entry): entry is DocumentAutomationLane => entry !== null),
      );
    }
  }
  return masterAutomation;
}

function readMarkers(project: Document): ProjectDocument['markers'] {
  return Array.from(project.querySelectorAll('Arrangement > Markers > Marker'))
    .map((marker) => ({
      ppq: numberAttr(marker, 'time') ?? 0,
      name: marker.getAttribute('name') || 'Marker',
    }))
    .sort((a, b) => a.ppq - b.ppq);
}

/**
 * Imports a DAWproject archive into sonare's plain project document shape.
 */
export function importDawproject(bytes: Uint8Array): ProjectDocument {
  return importDawprojectParsed(bytes, new Map());
}

function parseArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
): {
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
} {
  let entries: Record<string, Uint8Array>;
  try {
    entries = preflightAndUnzip(
      bytes,
      {
        maxCompressedBytes: MAX_DAWPROJECT_ARCHIVE_BYTES,
        maxEntries: 10_000,
        maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
        maxUncompressedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
      },
      signal,
    ).entries;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof ArchivePreflightError) {
      throw new DawprojectImportError(`Invalid DAWproject archive: ${error.message}`);
    }
    throw new DawprojectImportError('Invalid DAWproject archive: not a readable zip');
  }
  const projectBytes = entries['project.xml'];
  if (!projectBytes) {
    throw new DawprojectImportError('Invalid DAWproject archive: missing project.xml');
  }

  const project = parseXml(projectBytes, 'project.xml');
  const metadata = entries['metadata.xml']
    ? parseXml(entries['metadata.xml'], 'metadata.xml')
    : null;
  return { entries, project, metadata };
}

async function parseArchiveInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
}> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = (
      await preflightAndUnzipInWorker(
        bytes,
        {
          maxCompressedBytes: MAX_DAWPROJECT_ARCHIVE_BYTES,
          maxEntries: 10_000,
          maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
          maxUncompressedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
        },
        signal,
      )
    ).entries;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof ArchivePreflightError) {
      throw new DawprojectImportError(`Invalid DAWproject archive: ${error.message}`);
    }
    throw new DawprojectImportError('Invalid DAWproject archive: not a readable zip');
  }
  const projectBytes = entries['project.xml'];
  if (!projectBytes) {
    throw new DawprojectImportError('Invalid DAWproject archive: missing project.xml');
  }
  const project = parseXml(projectBytes, 'project.xml');
  const metadata = entries['metadata.xml']
    ? parseXml(entries['metadata.xml'], 'metadata.xml')
    : null;
  return { entries, project, metadata };
}

function importDawprojectParsed(
  bytes: Uint8Array,
  mediaAssets: ReadonlyMap<string, string>,
): ProjectDocument {
  const { project, metadata } = parseArchive(bytes);
  return importDawprojectDocuments(project, metadata, mediaAssets).document;
}

function importDawprojectDocuments(
  project: Document,
  metadata: Document | null,
  mediaAssets: ReadonlyMap<string, string>,
): { document: ProjectDocument; losses: DawprojectImportLoss[] } {
  const losses: DawprojectImportLoss[] = [];
  const vcaGroups = readSonareVcaGroups(project);
  const tracks = readTracks(project, new Set(vcaGroups.map((group) => group.id)));
  const master = readMaster(project);
  scrubImportedSidechainSourceIndexes(tracks, master.strip);
  const mixer = applyMixerRouting(tracks, master.strip, vcaGroups);
  const tempoSegments = readTempo(project);
  attachArrangementClips(project, tracks, normalizeTempoMap(tempoSegments), mediaAssets, losses);
  const masterAutomation = attachArrangementAutomation(project, tracks, mixer, master);
  const documentTracks = tracks.filter((track) => !track.isEffectBus);
  const documentIndexByImportedIndex = new Map<number, number>();
  tracks.forEach((track, importedIndex) => {
    if (track.isEffectBus) return;
    documentIndexByImportedIndex.set(importedIndex, documentIndexByImportedIndex.size);
  });

  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: readTitle(project, metadata),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments,
    timeSignatures: readTimeSignatures(project),
    tracks: documentTracks.map((track) => ({
      name: track.name,
      color: track.color,
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      volume: track.volume,
      pan: track.pan,
      clips: track.clips,
      ...(track.groupIndex !== undefined && documentIndexByImportedIndex.has(track.groupIndex)
        ? { groupIndex: documentIndexByImportedIndex.get(track.groupIndex) as number }
        : {}),
      ...(track.vcaId !== undefined ? { vcaId: track.vcaId } : {}),
      ...(track.automation.length > 0 ? { automation: track.automation } : {}),
      ...importedTrackMixer(track),
    })),
    markers: readMarkers(project),
    sections: [],
  };
  if (mixer) doc.mixer = mixer;
  if (masterAutomation.length > 0) doc.masterAutomation = masterAutomation;
  return { document: doc, losses };
}

async function ingestEmbeddedAudio(
  project: Document,
  entries: Record<string, Uint8Array>,
  ingestAudio: (media: DawprojectAudioMedia) => Promise<{ id: string }>,
  resolveExternalAudio?: (path: string) => Promise<Uint8Array | null | undefined>,
  signal?: AbortSignal,
): Promise<{
  assets: Map<string, string>;
  imported: string[];
  issues: DawprojectMediaIssue[];
}> {
  const assets = new Map<string, string>();
  const imported: string[] = [];
  const issues: DawprojectMediaIssue[] = [];
  const seen = new Set<string>();
  for (const clip of Array.from(project.querySelectorAll('Arrangement Clip'))) {
    signal?.throwIfAborted();
    if (clip.querySelector('Notes')) continue;
    const file = audioFileRef(clip);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    let bytes: Uint8Array | null | undefined;
    try {
      bytes = file.external ? await resolveExternalAudio?.(file.path) : entries[file.path];
    } catch (error) {
      issues.push({
        path: file.path,
        external: file.external,
        reason: 'resolve-failed',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    signal?.throwIfAborted();
    if (!bytes) {
      issues.push({ path: file.path, external: file.external, reason: 'missing' });
      continue;
    }
    try {
      const meta = await ingestAudio({
        path: file.path,
        external: file.external,
        name: fileNameFromPath(file.path),
        bytes,
      });
      signal?.throwIfAborted();
      assets.set(file.path, meta.id);
      imported.push(file.path);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      issues.push({
        path: file.path,
        external: file.external,
        reason: 'ingest-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { assets, imported, issues };
}

/**
 * Imports a DAWproject archive and ingests embedded internal audio files.
 */
export async function importDawprojectWithMedia(
  bytes: Uint8Array,
  options: DawprojectImportOptions = {},
): Promise<ProjectDocument> {
  return (await importDawprojectWithMediaResult(bytes, options)).document;
}

/** Imports media with a structured report for missing/resolution/ingest failures. */
export async function importDawprojectWithMediaResult(
  bytes: Uint8Array,
  options: DawprojectImportOptions = {},
): Promise<DawprojectImportResult> {
  options.signal?.throwIfAborted();
  const { entries, project, metadata } = await parseArchiveInWorker(bytes, options.signal);
  const ingestAudio =
    options.ingestAudio ??
    (async (media: DawprojectAudioMedia) =>
      decodeAndIngest(new Uint8Array(media.bytes).buffer, { name: media.name, analysis: null }));
  const media = await ingestEmbeddedAudio(
    project,
    entries,
    ingestAudio,
    options.resolveExternalAudio,
    options.signal,
  );
  options.signal?.throwIfAborted();
  const parsed = importDawprojectDocuments(project, metadata, media.assets);
  return {
    document: parsed.document,
    media: { imported: media.imported, issues: media.issues },
    losses: parsed.losses,
  };
}
