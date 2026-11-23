/**
 * What a MusicXML export cannot carry, tallied per project field for the
 * export loss dialog.
 */

import {
  type FieldDispositions,
  type LossReport,
  LossTally,
  tallyFields,
} from '@/export/loss-descriptor';
import type {
  DocumentAutomationLane,
  DocumentClip,
  DocumentTrack,
  ProjectDocument,
} from '@/project/serialization';
import { PPQ_EPSILON } from './musicxml-shared';

/** Every class the MusicXML export loss dialog can list, in dialog order. */
export const MUSICXML_EXPORT_LOSS_KINDS = [
  'nonMidiTracks',
  'offGridNotes',
  'expressionLanes',
  'sysExPackets',
  'automationLanes',
  'tempoRamps',
] as const;

export type MusicXmlExportLossKind = (typeof MUSICXML_EXPORT_LOSS_KINDS)[number];

interface MusicXmlExportContext {
  /** Display quantize grid the score is engraved on, in PPQ. */
  divisionPpq: number;
}

function offGrid(value: number, divisionPpq: number): boolean {
  if (!(divisionPpq > 0)) return false;
  const steps = value / divisionPpq;
  return Math.abs(steps - Math.round(steps)) * divisionPpq > PPQ_EPSILON;
}

function enabledLaneCount(lanes: ReadonlyArray<DocumentAutomationLane> | undefined): number {
  return (lanes ?? []).filter((lane) => lane.enabled && lane.points.length > 0).length;
}

// The score is notation: mixer, instrument and session state is outside what
// MusicXML models, so only musical content the engraving cannot show is lost.
const DOCUMENT_FIELDS: FieldDispositions<
  ProjectDocument,
  MusicXmlExportLossKind,
  MusicXmlExportContext
> = {
  schemaVersion: 'derived',
  name: 'written',
  sampleRate: 'not-content',
  tempoSegments: {
    lost: 'tempoRamps',
    count: (segments) =>
      segments.filter(
        (segment, index) =>
          index < segments.length - 1 &&
          segment.endBpm !== undefined &&
          segment.endBpm !== segment.bpm,
      ).length,
  },
  timeSignatures: 'written',
  pickupLengthPpq: 'written',
  generationSeed: 'not-content',
  scaleHighlight: 'written',
  tracks: 'written',
  markers: 'written',
  sections: 'written',
  masterAutomation: { lost: 'automationLanes', count: enabledLaneCount },
  chords: 'written',
  mixer: {
    lost: 'automationLanes',
    count: (mixer) =>
      (mixer?.buses ?? []).reduce((n, bus) => n + enabledLaneCount(bus.automation), 0),
  },
  externalMidiDefault: 'not-content',
  score: 'written',
  midiCcBindings: 'not-content',
  controlSurface: 'not-content',
  mixerSnapshots: 'not-content',
};

const TRACK_FIELDS: FieldDispositions<
  DocumentTrack,
  MusicXmlExportLossKind,
  MusicXmlExportContext
> = {
  name: 'written',
  musicXmlPartId: 'written',
  color: 'not-content',
  kind: 'written',
  mute: 'not-content',
  solo: 'not-content',
  volume: 'not-content',
  pan: 'not-content',
  clips: 'written',
  instrument: 'written',
  externalMidiMode: 'not-content',
  midiFx: 'not-content',
  mixer: 'not-content',
  automation: { lost: 'automationLanes', count: enabledLaneCount },
  groupIndex: 'not-content',
  soloSafe: 'not-content',
  percussion: 'written',
  generated: 'not-content',
  vcaId: 'not-content',
  role: 'not-content',
  chordFollow: 'not-content',
  expressionMap: 'not-content',
  frozen: 'not-content',
  recordInputChannel: 'not-content',
  recordInputDeviceId: 'not-content',
  pitchRange: 'not-content',
  leadFollow: 'not-content',
};

const CLIP_FIELDS: FieldDispositions<DocumentClip, MusicXmlExportLossKind, MusicXmlExportContext> =
  {
    name: 'not-content',
    startPpq: 'written',
    lengthPpq: 'written',
    sourceOffsetPpq: 'written',
    gain: 'not-content',
    loopEnabled: 'written',
    loopLengthPpq: 'written',
    notes: {
      lost: 'offGridNotes',
      count: (notes, _clip, context) =>
        notes.filter(
          (note) =>
            offGrid(note.startPpq, context.divisionPpq) ||
            offGrid(note.durationPpq, context.divisionPpq),
        ).length,
    },
    kind: 'written',
    assetId: 'not-content',
    externalStemRole: 'not-content',
    contentHash: 'not-content',
    fadeInPpq: 'not-content',
    fadeOutPpq: 'not-content',
    takes: 'not-content',
    compSegments: 'not-content',
    midiTakes: 'not-content',
    midiActiveTakeIndex: 'not-content',
    midiCompSegments: 'not-content',
    warp: 'not-content',
    ccLanes: { lost: 'expressionLanes' },
    pitchBendLanes: { lost: 'expressionLanes' },
    programChangeLanes: { lost: 'expressionLanes' },
    channelPressureLanes: { lost: 'expressionLanes' },
    polyPressureLanes: { lost: 'expressionLanes' },
    smfSysEx: { lost: 'sysExPackets' },
    scoreAnnotations: 'written',
  };

/**
 * Lists the musical content a MusicXML export of `doc` cannot carry: audio
 * tracks, expression and automation, SysEx, tempo ramps, and notes the
 * display quantize grid moves.
 *
 * @param doc The tracks and clips being engraved (one clip for a clip export).
 * @param divisionPpq Display quantize grid in PPQ.
 */
export function inspectMusicXmlExportLoss(
  doc: ProjectDocument,
  divisionPpq: number,
): LossReport<MusicXmlExportLossKind> {
  const loss = new LossTally(MUSICXML_EXPORT_LOSS_KINDS);
  const context: MusicXmlExportContext = { divisionPpq };
  tallyFields(loss, DOCUMENT_FIELDS, doc, context);
  for (const track of doc.tracks) {
    if (track.kind !== 'midi') {
      if (track.clips.length > 0) loss.add('nonMidiTracks', 1, track.name);
      continue;
    }
    tallyFields(loss, TRACK_FIELDS, track, context);
    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') === 'midi') tallyFields(loss, CLIP_FIELDS, clip, context);
    }
  }
  return loss.report();
}
