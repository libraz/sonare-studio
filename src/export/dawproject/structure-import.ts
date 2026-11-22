/** Reads the DAWproject Structure: tracks, channels, master, sends, inserts, VCA groups and sidechain keys. */

import { dbToLinear, linearToDb } from '@/lib/db';
import { type AutomationParam, insertAutomationParam } from '@/project/automation';
import type { DocumentInsertSlot } from '@/project/document-mixer-references';
import {
  createDefaultStrip,
  type InsertParamValue,
  type InsertSlot,
  isSoloProcessor,
  type MixerBus,
  type StripSend,
  type VcaGroup,
} from '@/project/mixer';
import type {
  DocumentAutomationLane,
  DocumentClip,
  ProjectDocument,
} from '@/project/serialization';
import { TRACK_COLOR_PALETTE, type TrackKind } from '@/project/types';
import type { DawprojectImportLoss } from './import-loss';
import { SONARE_DEVICE_VENDOR, type SonareDawprojectMetadata } from './sonare-metadata';
import { boolAttr, children, numberAttr } from './xml-read';

export interface ImportedTrack {
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

export interface AutomationParameterRef {
  param: AutomationParam;
  fromDawValue(value: number): number;
}

export interface ImportedMaster {
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
        !processor ||
        !isSoloProcessor(processor)
      ) {
        losses.push({ kind: 'foreign-device', trackName, device: processor || device.tagName });
        return null;
      }
      const params: Record<string, InsertParamValue> = {};
      for (const parameter of children(children(device, 'Parameters')[0])) {
        const name = parameter.getAttribute('name')?.trim();
        if (!name) continue;
        if (parameter.tagName === 'RealParameter') {
          const value = numberAttr(parameter, 'value');
          if (value !== null) params[name] = value;
        } else if (parameter.tagName === 'BoolParameter') {
          params[name] = boolAttr(parameter, 'value');
        } else if (parameter.tagName === 'EnumParameter') {
          const labels = parameter.getAttribute('labels')?.trim().split(/\s+/) ?? [];
          const index = numberAttr(parameter, 'value');
          const label = index !== null && Number.isInteger(index) ? labels[index] : undefined;
          if (label) params[name] = label;
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

export function readSonareVcaGroups(
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

export function readTracks(
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

export function readMaster(
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

export function scrubImportedSidechainSourceIndexes(
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
export function rebindImportedSidechainSourceIndexes(
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
export function rebindDocumentSidechainSourceIndexes(
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

export function applyMixerRouting(
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

export function importedTrackMixer(track: ImportedTrack): {
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
