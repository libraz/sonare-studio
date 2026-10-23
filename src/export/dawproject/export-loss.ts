/**
 * What a DAWproject export drops: every document field is declared as written
 * to project.xml, carried by the Sonare sidecar (./sonare-metadata.ts), derived,
 * or lost. A field a later schema change adds fails the type check here until
 * the exporter's treatment of it is declared.
 */

import {
  type FieldDispositions,
  type LossReport,
  LossTally,
  tallyFields,
} from '@/export/loss-descriptor';
import {
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
  parseMasteringAutomationParam,
} from '@/project/automation';
import { insertIndexForAutomationRef } from '@/project/automation-insert';
import {
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  DEFAULT_STRIP_WIDTH,
  type InsertSlot,
  type MixerStrip,
} from '@/project/mixer';
import type {
  DocumentAutomationLane,
  DocumentClip,
  DocumentMixerBus,
  DocumentMixerState,
  DocumentTrack,
  ProjectDocument,
} from '@/project/serialization';
import { exportedWarp, hexColor, isGroupPanAutomation } from './export-rules';
import { IMPORTED_SAMPLE_RATE } from './format';

/** Every class the DAWproject export loss dialog can list, in dialog order. */
export const DAWPROJECT_EXPORT_LOSS_KINDS = [
  'warpedAudioClips',
  'clipGains',
  'midiClipFades',
  'missingAudioAssets',
  'audioTakes',
  'compSegments',
  'midiTakes',
  'midiCompSegments',
  'stemRoles',
  'instrumentTracks',
  'midiFxTracks',
  'expressionMaps',
  'trackColors',
  'externalMidiRoutes',
  'musicXmlPartIds',
  'percussionOverrides',
  'generatedTracks',
  'chordFollow',
  'leadFollow',
  'pitchRanges',
  'scoreDisplaySettings',
  'scoreAnnotations',
  'scaleHighlight',
  'generationSeed',
  'meterGroupings',
  'projectSampleRate',
  'midiCcBindings',
  'controlSurface',
  'mixerSnapshots',
  'mixerSoloMode',
  'masteringChain',
  'frozenTracks',
  'recordInputChannels',
  'recordInputDevices',
  'soloSafeTracks',
  'automationLanes',
  'stripEqSettings',
  'stripAdvancedSettings',
  'surroundSettings',
  'sidechainKeys',
  'busMuteSolo',
  'busRouting',
] as const;

export type DawprojectExportLossKind = (typeof DAWPROJECT_EXPORT_LOSS_KINDS)[number];

interface ExportContext {
  trackCount: number;
}

/** A serialized insert: document track and group references are carried as indices. */
type DocumentInsertSlot = InsertSlot & {
  sidechainSourceIndex?: number;
  sidechainSourceGroupTrackIndex?: number;
};

/** Insert fields that name a sidechain key source; the sidecar carries only the track index. */
const SIDECHAIN_KEY_FIELDS = [
  'sidechainSourceTrackId',
  'sidechainSourceIndex',
  'sidechainSourceBusId',
  'sidechainSourceGroupTrackId',
  'sidechainSourceGroupTrackIndex',
] as const satisfies ReadonlyArray<keyof DocumentInsertSlot>;

function isSidechainKeyExported(slot: DocumentInsertSlot, trackCount: number): boolean {
  const index = slot.sidechainSourceIndex;
  if (slot.sidechainSourceBusId !== undefined) return false;
  if (slot.sidechainSourceGroupTrackId !== undefined) return false;
  if (slot.sidechainSourceGroupTrackIndex !== undefined) return false;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < trackCount;
}

function hasSidechainKey(slot: DocumentInsertSlot): boolean {
  return SIDECHAIN_KEY_FIELDS.some((field) => slot[field] !== undefined);
}

function isAutomationLaneExported(
  lane: DocumentAutomationLane,
  strip?: MixerStrip,
  trackKind?: DocumentTrack['kind'],
): boolean {
  if (!lane.enabled || lane.points.length === 0) return false;
  if (trackKind !== undefined && isGroupPanAutomation(trackKind, lane)) return false;
  if (lane.param === 'faderDb' || lane.param === 'pan') return true;
  if (
    parseInstrumentAutomationParam(lane.param) !== undefined ||
    parseMasteringAutomationParam(lane.param) !== undefined
  ) {
    return true;
  }
  const insertRef = parseInsertAutomationParam(lane.param);
  if (!insertRef) return false;
  const insertIndex = strip ? insertIndexForAutomationRef(strip.inserts, insertRef) : undefined;
  const slot = insertIndex === undefined ? undefined : strip?.inserts[insertIndex];
  const param = slot?.params[insertRef.paramName];
  return typeof param === 'number' || typeof param === 'boolean';
}

function unexportedLanes(
  lanes: ReadonlyArray<DocumentAutomationLane> | undefined,
  strip: MixerStrip | undefined,
  trackKind?: DocumentTrack['kind'],
): number {
  return (lanes ?? []).filter((lane) => !isAutomationLaneExported(lane, strip, trackKind)).length;
}

