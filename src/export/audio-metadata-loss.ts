/**
 * What each audio encoder writes of the delivery metadata
 * ({@link AudioFileMetadata}). A new metadata field fails the type check here
 * until every encoder declares it; an encoder missing from the table writes
 * none of it.
 */

import type { AudioFileMetadata } from './audio-file-metadata';
import { type AudioEncoder, WAV_ENCODER_ID } from './codecs';
import { FLAC_ENCODER_ID } from './flac';
import { type FieldDispositions, type LossReport, LossTally, tallyFields } from './loss-descriptor';
import { MP3_ENCODER_ID } from './mp3';

/** Every class the audio export loss dialog can list. */
export const AUDIO_EXPORT_LOSS_KINDS = ['markers'] as const;

export type AudioExportLossKind = (typeof AUDIO_EXPORT_LOSS_KINDS)[number];

type MetadataDispositions = FieldDispositions<AudioFileMetadata, AudioExportLossKind>;

// Identification fields are conveniences; only markers carry project content.
const NO_METADATA: MetadataDispositions = {
  title: 'not-content',
  originator: 'not-content',
  originatorReference: 'not-content',
  originationDate: 'not-content',
  originationTime: 'not-content',
  timeReference: 'not-content',
  markers: { lost: 'markers' },
};

const WRITTEN_METADATA: Readonly<Record<string, MetadataDispositions>> = {
  // BWF bext plus cue points.
  [WAV_ENCODER_ID]: {
    title: 'written',
    originator: 'written',
    originatorReference: 'written',
    originationDate: 'written',
    originationTime: 'written',
    timeReference: 'written',
    markers: 'written',
  },
  // Vorbis comment.
  [FLAC_ENCODER_ID]: {
    ...NO_METADATA,
    title: 'written',
    originator: 'written',
    originationDate: 'written',
    originationTime: 'written',
  },
  // ID3v2 TIT2/TPE1.
  [MP3_ENCODER_ID]: { ...NO_METADATA, title: 'written', originator: 'written' },
};

/**
 * Lists the project metadata the selected formats cannot store, naming the
 * formats in the entry details.
 */
export function inspectAudioExportLoss(
  metadata: AudioFileMetadata,
  encoders: ReadonlyArray<Pick<AudioEncoder, 'id' | 'label'>>,
): LossReport<AudioExportLossKind> {
  // A marker dropped by several formats is one loss; the details name the formats.
  const dropped = new Map<AudioExportLossKind, { count: number; formats: string[] }>();
  for (const encoder of encoders) {
    const perFormat = new LossTally(AUDIO_EXPORT_LOSS_KINDS);
    tallyFields(perFormat, WRITTEN_METADATA[encoder.id] ?? NO_METADATA, metadata, undefined);
    for (const entry of perFormat.report().entries) {
      const record = dropped.get(entry.kind) ?? { count: entry.count, formats: [] };
      record.formats.push(encoder.label);
      dropped.set(entry.kind, record);
    }
  }
  const loss = new LossTally(AUDIO_EXPORT_LOSS_KINDS);
  for (const [kind, record] of dropped) loss.add(kind, record.count, record.formats.join(', '));
  return loss.report();
}
