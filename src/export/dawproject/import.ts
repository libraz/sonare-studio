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
import { SECTION_MARKER_PREFIX } from '@/export/constants';
import { type LossReport, LossTally } from '@/export/loss-descriptor';
import { dbToLinear, linearToDb } from '@/lib/db';
import { errorMessage } from '@/lib/errors';
import {
  preflightXmlBytes,
  preflightXmlDocument,
  preflightXmlMarkupDepth,
  XmlPreflightError,
} from '@/lib/xml-preflight';
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
import { decodeAndIngest, type IngestAudioOptions } from '@/project/audio-import';
import {
  type AutomationParam,
  insertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import type { DocumentInsertSlot } from '@/project/document-mixer-references';
import { isAutomatableSynthParam } from '@/project/instrument';
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
import { DEFAULT_TIME_SIGNATURE } from '@/project/time-signature';
import { TRACK_COLOR_PALETTE, type TrackKind } from '@/project/types';
import { audioFileRef, flattenClipLeaves, readAudioClip, readMidiClip } from './clip-import';
import {
  IMPORTED_SAMPLE_RATE,
  MIN_IMPORTED_LENGTH_PPQ,
  SONARE_AUTOMATION_PARAMETER_PREFIX,
} from './format';
import {
  hasMidiExpressionLanes,
  isPotentialMidiExpressionPoints,
  midiExpressionLoss,
  midiExpressionName,
  readMidiExpressionPoints,
} from './midi-expression-import';
import {
  parseSonareDawprojectMetadata,
  SONARE_DAWPROJECT_METADATA_ENTRY,
  SONARE_DEVICE_VENDOR,
  type SonareDawprojectMetadata,
} from './sonare-metadata';
import { boolAttr, children, numberAttr } from './xml-read';

const DEFAULT_TEMPO = 120;

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
  /** Asset writer for the default ingester; pass a transaction's save to lease each asset. */
  save?: IngestAudioOptions['save'];
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
  /** Media issues and losses together, as the pre-replace dialog lists them. */
  loss: LossReport<DawprojectImportLossKind>;
}

/** A DAWproject value that could not be interpreted without a lossy fallback. */
export type DawprojectImportLoss =
  | {
      kind: 'unsupported-time-unit';
      clipName: string;
      attribute: 'contentTimeUnit' | 'fadeTimeUnit' | 'timeUnit';
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
      reason:
        | 'mixed-time-units'
        | 'loop-with-multiple-events'
        | 'missing-content'
        | 'loop-start-offset';
    }
  | {
      /** Sonare has no disabled-clip model, so disabled content is skipped. */
      kind: 'disabled-clip';
      clipName: string;
    }
  | {
      /** A non-empty MIDI expression lane could not be interpreted. */
      kind: 'unsupported-midi-expression';
      clipName: string;
      expression: string;
      reason:
        | 'missing-target'
        | 'unknown-expression'
        | 'missing-channel'
        | 'invalid-channel'
        | 'missing-controller'
        | 'invalid-controller'
        | 'missing-key'
        | 'invalid-key'
        | 'unsupported-point-type'
        | 'malformed-point'
        /** A timeline-level expression cannot be attached to an audio/group track. */
        | 'non-midi-track'
        /** A timeline-level expression did not identify the Structure track it targets. */
        | 'missing-track';
    }
  | {
      /** A plugin or non-Sonare device; its state cannot be reproduced. */
      kind: 'foreign-device';
      trackName: string;
      device: string;
    }
  | {
      /** Parameter automation whose target has no Sonare parameter. */
      kind: 'unmapped-automation';
      trackName: string;
      parameter: string;
    }
  | {
      /** A send whose destination is not an effect channel Sonare imports as a bus. */
      kind: 'unmapped-send';
      trackName: string;
      destination: string;
    }
  | {
      /** An arrangement lane addressing no imported track. */
      kind: 'orphan-lane';
      track: string;
    };

/** Every class the DAWproject import loss dialog can list, in dialog order. */
export const DAWPROJECT_IMPORT_LOSS_KINDS = [
  'missing-media',
  'unreadable-media',
  'foreign-device',
  'unmapped-automation',
  'unmapped-send',
  'orphan-lane',
  'unsupported-time-unit',
  'unsupported-warp',
  'unsupported-nested-clip',
  'disabled-clip',
  'unsupported-midi-expression',
] as const satisfies ReadonlyArray<
  DawprojectImportLoss['kind'] | 'missing-media' | 'unreadable-media'