const advanced = (changed: boolean): number => (changed ? 1 : 0);

const TRACK_STRIP_FIELDS: FieldDispositions<MixerStrip, DawprojectExportLossKind, ExportContext> = {
  gainDb: 'written',
  pan: 'written',
  inputTrimDb: {
    lost: 'stripAdvancedSettings',
    count: (trim) => advanced((trim ?? 0) !== 0),
  },
  width: {
    lost: 'stripAdvancedSettings',
    count: (width) => advanced((width ?? DEFAULT_STRIP_WIDTH) !== DEFAULT_STRIP_WIDTH),
  },
  polarityInvertLeft: { lost: 'stripAdvancedSettings' },
  polarityInvertRight: { lost: 'stripAdvancedSettings' },
  inserts: {
    lost: 'sidechainKeys',
    count: (inserts, _strip, context) =>
      inserts.filter(
        (slot) => hasSidechainKey(slot) && !isSidechainKeyExported(slot, context.trackCount),
      ).length,
  },
  sends: 'written',
  eq: {
    lost: 'stripEqSettings',
    count: (eq) => advanced(eq !== undefined && (eq.enabled || eq.bands.length > 0)),
  },
  outputBusId: 'written',
  channelDelaySamples: {
    lost: 'stripAdvancedSettings',
    count: (delay) => advanced((delay ?? 0) !== 0),
  },
  panLaw: {
    lost: 'stripAdvancedSettings',
    count: (law) => advanced((law ?? DEFAULT_PAN_LAW) !== DEFAULT_PAN_LAW),
  },
  panMode: {
    lost: 'stripAdvancedSettings',
    count: (mode) => advanced((mode ?? DEFAULT_PAN_MODE) !== DEFAULT_PAN_MODE),
  },
  dualPan: { lost: 'stripAdvancedSettings' },
  sourceLayout: {
    lost: 'surroundSettings',
    count: (layout) => advanced(layout !== undefined && layout !== 'stereo'),
  },
  surroundPan: { lost: 'surroundSettings' },
};

// A bus channel is written with its inserts and pan only; it always feeds master.
const BUS_STRIP_FIELDS: FieldDispositions<MixerStrip, DawprojectExportLossKind, ExportContext> = {
  ...TRACK_STRIP_FIELDS,
  sends: { lost: 'busRouting' },
  outputBusId: { lost: 'busRouting' },
};

const BUS_FIELDS: FieldDispositions<DocumentMixerBus, DawprojectExportLossKind, ExportContext> = {
  id: 'written',
  name: 'written',
  gainDb: 'written',
  mute: { lost: 'busMuteSolo' },
  solo: { lost: 'busMuteSolo' },
  channelLayout: {
    lost: 'surroundSettings',
    count: (layout) => advanced(layout !== undefined && layout !== 'stereo'),
  },
  strip: 'written',
  automation: {
    lost: 'automationLanes',
    count: (lanes, bus) => unexportedLanes(lanes, bus.strip),
  },
};

const MIXER_FIELDS: FieldDispositions<DocumentMixerState, DawprojectExportLossKind, ExportContext> =
  {
    soloMode: {
      lost: 'mixerSoloMode',
      count: (mode) => advanced(mode !== undefined && mode !== 'inPlace'),
    },
    master: 'written',
    masterLayout: {
      lost: 'surroundSettings',
      count: (layout) => advanced(layout !== undefined && layout !== 'stereo'),
    },
    buses: 'written',
    vcaGroups: 'sidecar',
    masteringChain: {
      lost: 'masteringChain',
      count: (chain) =>
        chain === undefined
          ? 0
          : (chain.preset !== undefined ? 1 : 0) +
            (chain.presetOverrides !== undefined && Object.keys(chain.presetOverrides).length > 0
              ? 1
              : 0) +
            chain.processors.length,
    },
  };

const TRACK_FIELDS: FieldDispositions<DocumentTrack, DawprojectExportLossKind, ExportContext> = {
  name: 'written',
  musicXmlPartId: { lost: 'musicXmlPartIds' },
  color: {
    lost: 'trackColors',
    count: (color) => advanced(hexColor(color) === undefined),
  },
  kind: 'written',
  mute: 'written',
  solo: 'written',
  volume: 'written',
  pan: 'written',
  clips: 'written',
  instrument: { lost: 'instrumentTracks' },
  externalMidiMode: { lost: 'externalMidiRoutes' },
  midiFx: { lost: 'midiFxTracks' },
  mixer: 'written',
  automation: {
    lost: 'automationLanes',
    count: (lanes, track) => unexportedLanes(lanes, track.mixer, track.kind),
  },
  groupIndex: 'written',
  soloSafe: { lost: 'soloSafeTracks' },
  percussion: { lost: 'percussionOverrides', count: (value) => advanced(value !== undefined) },
  generated: { lost: 'generatedTracks' },
  vcaId: 'sidecar',
  chordFollow: { lost: 'chordFollow' },
  expressionMap: { lost: 'expressionMaps' },
  frozen: { lost: 'frozenTracks' },
  recordInputChannel: {
    lost: 'recordInputChannels',
    count: (channel) => advanced(channel !== undefined),
  },
  recordInputDeviceId: { lost: 'recordInputDevices' },
  pitchRange: { lost: 'pitchRanges' },
  // The relation and the notes it parked both live only in the Sonare document.
  leadFollow: { lost: 'leadFollow' },
};

