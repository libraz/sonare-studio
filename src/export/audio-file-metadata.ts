/** Portable metadata derived from a project for rendered audio deliverables. */

import type { ProjectDocument } from '@/project/serialization';
import { normalizeTempoMap, ppqToSamples } from '@/project/tempo-map';

/** A named sample position in an encoded audio file. */
export interface AudioFileMarker {
  sampleOffset: number;
  name: string;
}

/** Codec-neutral metadata supported by the built-in WAV and FLAC encoders. */
export interface AudioFileMetadata {
  title?: string;
  originator?: string;
  originatorReference?: string;
  originationDate?: string;
  originationTime?: string;
  /** Absolute time reference in samples. Mixdowns begin at zero by default. */
  timeReference?: number;
  markers?: readonly AudioFileMarker[];
}

function localBwfTimestamp(
  now: Date,
): Pick<AudioFileMetadata, 'originationDate' | 'originationTime'> {
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    originationDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    originationTime: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  };
}

/**
 * Converts visible project cues into sample-accurate delivery metadata.
 * Positions are relative to the rendered window, so a loop export keeps
 * markers aligned with the audio rather than with the full project timeline.
 */
export function audioFileMetadataForDocument(
  doc: ProjectDocument,
  options: { sampleRate: number; startPpq?: number; endPpq?: number; now?: Date },
): AudioFileMetadata {
  const startPpq = options.startPpq ?? 0;
  const endPpq = options.endPpq ?? Number.POSITIVE_INFINITY;
  const map = normalizeTempoMap(doc.tempoSegments);
  const startSample = ppqToSamples(map, startPpq, options.sampleRate);
  const cuePoints = [
    ...doc.markers.map((marker) => ({ ppq: marker.ppq, name: marker.name })),
    ...doc.sections.map((section) => ({ ppq: section.startPpq, name: `Section: ${section.name}` })),
  ]
    .filter(
      (marker) => Number.isFinite(marker.ppq) && marker.ppq >= startPpq && marker.ppq <= endPpq,
    )
    .map((marker) => ({
      sampleOffset: ppqToSamples(map, marker.ppq, options.sampleRate) - startSample,
      name: marker.name,
    }))
    .filter((marker) => marker.sampleOffset >= 0 && marker.sampleOffset <= 0xffff_ffff)
    .sort((a, b) => a.sampleOffset - b.sampleOffset || a.name.localeCompare(b.name));
  return {
    title: doc.name,
    originator: 'Sonare Studio',
    originatorReference: doc.name,
    ...localBwfTimestamp(options.now ?? new Date()),
    timeReference: 0,
    markers: cuePoints,
  };
}
