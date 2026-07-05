/**
 * Minimal DAWproject importer.
 *
 * This intentionally starts with the portable subset that sonare already
 * exports well: project title, transport tempo/meter, track/channel basics,
 * arrangement markers and MIDI note clips. Audio clips are imported as
 * placement-only clips for now; ingesting referenced media files into OPFS is a
 * separate step because DAWproject archives may reference external paths.
 */

import { strFromU8, unzipSync } from 'fflate';
import { linearToDb } from '@/lib/db';
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
import { type NormalizedTempoMap, normalizeTempoMap, secondsToPpq } from '@/project/tempo-map';
import { TRACK_COLOR_PALETTE, type TrackKind } from '@/project/types';

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
}

function parseXml(bytes: Uint8Array, entryName: string): Document {
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
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
  const volumeId = channel?.querySelector('Volume')?.getAttribute('id')?.trim();
  if (volumeId)
    refs.set(volumeId, { param: 'faderDb', fromDawValue: (value) => linearToDb(value) });
  const panId = channel?.querySelector('Pan')?.getAttribute('id')?.trim();
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
    if (role === 'master') return;
    const pan = numberAttr(channel?.querySelector('Pan'), 'value');
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
    const channelVolume = Math.max(0, numberAttr(channel?.querySelector('Volume'), 'value') ?? 1);
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
      color:
        track.getAttribute('color') ||
        TRACK_COLOR_PALETTE[tracks.length % TRACK_COLOR_PALETTE.length],
      mute: boolAttr(channel?.querySelector('Mute'), 'value'),
      solo: boolAttr(channel, 'solo'),
      volume:
        vcaId !== undefined && sonareVolume !== null ? Math.max(0, sonareVolume) : channelVolume,
      ...(sonareVolume !== null ? { sonareVolume } : {}),
      pan: pan === null ? 0 : Math.min(1, Math.max(-1, pan * 2 - 1)),
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
    if (track.role !== 'effect') continue;
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
    if (track.role === 'effect') continue;
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
    track.role === 'effect' ||
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

function readMidiClip(clip: Element): DocumentClip {
  const playStart = numberAttr(clip, 'playStart') ?? 0;
  const loopStart = numberAttr(clip, 'loopStart');
  const loopEnd = numberAttr(clip, 'loopEnd');
  const out: DocumentClip = {
    name: clip.getAttribute('name') || 'MIDI clip',
    startPpq: numberAttr(clip, 'time') ?? 0,
    lengthPpq: Math.max(0.0001, numberAttr(clip, 'duration') ?? 4),
    sourceOffsetPpq: playStart,
    gain: 1,
    loopEnabled: loopStart !== null && loopEnd !== null && loopEnd > loopStart,
    loopLengthPpq: loopStart !== null && loopEnd !== null ? Math.max(0, loopEnd - loopStart) : 0,
    kind: 'midi',
    notes: Array.from(clip.querySelectorAll('Notes > Note')).map((note) => ({
      pitch: clampInt(numberAttr(note, 'key') ?? 60, 0, 127),
      velocity: normalizedVelocity(numberAttr(note, 'vel')),
      startPpq: Math.max(0, numberAttr(note, 'time') ?? 0),
      durationPpq: Math.max(0.0001, numberAttr(note, 'duration') ?? 1),
      channel: clampInt(numberAttr(note, 'channel') ?? 0, 0, 15),
      offVelocity: normalizedVelocity(numberAttr(note, 'rel')),
    })),
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
  const file = clip.querySelector('Audio > File');
  if (!file) return null;
  const path = file.getAttribute('path')?.trim();
  const external = file.getAttribute('external') === 'true';
  if (!path) return null;
  if (!external && path.startsWith('/')) return null;
  return { path, external };
}

function clipContentPpq(clip: Element, attr: string, tempoMap: NormalizedTempoMap): number | null {
  const value = numberAttr(clip, attr);
  if (value === null) return null;
  return clip.getAttribute('contentTimeUnit') === 'seconds' ? secondsToPpq(tempoMap, value) : value;
}

function readAudioClip(
  clip: Element,
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string> = new Map(),
): DocumentClip {
  const file = audioFileRef(clip);
  const playStart = clipContentPpq(clip, 'playStart', tempoMap);
  const loopStart = clipContentPpq(clip, 'loopStart', tempoMap);
  const loopEnd = clipContentPpq(clip, 'loopEnd', tempoMap);
  return {
    name: clip.getAttribute('name') || 'Audio clip',
    startPpq: numberAttr(clip, 'time') ?? 0,
    lengthPpq: Math.max(0.0001, numberAttr(clip, 'duration') ?? 4),
    sourceOffsetPpq: Math.max(0, playStart ?? 0),
    gain: 1,
    loopEnabled: loopStart !== null && loopEnd !== null && loopEnd > loopStart,
    loopLengthPpq: loopStart !== null && loopEnd !== null ? Math.max(0, loopEnd - loopStart) : 0,
    kind: 'audio',
    notes: [],
    ...(file && mediaAssets.has(file.path)
      ? { assetId: mediaAssets.get(file.path) as string }
      : {}),
    ...(numberAttr(clip, 'fadeInTime')
      ? { fadeInPpq: numberAttr(clip, 'fadeInTime') as number }
      : {}),
    ...(numberAttr(clip, 'fadeOutTime')
      ? { fadeOutPpq: numberAttr(clip, 'fadeOutTime') as number }
      : {}),
  };
}

function attachArrangementClips(
  project: Document,
  tracks: ImportedTrack[],
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string> = new Map(),
): void {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  for (const lane of children(arrangementLanes, 'Lanes')) {
    const track = byId.get(lane.getAttribute('track') ?? '');
    if (!track) continue;
    const clips = children(children(lane, 'Clips')[0], 'Clip');
    for (const clip of clips) {
      track.clips.push(
        clip.querySelector('Notes')
          ? readMidiClip(clip)
          : readAudioClip(clip, tempoMap, mediaAssets),
      );
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
        .filter((entry): entry is DocumentAutomationLane => entry !== null);
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

function parseArchive(bytes: Uint8Array): {
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
} {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
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
  const vcaGroups = readSonareVcaGroups(project);
  const tracks = readTracks(project, new Set(vcaGroups.map((group) => group.id)));
  const master = readMaster(project);
  scrubImportedSidechainSourceIndexes(tracks, master.strip);
  const mixer = applyMixerRouting(tracks, master.strip, vcaGroups);
  const tempoSegments = readTempo(project);
  attachArrangementClips(project, tracks, normalizeTempoMap(tempoSegments), mediaAssets);
  const masterAutomation = attachArrangementAutomation(project, tracks, mixer, master);

  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: readTitle(project, metadata),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments,
    timeSignatures: readTimeSignatures(project),
    tracks: tracks.map((track) => ({
      name: track.name,
      color: track.color,
      kind: track.kind,
      mute: track.mute,
      solo: track.solo,
      volume: track.volume,
      pan: track.pan,
      clips: track.clips,
      ...(track.groupIndex !== undefined ? { groupIndex: track.groupIndex } : {}),
      ...(track.vcaId !== undefined ? { vcaId: track.vcaId } : {}),
      ...(track.automation.length > 0 ? { automation: track.automation } : {}),
      ...importedTrackMixer(track),
    })),
    markers: readMarkers(project),
    sections: [],
  };
  if (mixer) doc.mixer = mixer;
  if (masterAutomation.length > 0) doc.masterAutomation = masterAutomation;
  return doc;
}

async function ingestEmbeddedAudio(
  project: Document,
  entries: Record<string, Uint8Array>,
  ingestAudio: (media: DawprojectAudioMedia) => Promise<{ id: string }>,
  resolveExternalAudio?: (path: string) => Promise<Uint8Array | null | undefined>,
): Promise<Map<string, string>> {
  const assets = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  for (const clip of Array.from(project.querySelectorAll('Arrangement Clip'))) {
    if (clip.querySelector('Notes')) continue;
    const file = audioFileRef(clip);
    if (!file || pending.has(file.path)) continue;
    const bytes = file.external
      ? await resolveExternalAudio?.(file.path).catch(() => null)
      : entries[file.path];
    if (!bytes) continue;
    pending.set(
      file.path,
      ingestAudio({
        path: file.path,
        external: file.external,
        name: fileNameFromPath(file.path),
        bytes,
      })
        .then((meta) => meta.id)
        .catch(() => null),
    );
  }
  for (const [path, promise] of pending) {
    const id = await promise;
    if (id) assets.set(path, id);
  }
  return assets;
}

/**
 * Imports a DAWproject archive and ingests embedded internal audio files.
 */
export async function importDawprojectWithMedia(
  bytes: Uint8Array,
  options: DawprojectImportOptions = {},
): Promise<ProjectDocument> {
  const { entries, project } = parseArchive(bytes);
  const ingestAudio =
    options.ingestAudio ??
    (async (media: DawprojectAudioMedia) =>
      decodeAndIngest(new Uint8Array(media.bytes).buffer, { name: media.name, analysis: null }));
  const mediaAssets = await ingestEmbeddedAudio(
    project,
    entries,
    ingestAudio,
    options.resolveExternalAudio,
  );
  return importDawprojectParsed(bytes, mediaAssets);
}