const CLIP_FIELDS: FieldDispositions<DocumentClip, DawprojectExportLossKind, ExportContext> = {
  name: 'written',
  startPpq: 'written',
  lengthPpq: 'written',
  sourceOffsetPpq: 'written',
  gain: { lost: 'clipGains', count: (gain) => advanced(gain !== 1) },
  loopEnabled: 'written',
  loopLengthPpq: 'written',
  notes: 'written',
  kind: 'written',
  assetId: {
    lost: 'missingAudioAssets',
    count: (assetId, clip) => advanced(clip.kind === 'audio' && assetId === undefined),
  },
  externalStemRole: { lost: 'stemRoles' },
  contentHash: 'derived',
  // Audio clip fades are written; MIDI clips carry none in project.xml.
  fadeInPpq: {
    lost: 'midiClipFades',
    count: (fade, clip) => advanced(clip.kind !== 'audio' && (fade ?? 0) > 0),
  },
  fadeOutPpq: {
    lost: 'midiClipFades',
    count: (fade, clip) => advanced(clip.kind !== 'audio' && (fade ?? 0) > 0),
  },
  takes: { lost: 'audioTakes' },
  compSegments: { lost: 'compSegments' },
  midiTakes: { lost: 'midiTakes' },
  midiActiveTakeIndex: 'derived',
  midiCompSegments: { lost: 'midiCompSegments' },
  // Enabled warps with a source tempo are written as standard Warps; others are dropped.
  warp: {
    lost: 'warpedAudioClips',
    count: (warp, clip) =>
      advanced(clip.kind === 'audio' && warp !== undefined && exportedWarp(clip) === null),
  },
  ccLanes: 'sidecar',
  pitchBendLanes: 'sidecar',
  programChangeLanes: 'sidecar',
  channelPressureLanes: 'sidecar',
  polyPressureLanes: 'sidecar',
  smfSysEx: 'sidecar',
  scoreAnnotations: { lost: 'scoreAnnotations' },
};

const DOCUMENT_FIELDS: FieldDispositions<ProjectDocument, DawprojectExportLossKind, ExportContext> =
  {
    schemaVersion: 'derived',
    name: 'written',
    sampleRate: {
      lost: 'projectSampleRate',
      count: (rate) => advanced(rate !== IMPORTED_SAMPLE_RATE),
    },
    tempoSegments: 'written',
    timeSignatures: {
      lost: 'meterGroupings',
      count: (signatures) =>
        signatures.filter((signature) => (signature.grouping?.length ?? 0) > 0).length,
    },
    pickupLengthPpq: 'sidecar',
    generationSeed: { lost: 'generationSeed', count: (seed) => advanced(seed !== undefined) },
    scaleHighlight: { lost: 'scaleHighlight' },
    tracks: 'written',
    markers: 'written',
    // Starts travel as cue markers; ranges and colours through the sidecar.
    sections: 'sidecar',
    masterAutomation: {
      lost: 'automationLanes',
      count: (lanes, doc) => unexportedLanes(lanes, doc.mixer?.master),
    },
    chords: 'sidecar',
    mixer: 'written',
    externalMidiDefault: { lost: 'externalMidiRoutes' },
    score: { lost: 'scoreDisplaySettings' },
    midiCcBindings: { lost: 'midiCcBindings' },
    controlSurface: { lost: 'controlSurface' },
    mixerSnapshots: {
      lost: 'mixerSnapshots',
      count: (snapshots) =>
        snapshots === undefined ? 0 : Object.values(snapshots.slots).filter(Boolean).length,
    },
  };

/** Lists every document feature a DAWproject export and re-import does not keep. */
export function inspectDawprojectExportLoss(
  doc: ProjectDocument,
): LossReport<DawprojectExportLossKind> {
  const loss = new LossTally(DAWPROJECT_EXPORT_LOSS_KINDS);
  const context: ExportContext = { trackCount: doc.tracks.length };
  tallyFields(loss, DOCUMENT_FIELDS, doc, context);
  for (const track of doc.tracks) {
    tallyFields(loss, TRACK_FIELDS, track, context);
    if (track.mixer) tallyFields(loss, TRACK_STRIP_FIELDS, track.mixer, context);
    for (const clip of track.clips) tallyFields(loss, CLIP_FIELDS, clip, context);
  }
  if (doc.mixer) {
    tallyFields(loss, MIXER_FIELDS, doc.mixer, context);
    tallyFields(loss, TRACK_STRIP_FIELDS, doc.mixer.master, context);
    for (const bus of doc.mixer.buses) {
      tallyFields(loss, BUS_FIELDS, bus, context);
      if (bus.strip) tallyFields(loss, BUS_STRIP_FIELDS, bus.strip, context);
    }
  }
  return loss.report();
}