>;

export type DawprojectImportLossKind = (typeof DAWPROJECT_IMPORT_LOSS_KINDS)[number];

function lossDetail(loss: DawprojectImportLoss): string {
  switch (loss.kind) {
    case 'unsupported-time-unit':
      return `${loss.clipName}: ${loss.attribute}=${loss.unit}`;
    case 'unsupported-warp':
    case 'unsupported-nested-clip':
      return `${loss.clipName}: ${loss.reason}`;
    case 'disabled-clip':
      return loss.clipName;
    case 'unsupported-midi-expression':
      return `${loss.clipName}: ${loss.expression}`;
    case 'foreign-device':
      return `${loss.trackName}: ${loss.device}`;
    case 'unmapped-automation':
      return `${loss.trackName}: ${loss.parameter}`;
    case 'unmapped-send':
      return `${loss.trackName}: ${loss.destination}`;
    case 'orphan-lane':
      return loss.track;
  }
}

/** Combines media issues and parser losses into the dialog report. */
export function dawprojectImportLossReport(
  losses: ReadonlyArray<DawprojectImportLoss>,
  mediaIssues: ReadonlyArray<DawprojectMediaIssue>,
): LossReport<DawprojectImportLossKind> {
  const tally = new LossTally(DAWPROJECT_IMPORT_LOSS_KINDS);
  for (const issue of mediaIssues) {
    tally.add(issue.reason === 'missing' ? 'missing-media' : 'unreadable-media', 1, issue.path);
  }
  for (const loss of losses) tally.add(loss.kind, 1, lossDetail(loss));
  return tally.report();
}

