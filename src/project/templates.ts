/**
 * Built-in project templates as plain {@link ProjectDocument}s. Load one with
 * loadProjectDocument from src/project/serialization.ts.
 */

import { makeDemoNotes } from '@/engine/instruments';
import type { DocumentClip, DocumentNote, DocumentTrack, ProjectDocument } from './serialization';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from './serialization';
import { TRACK_COLOR_PALETTE } from './types';

/** Names of the built-in templates accepted by {@link createTemplate}. */
export const TEMPLATE_NAMES = [
  'empty',
  'band',
  'gm-orchestra',
  'programming',
  'transcription',
] as const;

/** A built-in template identifier. */
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** Default tempo for template documents, in BPM. */
const TEMPLATE_TEMPO_BPM = 120;

/** Default sample rate for template documents, in Hz. */
const TEMPLATE_SAMPLE_RATE = 48000;

/** Default clip length: eight 4/4 bars in quarter-note PPQ. */
const TEMPLATE_CLIP_LENGTH_PPQ = 32;

/** Builds one empty MIDI clip spanning the template's default length. */
function emptyClip(name: string): DocumentClip {
  return {
    name,
    startPpq: 0,
    lengthPpq: TEMPLATE_CLIP_LENGTH_PPQ,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
  };
}

/** Builds one MIDI track with a single empty clip. */
function midiTrack(name: string, color: string): DocumentTrack {
  return {
    name,
    color,
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [emptyClip(name)],
  };
}

/** Builds a document skeleton shared by all templates. */
function baseDocument(name: string, tracks: DocumentTrack[]): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: TEMPLATE_SAMPLE_RATE,
    tempoSegments: [{ startPpq: 0, bpm: TEMPLATE_TEMPO_BPM }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks,
    markers: [],
    sections: [],
  };
}

/** Builds tracks from (name, color) pairs. */
function tracksFrom(entries: ReadonlyArray<readonly [string, string]>): DocumentTrack[] {
  return entries.map(([name, color]) => midiTrack(name, color));
}

/**
 * Creates a fresh document for one of the built-in templates. Every track of
 * a non-empty template carries one empty 8-bar MIDI clip so the piano roll
 * has an editable target as soon as the template loads.
 *
 * @param name Template identifier.
 * @returns A new document (callers may mutate it freely).
 */
export function createTemplate(name: TemplateName): ProjectDocument {
  switch (name) {
    case 'empty':
      return baseDocument('Empty project', []);
    case 'band':
      return baseDocument(
        'Band',
        tracksFrom([
          ['Drums', '#f87171'],
          ['Bass', '#fbbf24'],
          ['Piano', '#60a5fa'],
          ['Guitar', '#34d399'],
          ['Vocal', '#f472b6'],
        ]),
      );
    case 'gm-orchestra':
      return baseDocument(
        'GM orchestra',
        tracksFrom([
          ['Violins I', '#60a5fa'],
          ['Violins II', '#3b82f6'],
          ['Violas', '#818cf8'],
          ['Cellos', '#a78bfa'],
          ['Contrabasses', '#7c3aed'],
          ['Flutes', '#34d399'],
          ['Oboes', '#2dd4bf'],
          ['Clarinets', '#4ade80'],
          ['Bassoons', '#16a34a'],
          ['Horns', '#fbbf24'],
          ['Trumpets', '#fb923c'],
          ['Trombones', '#f97316'],
          ['Tuba', '#d97706'],
          ['Timpani', '#f87171'],
          ['Percussion', '#ef4444'],
        ]),
      );
    case 'programming':
      return baseDocument(
        'Programming',
        tracksFrom([
          ['Lead Synth', '#60a5fa'],
          ['Pad', '#a78bfa'],
          ['Pluck', '#34d399'],
          ['Synth Bass', '#fbbf24'],
          ['Drums', '#f87171'],
        ]),
      );
    case 'transcription':
      return baseDocument('Transcription', [midiTrack('Piano', TRACK_COLOR_PALETTE[0])]);
    default: {
      const exhaustive: never = name;
      throw new RangeError(`Unknown template: ${String(exhaustive)}`);
    }
  }
}

/**
 * Builds the first-run demo document: one Piano track holding one 8-bar clip
 * seeded with the demo arpeggio phrase (the same content the app used to
 * seed into its single implicit clip on startup).
 *
 * @returns A new document (callers may mutate it freely).
 */
export function makeDemoDocument(): ProjectDocument {
  const notes: DocumentNote[] = makeDemoNotes().map((note) => ({
    pitch: note.note,
    velocity: note.velocity,
    startPpq: note.startPpq,
    durationPpq: note.durationPpq,
    channel: note.channel ?? 0,
  }));
  const track = midiTrack('Piano', TRACK_COLOR_PALETTE[0]);
  track.clips[0].notes = notes;
  return baseDocument('Demo', [track]);
}
