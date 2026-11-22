import type { FieldDispositions } from '@/export/loss-descriptor';
import { type MixerStrip, masteringChainIsActive } from './mixer';
import type {
  DocumentAutomationLane,
  DocumentClip,
  DocumentTrack,
  ProjectDocument,
} from './serialization';

/**
 * Feature classes a MIDI-file export (SMF or MIDI 2.0 clip file) can drop, in
 * dialog order. Each format reports the subset its writer actually drops.
 */
export const MIDI_EXPORT_LOSS_KINDS = [
  'nonMidiTracks',
  'emptyMidiTracks',
  'emptyMidiClips',
  'mutedTracks',
  'soloedTracks',
  'trackMixLevels',
  'instrumentTracks',
  'clipGains',
  'clipFades',
  'midiFxTracks',
  'expressionMaps',
  'expressionLanes',
  'sysExPackets',
  'automationLanes',
  'mixerProcessing',
  'clampedTrackGains',
  'markers',
] as const;

export type MidiExportLossKind = (typeof MIDI_EXPORT_LOSS_KINDS)[number];

/** Mixer state a MIDI-file writer needs to resolve a track's audible level. */
export interface MidiExportTrackContext {
  /** VCA group id -> fader offset in dB. */
  vcaGainDb: ReadonlyMap<string, number>;
  /** VCA group ids that currently mute their members. */
  mutedVcaIds: ReadonlySet<string>;
}

export function midiExportTrackContext(doc: ProjectDocument): MidiExportTrackContext {
  const groups = doc.mixer?.vcaGroups ?? [];
  return {
    vcaGainDb: new Map(groups.map((group) => [group.id, group.gainDb])),
    mutedVcaIds: new Set(groups.filter((group) => group.mute === true).map((group) => group.id)),
  };
}

function enabledLaneCount(lanes: ReadonlyArray<DocumentAutomationLane> | undefined): number {
  return (lanes ?? []).filter((lane) => lane.enabled && lane.points.length > 0).length;
}

function stripHasProcessing(strip: MixerStrip | undefined): boolean {
  return (
    strip !== undefined &&
    (strip.inserts.length > 0 ||
      strip.sends.some((send) => send.enabled) ||
      strip.eq?.enabled === true ||
      strip.outputBusId !== undefined)
  );
}

/** Project fields as the SMF writer treats them. */
export const SMF_DOCUMENT_FIELDS: FieldDispositions<ProjectDocument, MidiExportLossKind> = {
  schemaVersion: 'derived',
  name: 'not-content',
  sampleRate: 'not-content',
  tempoSegments: 'written',
  timeSignatures: 'written',
  pickupLengthPpq: 'not-content',
  generationSeed: 'not-content',
  scaleHighlight: 'not-content',
  tracks: 'written',
  markers: 'written',
  // Section starts are written as cue markers.
  sections: 'written',
  masterAutomation: { lost: 'automationLanes', count: enabledLaneCount },
  chords: 'not-content',
  mixer: {
    lost: 'mixerProcessing',
    count: (mixer) =>
      mixer === undefined
        ? 0
        : mixer.buses.length +
          (stripHasProcessing(mixer.master) || mixer.master.gainDb !== 0 ? 1 : 0) +
          (masteringChainIsActive(mixer.masteringChain) ? 1 : 0),
  },
  externalMidiDefault: 'not-content',
  score: 'not-content',
  midiCcBindings: 'not-content',
  controlSurface: 'not-content',
  mixerSnapshots: 'not-content',
};

/** MIDI track fields as the SMF writer treats them. */
export const SMF_TRACK_FIELDS: FieldDispositions<
  DocumentTrack,
  MidiExportLossKind,
  MidiExportTrackContext
> = {
  name: 'written',
  musicXmlPartId: 'not-content',
  color: 'not-content',
  kind: 'written',
  mute: {
    lost: 'mutedTracks',
    count: (mute, track, context) =>
      mute || (track.vcaId !== undefined && context.mutedVcaIds.has(track.vcaId)) ? 1 : 0,
  },
  solo: { lost: 'soloedTracks' },
  // Static gain and pan are written as CC7/CC10.
  volume: 'written',
  pan: 'written',
  clips: 'written',
  // Written as bank/program preludes.
  instrument: 'written',
  externalMidiMode: 'not-content',
  midiFx: { lost: 'midiFxTracks' },
  mixer: { lost: 'mixerProcessing', count: (strip) => (stripHasProcessing(strip) ? 1 : 0) },
  automation: { lost: 'automationLanes', count: enabledLaneCount },
  groupIndex: 'not-content',
  soloSafe: 'not-content',
  percussion: 'not-content',
  generated: 'not-content',
  // Folded into CC7.
  vcaId: 'written',
  chordFollow: 'not-content',
  expressionMap: { lost: 'expressionMaps' },
  frozen: 'not-content',
  recordInputChannel: 'not-content',
  recordInputDeviceId: 'not-content',
  pitchRange: 'not-content',
  leadFollow: 'not-content',
};

/** MIDI clip fields as the SMF writer treats them. */
export const SMF_CLIP_FIELDS: FieldDispositions<DocumentClip, MidiExportLossKind> = {
  name: 'not-content',
  startPpq: 'written',
  lengthPpq: 'written',
  sourceOffsetPpq: 'written',
  // A silenced clip (gain <= 0) is written without notes, as playback does.
  gain: { lost: 'clipGains', count: (gain) => (gain > 0 && gain !== 1 ? 1 : 0) },
  loopEnabled: 'written',
  loopLengthPpq: 'written',
  notes: 'written',
  kind: 'written',
  assetId: 'not-content',
  externalStemRole: 'not-content',
  contentHash: 'not-content',
  fadeInPpq: { lost: 'clipFades', count: (fade) => ((fade ?? 0) > 0 ? 1 : 0) },
  fadeOutPpq: { lost: 'clipFades', count: (fade) => ((fade ?? 0) > 0 ? 1 : 0) },
  takes: 'not-content',
  compSegments: 'not-content',
  midiTakes: 'not-content',
  midiActiveTakeIndex: 'not-content',
  midiCompSegments: 'not-content',
  warp: 'not-content',
  ccLanes: 'written',
  pitchBendLanes: 'written',
  programChangeLanes: 'written',
  channelPressureLanes: 'written',
  polyPressureLanes: 'written',
  smfSysEx: 'written',
  scoreAnnotations: 'not-content',
};
