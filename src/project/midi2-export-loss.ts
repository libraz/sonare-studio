/**
 * What a MIDI 2.0 Clip File export drops. The native writer
 * (Project.exportClipFile) receives only the engine's tempo map and MIDI clip
 * events, so everything else the document holds is declared here against the
 * same field tables the SMF writer uses.
 */

import {
  type FieldDispositions,
  type LossReport,
  LossTally,
  tallyFields,
} from '@/export/loss-descriptor';
import type { DocumentClip, DocumentTrack, ProjectDocument } from './serialization';
import {
  MIDI_EXPORT_LOSS_KINDS,
  type MidiExportLossKind,
  type MidiExportTrackContext,
  midiExportTrackContext,
  SMF_CLIP_FIELDS,
  SMF_DOCUMENT_FIELDS,
  SMF_TRACK_FIELDS,
} from './smf-export-loss';

const MIDI2_DOCUMENT_FIELDS: FieldDispositions<ProjectDocument, MidiExportLossKind> = {
  ...SMF_DOCUMENT_FIELDS,
  markers: { lost: 'markers' },
  sections: { lost: 'markers' },
};

const MIDI2_TRACK_FIELDS: FieldDispositions<
  DocumentTrack,
  MidiExportLossKind,
  MidiExportTrackContext
> = {
  ...SMF_TRACK_FIELDS,
  volume: {
    lost: 'trackMixLevels',
    count: (volume, track) => (volume !== 1 || (track.mixer?.gainDb ?? 0) !== 0 ? 1 : 0),
  },
  pan: { lost: 'trackMixLevels', count: (pan, track) => ((track.mixer?.pan ?? pan) !== 0 ? 1 : 0) },
  vcaId: { lost: 'trackMixLevels' },
  instrument: { lost: 'instrumentTracks' },
};

const MIDI2_CLIP_FIELDS: FieldDispositions<DocumentClip, MidiExportLossKind> = {
  ...SMF_CLIP_FIELDS,
  gain: { lost: 'clipGains', count: (gain) => (gain !== 1 ? 1 : 0) },
  ccLanes: { lost: 'expressionLanes' },
  pitchBendLanes: { lost: 'expressionLanes' },
  programChangeLanes: { lost: 'expressionLanes' },
  channelPressureLanes: { lost: 'expressionLanes' },
  polyPressureLanes: { lost: 'expressionLanes' },
  smfSysEx: { lost: 'sysExPackets' },
};

/** Lists every document feature Project.exportClipFile cannot receive. */
export function inspectMidi2ClipExportLoss(doc: ProjectDocument): LossReport<MidiExportLossKind> {
  const loss = new LossTally(MIDI_EXPORT_LOSS_KINDS);
  tallyFields(loss, MIDI2_DOCUMENT_FIELDS, doc, undefined);
  const context = midiExportTrackContext(doc);
  for (const track of doc.tracks) {
    if (track.kind !== 'midi') {
      if (track.clips.length > 0) loss.add('nonMidiTracks', 1, track.name);
      continue;
    }
    tallyFields(loss, MIDI2_TRACK_FIELDS, track, context);
    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') === 'midi') tallyFields(loss, MIDI2_CLIP_FIELDS, clip, undefined);
    }
  }
  return loss.report();
}