function parseXml(bytes: Uint8Array, entryName: string): Document {
  let doc: Document;
  try {
    preflightXmlBytes(bytes.byteLength, entryName);
    const xml = strFromU8(bytes);
    preflightXmlMarkupDepth(xml, entryName);
    doc = new DOMParser().parseFromString(xml, 'application/xml');
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
  sonareStripGainDb?: number;
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
  trackName: string,
  losses: DawprojectImportLoss[],
  allowSidechain = true,
  sidechainSources: ReadonlyMap<string, number> = new Map(),
): InsertSlot[] {
  return children(children(channel, 'Devices')[0])
    .map((device): InsertSlot | null => {
      const processor = device.getAttribute('deviceName')?.trim();
      if (
        device.tagName !== 'BuiltinDevice' ||
        device.getAttribute('deviceVendor') !== SONARE_DEVICE_VENDOR ||
        !processor
      ) {
        losses.push({ kind: 'foreign-device', trackName, device: processor || device.tagName });
        return null;
      }
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
      const slot: DocumentInsertSlot = {
        processor,
        params,
        enabled:
          !device.querySelector('Enabled') || boolAttr(device.querySelector('Enabled'), 'value'),
      };
      // Older Sonare archives kept this as a non-standard XML attribute. The
      // current format stores it in sonare-studio.json so project.xml remains
      // valid against the official DAWproject schema.
      const deviceId = device.getAttribute('id') ?? '';
      const sidechainSourceIndex =
        sidechainSources.get(deviceId) ?? numberAttr(device, 'sonareSidechainSourceIndex');
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

function readSonareVcaGroups(
  project: Document,
  sonareMetadata: SonareDawprojectMetadata,
): VcaGroup[] {
  if (sonareMetadata.vcaGroups) return sonareMetadata.vcaGroups;
  // Compatibility with pre-schema-validation Sonare archives.
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
  faderOffsetDb = 0,
): Map<string, AutomationParameterRef> {
  const refs = new Map<string, AutomationParameterRef>();
  // Read only the channel's own direct Volume/Pan: querySelector would descend
  // into the Sends emitted earlier in the channel and grab a send's nested
  // Volume instead, mapping fader automation to the wrong parameter id.
  const volumeId = children(channel, 'Volume')[0]?.getAttribute('id')?.trim();
  if (volumeId) {
    refs.set(volumeId, {
      param: 'faderDb',
      // The exporter folds a member VCA's offset into DAWproject channel
      // values. Remove that same offset in the linear domain, before the dB
      // conversion's -120 dB floor, so a second export does not apply it
      // again.
      fromDawValue: (value) => linearToDb(value * dbToLinear(-faderOffsetDb)),
    });
  }
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
  vcaGainDbById: ReadonlyMap<string, number>,
  sonareMetadata: SonareDawprojectMetadata,
  losses: DawprojectImportLoss[],
): ImportedTrack[] {
  const tracks: ImportedTrack[] = [];
  const sidechainSources = new Map(Object.entries(sonareMetadata.sidechainSources ?? {}));
  let fallbackIndex = 0;

  function visit(track: Element, parentGroupIndex?: number): void {
    const channel = children(track, 'Channel')[0];
    const contentType = track.getAttribute('contentType');
    const role = channel?.getAttribute('role');
    const extension = sonareMetadata.tracks?.[track.getAttribute('id') ?? ''];
    const sonareTrackKind = extension?.kind ?? track.getAttribute('sonareTrackKind');
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
    const sonareVcaId = extension?.vcaId ?? track.getAttribute('sonareVcaId')?.trim();
    const vcaId = sonareVcaId && vcaGainDbById.has(sonareVcaId) ? sonareVcaId : undefined;
    const vcaOffsetDb = vcaId === undefined ? 0 : (vcaGainDbById.get(vcaId) ?? 0);
    const sonareVolume = extension?.volume ?? numberAttr(track, 'sonareVolume');
    const sonareStripGainDb = extension?.stripGainDb ?? numberAttr(track, 'sonareStripGainDb');
    const name = track.getAttribute('name') || `Track ${tracks.length + 1}`;
    tracks.push({
      id: track.getAttribute('id') || `track-${index}`,
      channelId: channel?.getAttribute('id') || `channel-${index}`,
      destination: channel?.getAttribute('destination') ?? null,
      name,
      kind,
      role: role ?? 'regular',
      isEffectBus: role === 'effect' && sonareTrackKind !== 'aux',
      color:
        track.getAttribute('color') ||
        TRACK_COLOR_PALETTE[tracks.length % TRACK_COLOR_PALETTE.length],
      mute: boolAttr(children(channel, 'Mute')[0], 'value'),
      solo: boolAttr(channel, 'solo'),
      volume: sonareVolume !== null ? Math.max(0, sonareVolume) : channelVolume,
      ...(sonareVolume !== null ? { sonareVolume } : {}),
      ...(sonareStripGainDb !== null && sonareStripGainDb !== undefined
        ? { sonareStripGainDb }
        : {}),
      // Group channels use the same bus panner as other mixer channels.
      // The imported channel pan is promoted into MixerStrip.pan on load.
      pan: pan === null ? 0 : panFromNormalized(pan),
      clips: [],
      sendRefs: readSendRefs(channel),
      inserts: readInsertDevices(channel, name, losses, kind !== 'group', sidechainSources),
      automation: [],
      automationRefs: readAutomationParameterRefs(channel, vcaOffsetDb),
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

function readMaster(
  project: Document,
  sonareMetadata: SonareDawprojectMetadata,
  losses: DawprojectImportLoss[],
): ImportedMaster {
  const masterTrack = Array.from(project.querySelectorAll('Structure Track')).find((track) => {
    return children(track, 'Channel')[0]?.getAttribute('role') === 'master';
  });
  const masterChannel = children(masterTrack, 'Channel')[0];
  const strip = createDefaultStrip();
  const volume = numberAttr(children(masterChannel, 'Volume')[0], 'value');
  if (volume !== null) strip.gainDb = linearToDb(Math.max(0, volume));
  const pan = numberAttr(children(masterChannel, 'Pan')[0], 'value');
  if (pan !== null) strip.pan = panFromNormalized(pan);
  strip.inserts = readInsertDevices(
    masterChannel,
    masterTrack?.getAttribute('name') || 'Master',
    losses,
    true,
    new Map(Object.entries(sonareMetadata.sidechainSources ?? {})),
  );
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
      const sourceIndex = (slot as DocumentInsertSlot).sidechainSourceIndex;
      if (
        typeof sourceIndex !== 'number' ||
        !Number.isInteger(sourceIndex) ||
        sourceIndex < 0 ||
        sourceIndex >= trackCount
      ) {
        delete (slot as DocumentInsertSlot).sidechainSourceIndex;
      }
    }
  };
  for (const track of tracks) scrubStrip(track);
  scrubStrip(master);
}

/**
 * Rebinds sidechain indexes written by Sonare's exporter to the order in
 * which Structure tracks were actually visited. A nested group can reorder a
 * document's positional track list (for example when a child precedes its
 * parent in the plain document), while the exporter still names that source
 * `track-${index}`. Prefer that stable XML id and retain the numeric index as
 * a compatibility fallback for foreign/legacy archives.
 */
function rebindImportedSidechainSourceIndexes(
  tracks: ImportedTrack[],
  master: ReturnType<typeof createDefaultStrip>,
): void {
  const importedIndexById = new Map(tracks.map((track, index) => [track.id, index]));
  const rebindStrip = (strip: { inserts: InsertSlot[] }): void => {
    for (const slot of strip.inserts) {
      const sourceIndex = (slot as DocumentInsertSlot).sidechainSourceIndex;
      if (typeof sourceIndex !== 'number' || !Number.isInteger(sourceIndex)) continue;
      const stableSourceIndex = importedIndexById.get(`track-${sourceIndex}`);
      if (stableSourceIndex !== undefined) {
        (slot as DocumentInsertSlot).sidechainSourceIndex = stableSourceIndex;
      }
    }
  };
  for (const track of tracks) rebindStrip(track);
  rebindStrip(master);
}

/** Rebinds imported Structure indexes to the final document-track indexes. */
function rebindDocumentSidechainSourceIndexes(
  tracks: ImportedTrack[],
  master: ReturnType<typeof createDefaultStrip>,
  documentIndexByImportedIndex: ReadonlyMap<number, number>,
): void {
  const rebindStrip = (strip: { inserts: InsertSlot[] }): void => {
    for (const slot of strip.inserts) {
      const sourceIndex = (slot as DocumentInsertSlot).sidechainSourceIndex;
      if (typeof sourceIndex !== 'number' || !Number.isInteger(sourceIndex)) continue;
      const documentIndex = documentIndexByImportedIndex.get(sourceIndex);
      if (documentIndex === undefined) {
        delete (slot as DocumentInsertSlot).sidechainSourceIndex;
      } else {
        (slot as DocumentInsertSlot).sidechainSourceIndex = documentIndex;
      }
    }
  };
  for (const track of tracks) rebindStrip(track);
  rebindStrip(master);
}

function applyMixerRouting(
  tracks: ImportedTrack[],
  master: ReturnType<typeof createDefaultStrip>,
  vcaGroups: VcaGroup[],
  losses: DawprojectImportLoss[],
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
  // Bus strips carry no sends, and a send must address an imported bus.
  for (const track of tracks) {
    for (const send of track.sendRefs) {
      if (track.isEffectBus || !busByChannelId.has(send.destination)) {
        losses.push({
          kind: 'unmapped-send',
          trackName: track.name,
          destination: send.destination,
        });
      }
    }
  }
  const hasMasterState = master.inserts.length > 0 || master.gainDb !== 0 || master.pan !== 0;
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
      track.inserts.length === 0 &&
      (track.sonareStripGainDb === undefined || track.sonareStripGainDb === 0) &&
      track.pan === 0)
  ) {
    return {};
  }
  const mixer = createDefaultStrip();
  mixer.pan = track.isEffectBus ? 0 : track.pan;
  if (track.sonareStripGainDb !== undefined) mixer.gainDb = track.sonareStripGainDb;
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

  // `points` is sorted, so the first point after a group is the next distinct time.
  let nextIndex = 0;
  return [...grouped.entries()].map(([time, group]) => {
    const point = group[group.length - 1];
    nextIndex += group.length;
    const segment: DocumentTempoSegment = { startPpq: time, bpm: point.value };
    if (point.interpolation === 'linear') {
      const end = points[nextIndex];
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
      numerator: numberAttr(transport, 'numerator') ?? DEFAULT_TIME_SIGNATURE.numerator,
      denominator: numberAttr(transport, 'denominator') ?? DEFAULT_TIME_SIGNATURE.denominator,
    },
  ];
}

/**
 * Sonare's arrangement positions are PPQ. A seconds-based arrangement needs
 * a full tempo-map conversion (including ramps), so accepting it as PPQ would
 * silently move clips and automation. Reject it before any media is ingested.
 */
function assertBeatBasedArrangement(project: Document): void {
  const timedElements = project.querySelectorAll(
    'Arrangement[timeUnit], Arrangement Lanes[timeUnit], Arrangement > TempoAutomation[timeUnit], Arrangement > TimeSignatureAutomation[timeUnit], Arrangement > Markers[timeUnit]',
  );
  for (const element of timedElements) {
    const timeUnit = element.getAttribute('timeUnit')?.trim() || 'beats';
    if (timeUnit === 'beats') continue;
    throw new DawprojectImportError(
      `Unsupported DAWproject arrangement timeUnit "${timeUnit}" on ${element.tagName}; import refused to preserve timing`,
    );
  }
}

/** The element's own non-beat `timeUnit`, or null when it is beat-based. */
function nonBeatTimeUnit(element: Element | undefined): string | null {
  const unit = element?.getAttribute('timeUnit')?.trim();
  return unit && unit !== 'beats' ? unit : null;
}

export interface FlattenedClipPlacement {
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

export interface FlattenedClipLeaf {
  element: Element;
  placement: FlattenedClipPlacement;
}

/**
 * Reifies a DAWproject timeline-level MIDI expression as one CC-only clip.
 * Its Points times are arrangement-relative, so the carrier starts at zero
 * and retains those times as its source-relative expression positions.
 */
function readArrangementMidiExpressionClip(
  points: Element,
  track: ImportedTrack,
  losses: DawprojectImportLoss[],
): DocumentClip | null {
  let lengthPpq = MIN_IMPORTED_LENGTH_PPQ;
  for (const point of children(points)) {
    if (point.tagName === 'Target') continue;
    const time = numberAttr(point, 'time');
    if (time !== null && time >= 0) lengthPpq = Math.max(lengthPpq, time);
  }
  const clip: DocumentClip = {
    name: `${track.name} MIDI expression`,
    startPpq: 0,
    lengthPpq,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    kind: 'midi',
    notes: [],
  };
  readMidiExpressionPoints(points, clip, losses);
  return hasMidiExpressionLanes(clip) ? clip : null;
}

function attachArrangementClips(
  project: Document,
  tracks: ImportedTrack[],
  tempoMap: NormalizedTempoMap,
  mediaAssets: ReadonlyMap<string, string>,
  losses: DawprojectImportLoss[],
): void {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  for (const lane of children(arrangementLanes, 'Lanes')) {
    const trackId = lane.getAttribute('track') ?? '';
    const track = byId.get(trackId);
    const clipsTimeline = children(lane, 'Clips')[0];
    const clips = children(clipsTimeline, 'Clip');
    if (!track) {
      if (clips.length > 0) losses.push({ kind: 'orphan-lane', track: trackId || 'Lanes' });
      continue;
    }
    const clipsUnit = nonBeatTimeUnit(clipsTimeline);
    if (clipsUnit !== null && clips.length > 0) {
      losses.push({
        kind: 'unsupported-time-unit',
        clipName: track.name,
        attribute: 'timeUnit',
        unit: clipsUnit,
      });
      continue;
    }
    for (const clip of clips) {
      for (const leaf of flattenClipLeaves(clip, losses)) {
        const points = children(leaf.element, 'Points');
        const hasMidiContent =
          children(leaf.element, 'Notes').length > 0 ||
          (points.length > 0 && track.kind === 'midi');
        const contentUnit =
          leaf.placement.contentTimeUnit !== 'beats' ? leaf.placement.contentTimeUnit : null;
        const timelineUnit = [...children(leaf.element, 'Notes'), ...points]
          .map(nonBeatTimeUnit)
          .find((unit) => unit !== null);
        if (hasMidiContent && (contentUnit !== null || timelineUnit !== undefined)) {
          // MIDI note and expression times are read as beats; any other unit
          // would land them at the wrong position.
          losses.push({
            kind: 'unsupported-time-unit',
            clipName: leaf.placement.name,
            attribute: contentUnit !== null ? 'contentTimeUnit' : 'timeUnit',
            unit: contentUnit ?? timelineUnit ?? '',
          });
        } else if (hasMidiContent) {
          // The official schema makes Clip content a choice: an expression
          // clip contains Points *instead of* Notes. A notes-only predicate
          // therefore misclassified valid MIDI expression clips as audio.
          track.clips.push(readMidiClip(leaf.element, leaf.placement, losses));
        } else if (points.some(isPotentialMidiExpressionPoints)) {
          // A MIDI expression on a non-MIDI track has no faithful Sonare
          // destination. Report it rather than manufacture an audio clip or
          // silently discard its non-empty timeline.
          const clipName = leaf.placement.name;
          for (const entry of points.filter(isPotentialMidiExpressionPoints)) {
            midiExpressionLoss(
              { name: clipName },
              midiExpressionName(entry),
              'non-midi-track',
              losses,
            );
          }
        } else {
          track.clips.push(
            readAudioClip(leaf.element, tempoMap, mediaAssets, losses, leaf.placement),
          );
        }
      }
    }
  }
}

/**
 * Imports official arrangement-level MIDI expression (`<Points track="…">`).
 * Sonare stores expression on clips, so a zero-origin CC-only carrier keeps
 * the point positions and makes the expression audible without inventing
 * notes. Malformed or unaddressable non-empty timelines become explicit loss
 * entries instead of disappearing during the automation pass.
 */
function attachArrangementMidiExpressions(
  project: Document,
  tracks: ImportedTrack[],
  losses: DawprojectImportLoss[],
): void {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  if (!arrangementLanes) return;
  for (const points of Array.from(arrangementLanes.querySelectorAll('Points'))) {
    if (points.closest('Clip') || !isPotentialMidiExpressionPoints(points)) continue;
    const pointElements = children(points).filter((point) => point.tagName !== 'Target');
    if (pointElements.length === 0) continue;
    const trackId =
      points.getAttribute('track')?.trim() ||
      points.parentElement?.getAttribute('track')?.trim() ||
      '';
    const track = byId.get(trackId);
    const name = midiExpressionName(points);
    const unit = nonBeatTimeUnit(points);
    if (unit !== null) {
      losses.push({
        kind: 'unsupported-time-unit',
        clipName: track?.name ?? name,
        attribute: 'timeUnit',
        unit,
      });
      continue;
    }
    if (!track) {
      midiExpressionLoss({ name: 'MIDI expression' }, name, 'missing-track', losses);
      continue;
    }
    if (track.kind !== 'midi') {
      midiExpressionLoss({ name: track.name }, name, 'non-midi-track', losses);
      continue;
    }
    const clip = readArrangementMidiExpressionClip(points, track, losses);
    if (clip) track.clips.push(clip);
  }
}

function readAutomationLane(
  points: Element,
  refs: ReadonlyMap<string, AutomationParameterRef>,
): DocumentAutomationLane | null {
  const parameter = points.querySelector('Target')?.getAttribute('parameter')?.trim();
  if (!parameter) return null;
  const ref = refs.get(parameter) ?? sonareAutomationParameterRef(parameter);
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

/** Restores vendor-scoped instrument/mastering automation emitted by sonare. */
function sonareAutomationParameterRef(parameter: string): AutomationParameterRef | undefined {
  if (!parameter.startsWith(SONARE_AUTOMATION_PARAMETER_PREFIX)) return undefined;
  let param: string;
  try {
    param = decodeURIComponent(parameter.slice(SONARE_AUTOMATION_PARAMETER_PREFIX.length));
  } catch {
    return undefined;
  }
  const instrumentRef = parseInstrumentAutomationParam(param);
  if (instrumentRef !== undefined) {
    if (!isAutomatableSynthParam(instrumentRef.paramName)) return undefined;
  } else if (parseMasteringAutomationParam(param) === undefined) {
    return undefined;
  }
  return { param: param as AutomationParam, fromDawValue: (value) => value };
}

function attachArrangementAutomation(
  project: Document,
  tracks: ImportedTrack[],
  mixer: ProjectDocument['mixer'] | undefined,
  master: ImportedMaster,
  losses: DawprojectImportLoss[],
): DocumentAutomationLane[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const masterAutomation: DocumentAutomationLane[] = [];
  const arrangementLanes = project.querySelector('Arrangement > Lanes');
  // DAWproject permits Points directly under the arrangement Lanes timeline;
  // DAWs emit that form for track-targeted MIDI expression. Parameter
  // automation uses the same placement, so handle both the root and ordinary
  // per-track lane containers here.
  for (const lane of [arrangementLanes, ...children(arrangementLanes, 'Lanes')]) {
    const points = children(lane, 'Points');
    for (const entry of points) {
      const laneTrackId = entry.getAttribute('track') ?? lane?.getAttribute('track') ?? '';
      if (!laneTrackId || isPotentialMidiExpressionPoints(entry)) continue;
      const parameter = entry.querySelector('Target')?.getAttribute('parameter')?.trim() ?? '';
      const hasPoints = children(entry, 'RealPoint').length > 0;
      const track = byId.get(laneTrackId);
      const unit = nonBeatTimeUnit(entry);
      if (unit !== null) {
        if (hasPoints) {
          losses.push({
            kind: 'unsupported-time-unit',
            clipName: track?.name ?? laneTrackId,
            attribute: 'timeUnit',
            unit,
          });
        }
        continue;
      }
      if (track) {
        const automation = readAutomationLane(entry, track.automationRefs);
        if (automation === null || (track.kind === 'group' && automation.param === 'pan')) {
          if (hasPoints) {
            losses.push({ kind: 'unmapped-automation', trackName: track.name, parameter });
          }
          continue;
        }
        if (track.mixerBusId) {
          const bus = mixer?.buses.find((entry) => entry.id === track.mixerBusId);
          if (bus) bus.automation = [...(bus.automation ?? []), automation];
        } else {
          track.automation.push(automation);
        }
        continue;
      }
      if (laneTrackId === master.trackId) {
        const automation = readAutomationLane(entry, master.automationRefs);
        if (automation) masterAutomation.push(automation);
        else if (hasPoints) {
          losses.push({ kind: 'unmapped-automation', trackName: 'Master', parameter });
        }
      } else if (hasPoints) {
        losses.push({ kind: 'orphan-lane', track: laneTrackId });
      }
    }
  }
  return masterAutomation;
}

/** Restores clip expression by the Structure track id, not traversal order. */
function attachSonareMidiExpressions(
  tracks: ImportedTrack[],
  sonareMetadata: SonareDawprojectMetadata,
): void {
  for (const track of tracks) {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.kind === 'audio') return;
      const key = `${track.id}-clip-${clipIndex}`;
      const expression = sonareMetadata.midiExpressions?.[key];
      if (expression) Object.assign(clip, expression);
      const sysEx = sonareMetadata.midiSysEx?.[key];
      if (sysEx) clip.smfSysEx = sysEx;
    });
  }
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

const ARCHIVE_LIMITS = {
  maxCompressedBytes: MAX_DAWPROJECT_ARCHIVE_BYTES,
  maxEntries: 10_000,
  maxEntryBytes: MAX_PROJECT_ARCHIVE_ENTRY_BYTES,
  maxUncompressedBytes: MAX_PROJECT_ARCHIVE_EXPANDED_BYTES,
};

/** Maps an unzip failure to an import error; an aborted signal rethrows its reason instead. */
function toArchiveImportError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) signal.throwIfAborted();
  if (error instanceof ArchivePreflightError) {
    return new DawprojectImportError(`Invalid DAWproject archive: ${error.message}`);
  }
  return new DawprojectImportError('Invalid DAWproject archive: not a readable zip');
}

function parseArchiveEntries(entries: Record<string, Uint8Array>): {
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
} {
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

function parseArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
): {
  entries: Record<string, Uint8Array>;
  project: Document;
  metadata: Document | null;
  sonareMetadata: SonareDawprojectMetadata;
} {
  let entries: Record<string, Uint8Array>;
  try {
    entries = preflightAndUnzip(bytes, ARCHIVE_LIMITS, signal).entries;
  } catch (error) {
    throw toArchiveImportError(error, signal);
  }
  const parsed = parseArchiveEntries(entries);
  return {
    ...parsed,
    sonareMetadata: parseSonareDawprojectMetadata(entries[SONARE_DAWPROJECT_METADATA_ENTRY]),
  };
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
    entries = (await preflightAndUnzipInWorker(bytes, ARCHIVE_LIMITS, signal)).entries;
  } catch (error) {
    throw toArchiveImportError(error, signal);
  }
  return parseArchiveEntries(entries);
}

function importDawprojectParsed(
  bytes: Uint8Array,
  mediaAssets: ReadonlyMap<string, string>,
): ProjectDocument {
  const { project, metadata, sonareMetadata } = parseArchive(bytes);
  return importDawprojectDocuments(project, metadata, mediaAssets, sonareMetadata).document;
}

function importDawprojectDocuments(
  project: Document,
  metadata: Document | null,
  mediaAssets: ReadonlyMap<string, string>,
  sonareMetadata: SonareDawprojectMetadata = { schemaVersion: 1 },
): { document: ProjectDocument; losses: DawprojectImportLoss[] } {
  assertBeatBasedArrangement(project);
  const losses: DawprojectImportLoss[] = [];
  const vcaGroups = readSonareVcaGroups(project, sonareMetadata);
  const vcaGainDbById = new Map(vcaGroups.map((group) => [group.id, group.gainDb]));
  const tracks = readTracks(project, vcaGainDbById, sonareMetadata, losses);
  const master = readMaster(project, sonareMetadata, losses);
  rebindImportedSidechainSourceIndexes(tracks, master.strip);
  scrubImportedSidechainSourceIndexes(tracks, master.strip);
  const mixer = applyMixerRouting(tracks, master.strip, vcaGroups, losses);
  const tempoSegments = readTempo(project);
  attachArrangementClips(project, tracks, normalizeTempoMap(tempoSegments), mediaAssets, losses);
  attachArrangementMidiExpressions(project, tracks, losses);
  attachSonareMidiExpressions(tracks, sonareMetadata);
  const masterAutomation = attachArrangementAutomation(project, tracks, mixer, master, losses);
  const documentTracks = tracks.filter((track) => !track.isEffectBus);
  const sections = sonareMetadata.sections ?? [];
  const documentIndexByImportedIndex = new Map<number, number>();
  tracks.forEach((track, importedIndex) => {
    if (track.isEffectBus) return;
    documentIndexByImportedIndex.set(importedIndex, documentIndexByImportedIndex.size);
  });
  rebindDocumentSidechainSourceIndexes(tracks, master.strip, documentIndexByImportedIndex);

  const doc: ProjectDocument = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: readTitle(project, metadata),
    sampleRate: IMPORTED_SAMPLE_RATE,
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
    // Sonare exports sections as portable cue markers too. The metadata entry
    // preserves their end/color, so do not also restore those cues as markers.
    markers: readMarkers(project).filter(
      (marker) =>
        !sections.some(
          (section) =>
            marker.ppq === section.startPpq &&
            marker.name === `${SECTION_MARKER_PREFIX}${section.name}`,
        ),
    ),
    sections,
    ...(sonareMetadata.chords?.length ? { chords: sonareMetadata.chords } : {}),
    ...(sonareMetadata.pickupLengthPpq !== undefined
      ? { pickupLengthPpq: sonareMetadata.pickupLengthPpq }
      : {}),
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
        message: errorMessage(error),
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
        message: errorMessage(error),
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
  assertBeatBasedArrangement(project);
  const sonareMetadata = parseSonareDawprojectMetadata(entries[SONARE_DAWPROJECT_METADATA_ENTRY]);
  const ingestAudio =
    options.ingestAudio ??
    (async (media: DawprojectAudioMedia) =>
      decodeAndIngest(new Uint8Array(media.bytes).buffer, {
        name: media.name,
        analysis: null,
        ...(options.save !== undefined ? { save: options.save } : {}),
      }));
  const media = await ingestEmbeddedAudio(
    project,
    entries,
    ingestAudio,
    options.resolveExternalAudio,
    options.signal,
  );
  options.signal?.throwIfAborted();
  const parsed = importDawprojectDocuments(project, metadata, media.assets, sonareMetadata);
  return {
    document: parsed.document,
    media: { imported: media.imported, issues: media.issues },
    losses: parsed.losses,
    loss: dawprojectImportLossReport(parsed.losses, media.issues),
  };
}
