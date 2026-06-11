/**
 * Built-in project templates as plain {@link ProjectDocument}s. Load one with
 * loadProjectDocument from src/project/serialization.ts.
 */

import { makeDemoNotes } from '@/engine/instruments';
import type { DocumentClip, DocumentNote, DocumentTrack, ProjectDocument } from './serialization';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from './serialization';
import { TRACK_COLOR_PALETTE } from './types';

/**
 * NativeSynth preset names used by template instruments. The catalog is only
 * enumerable at runtime (synthPresetNames()), so templates stick to names
 * shipped by the current libsonare build; the prerender path degrades any
 * name missing from the runtime catalog to the default preset.
 */
const PRESET = {
  drums: 'drum-kit',
  bass: 'sub-bass',
  ePiano: 'e-piano',
  guitar: 'electric-guitar',
  pad: 'warm-pad',
  lead: 'saw-lead',
  pluck: 'pluck',
  organ: 'organ',
  brass: 'brass',
} as const;

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

/**
 * Builds one MIDI track with a single empty clip. When a synth preset name is
 * given the track carries it as its instrument; otherwise the track renders
 * with the default preset.
 */
function midiTrack(name: string, color: string, preset?: string): DocumentTrack {
  const track: DocumentTrack = {
    name,
    color,
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [emptyClip(name)],
  };
  if (preset !== undefined) track.instrument = { kind: 'synth-preset', preset };
  return track;
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

/** Builds tracks from (name, color, optional synth preset) tuples. */
function tracksFrom(entries: ReadonlyArray<readonly [string, string, string?]>): DocumentTrack[] {
  return entries.map(([name, color, preset]) => midiTrack(name, color, preset));
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
          ['Drums', '#f87171', PRESET.drums],
          ['Bass', '#fbbf24', PRESET.bass],
          ['Piano', '#60a5fa', PRESET.ePiano],
          ['Guitar', '#34d399', PRESET.guitar],
          ['Vocal', '#f472b6', PRESET.pad],
        ]),
      );
    case 'gm-orchestra':
      return baseDocument(
        'GM orchestra',
        tracksFrom([
          ['Violins I', '#60a5fa', PRESET.pad],
          ['Violins II', '#3b82f6', PRESET.pad],
          ['Violas', '#818cf8', PRESET.pad],
          ['Cellos', '#a78bfa', PRESET.pad],
          ['Contrabasses', '#7c3aed', PRESET.bass],
          ['Flutes', '#34d399', PRESET.organ],
          ['Oboes', '#2dd4bf', PRESET.organ],
          ['Clarinets', '#4ade80', PRESET.organ],
          ['Bassoons', '#16a34a', PRESET.organ],
          ['Horns', '#fbbf24', PRESET.brass],
          ['Trumpets', '#fb923c', PRESET.brass],
          ['Trombones', '#f97316', PRESET.brass],
          ['Tuba', '#d97706', PRESET.brass],
          ['Timpani', '#f87171', PRESET.drums],
          ['Percussion', '#ef4444', PRESET.drums],
        ]),
      );
    case 'programming':
      return baseDocument(
        'Programming',
        tracksFrom([
          ['Lead Synth', '#60a5fa', PRESET.lead],
          ['Pad', '#a78bfa', PRESET.pad],
          ['Pluck', '#34d399', PRESET.pluck],
          ['Synth Bass', '#fbbf24', PRESET.bass],
          ['Drums', '#f87171', PRESET.drums],
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
