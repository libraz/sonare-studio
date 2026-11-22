/**
 * Demo song builder: J.S. Bach's Toccata and Fugue in D minor, BWV 565 (public
 * domain), as a four-voice MIDI project rendered with the built-in organ preset.
 *
 * The note content lives in the sibling `bwv565.json` asset (notes encoded as
 * compact `[pitch, velocity, startPpq, durationPpq]` tuples in quarter-note
 * units). It is loaded with a dynamic import so the ~80 KB payload stays out of
 * the initial bundle and is fetched only when the user opens the demo from the
 * start screen.
 */

import { NATURAL_MINOR_MASK } from '@libraz/libcantus';
import {
  type DocumentClip,
  type DocumentNote,
  type DocumentTrack,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
import { TRACK_COLOR_PALETTE } from '@/project/types';

/** Sample rate of the demo document, in Hz. */
const DEMO_SAMPLE_RATE = 48000;

/** Built-in pipe-organ physical model preset used for every voice. */
const DEMO_PRESET = 'churchOrgan';

/** Curated playback tempo markers for the demo's major structural changes. */
const BWV565_PLAYBACK_TEMPO_SEGMENTS = [
  { startPpq: 0, bpm: 30 },
  { startPpq: 13, bpm: 80 },
  { startPpq: 68, bpm: 70 },
  { startPpq: 94, bpm: 100 },
  { startPpq: 114, bpm: 50 },
  { startPpq: 128, bpm: 90 },
  { startPpq: 511.5, bpm: 30 },
  { startPpq: 516, bpm: 70 },
  { startPpq: 532, bpm: 50 },
  { startPpq: 539, bpm: 80 },
  { startPpq: 566, bpm: 60 },
  { startPpq: 574, bpm: 40 },
] as const;

/** Shape of the generated `bwv565.json` asset. */
interface Bwv565Asset {
  name: string;
  /** Full piece length in quarter-note PPQ. */
  lengthPpq: number;
  tempoSegments: Array<{ startPpq: number; bpm: number }>;
  timeSignatures: Array<{ startPpq: number; numerator: number; denominator: number }>;
  /** One entry per voice; notes are `[pitch, velocity, startPpq, durationPpq]`. */
  tracks: Array<{ name: string; notes: Array<[number, number, number, number]> }>;
}

/**
 * Builds the BWV 565 demo document. Each voice becomes one MIDI track holding a
 * single clip that spans the whole piece, played by the organ preset and routed
 * to its own MIDI channel.
 *
 * @returns A new document (callers may mutate it freely).
 */
export async function makeBwv565Document(): Promise<ProjectDocument> {
  const asset = (await import('./bwv565.json')).default as Bwv565Asset;
  const tracks: DocumentTrack[] = asset.tracks.map((voice, index) => {
    const notes: DocumentNote[] = voice.notes.map(([pitch, velocity, startPpq, durationPpq]) => ({
      pitch,
      velocity,
      startPpq,
      durationPpq,
      channel: index,
    }));
    const clip: DocumentClip = {
      name: voice.name,
      startPpq: 0,
      lengthPpq: asset.lengthPpq,
      sourceOffsetPpq: 0,
      gain: 1,
      loopEnabled: false,
      loopLengthPpq: 0,
      notes,
    };
    return {
      name: voice.name,
      color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [clip],
      instrument: { kind: 'synth-preset', preset: DEMO_PRESET },
    };
  });
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: asset.name,
    sampleRate: DEMO_SAMPLE_RATE,
    tempoSegments: BWV565_PLAYBACK_TEMPO_SEGMENTS.map((segment) => ({ ...segment })),
    timeSignatures: asset.timeSignatures.map((segment) => ({ ...segment })),
    scaleHighlight: { enabled: true, rootPc: 2, modeMask: NATURAL_MINOR_MASK },
    score: { fullScoreEnabled: true, displayQuantizeKey: '64' },
    tracks,
    markers: [],
    sections: [],
  };
}
