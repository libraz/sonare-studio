/**
 * Built-in project templates as plain {@link ProjectDocument}s. Load one with
 * loadProjectDocument from src/project/serialization.ts.
 */

import { namedScaleMask } from '@libraz/libcantus';
import { makeDemoNotes } from '@/engine/instruments';
import { PITCH_RANGE_PRESETS, type PitchRange } from './pitch-range';
import type {
  DocumentClip,
  DocumentNote,
  DocumentSection,
  DocumentTrack,
  ProjectDocument,
} from './serialization';
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
  piano: 'acoustic-piano',
  guitar: 'electric-guitar',
  pad: 'warm-pad',
  lead: 'saw-lead',
  pluck: 'pluck',
  organ: 'organ',
  brass: 'brass',
  churchOrgan: 'church-organ',
} as const;

/** Names of the built-in templates accepted by {@link createTemplate}. */
export const TEMPLATE_NAMES = [
  'empty',
  'band',
  'jpop',
  'baroque-organ',
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

/** J-pop template length: 96 four-beat bars (3:12 at 120 BPM). */
const JPOP_CLIP_LENGTH_PPQ = 384;

/** Baroque organ template length: 64 four-beat bars (3:12 at 80 BPM). */
const BAROQUE_ORGAN_CLIP_LENGTH_PPQ = 256;

/** Harmonic-minor scale mask supplied by the shared libcantus vocabulary. */
const HARMONIC_MINOR_MODE_MASK = (() => {
  const mask = namedScaleMask('harmonicMinor');
  if (mask === undefined)
    throw new Error('The libcantus scale vocabulary is missing harmonicMinor');
  return mask;
})();

/** Builds one empty MIDI clip spanning the template's default length. */
function emptyClip(name: string, lengthPpq = TEMPLATE_CLIP_LENGTH_PPQ): DocumentClip {
  return {
    name,
    startPpq: 0,
    lengthPpq,
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
interface MidiTrackOptions {
  clipLengthPpq?: number;
  pitchRange?: PitchRange;
  percussion?: boolean;
}

function midiTrack(
  name: string,
  color: string,
  preset?: string,
  options: MidiTrackOptions = {},
): DocumentTrack {
  const track: DocumentTrack = {
    name,
    color,
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [emptyClip(name, options.clipLengthPpq)],
  };
  if (preset !== undefined) track.instrument = { kind: 'synth-preset', preset };
  if (options.pitchRange !== undefined) track.pitchRange = { ...options.pitchRange };
  if (options.percussion !== undefined) track.percussion = options.percussion;
  return track;
}

/** Builds a document skeleton shared by all templates. */
interface BaseDocumentOptions {
  tempoBpm?: number;
  scaleHighlight?: ProjectDocument['scaleHighlight'];
  sections?: ReadonlyArray<DocumentSection>;
}

function baseDocument(
  name: string,
  tracks: DocumentTrack[],
  options: BaseDocumentOptions = {},
): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: TEMPLATE_SAMPLE_RATE,
    tempoSegments: [{ startPpq: 0, bpm: options.tempoBpm ?? TEMPLATE_TEMPO_BPM }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks,
    markers: [],
    sections: options.sections?.map((section) => ({ ...section })) ?? [],
    ...(options.scaleHighlight !== undefined
      ? { scaleHighlight: { ...options.scaleHighlight } }
      : {}),
  };
}

interface SectionSpec {
  name: string;
  bars: number;
}

/** Expands named 4/4 bar ranges into fresh, displayable timeline sections. */
function makeSections(specs: ReadonlyArray<SectionSpec>): DocumentSection[] {
  let startPpq = 0;
  return specs.map((spec, index) => {
    const section = {
      name: spec.name,
      color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
      startPpq,
      endPpq: startPpq + spec.bars * 4,
    };
    startPpq = section.endPpq;
    return section;
  });
}

const JPOP_SECTIONS: ReadonlyArray<SectionSpec> = [
  { name: 'Intro', bars: 8 },
  { name: 'Verse', bars: 16 },
  { name: 'Pre-chorus', bars: 8 },
  { name: 'Chorus', bars: 16 },
  { name: 'Verse', bars: 16 },
  { name: 'Pre-chorus', bars: 8 },
  { name: 'Final chorus', bars: 16 },
  { name: 'Outro', bars: 8 },
];

const BAROQUE_ORGAN_SECTIONS: ReadonlyArray<SectionSpec> = [
  { name: 'Prelude', bars: 16 },
  { name: 'Exposition', bars: 16 },
  { name: 'Episode I', bars: 8 },
  { name: 'Middle entry', bars: 8 },
  { name: 'Final entry', bars: 8 },
  { name: 'Coda', bars: 8 },
];

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
          ['Piano', '#60a5fa', PRESET.piano],
          ['Guitar', '#34d399', PRESET.guitar],
          ['Vocal', '#f472b6', PRESET.pad],
        ]),
      );
    case 'jpop':
      return baseDocument(
        'J-pop song',
        [
          midiTrack('Drums', '#f87171', PRESET.drums, {
            clipLengthPpq: JPOP_CLIP_LENGTH_PPQ,
            percussion: true,
          }),
          midiTrack('Bass', '#fbbf24', PRESET.bass, {
            clipLengthPpq: JPOP_CLIP_LENGTH_PPQ,
            pitchRange: PITCH_RANGE_PRESETS.bass,
          }),
          midiTrack('Backing', '#60a5fa', PRESET.piano, {
            clipLengthPpq: JPOP_CLIP_LENGTH_PPQ,
          }),
          midiTrack('Lead', '#f472b6', PRESET.lead, {
            clipLengthPpq: JPOP_CLIP_LENGTH_PPQ,
            pitchRange: PITCH_RANGE_PRESETS.soprano,
          }),
        ],
        { sections: makeSections(JPOP_SECTIONS) },
      );
    case 'baroque-organ':
      return baseDocument(
        'Baroque organ',
        [
          midiTrack('Manual I Soprano', '#60a5fa', PRESET.churchOrgan, {
            clipLengthPpq: BAROQUE_ORGAN_CLIP_LENGTH_PPQ,
            pitchRange: PITCH_RANGE_PRESETS.soprano,
          }),
          midiTrack('Manual I Alto', '#34d399', PRESET.churchOrgan, {
            clipLengthPpq: BAROQUE_ORGAN_CLIP_LENGTH_PPQ,
            pitchRange: PITCH_RANGE_PRESETS.alto,
          }),
          midiTrack('Manual II Tenor', '#a78bfa', PRESET.churchOrgan, {
            clipLengthPpq: BAROQUE_ORGAN_CLIP_LENGTH_PPQ,
            pitchRange: PITCH_RANGE_PRESETS.tenor,
          }),
          midiTrack('Pedal Bass', '#fbbf24', PRESET.churchOrgan, {
            clipLengthPpq: BAROQUE_ORGAN_CLIP_LENGTH_PPQ,
            pitchRange: PITCH_RANGE_PRESETS.bass,
          }),
        ],
        {
          tempoBpm: 80,
          scaleHighlight: { enabled: true, rootPc: 2, modeMask: HARMONIC_MINOR_MODE_MASK },
          sections: makeSections(BAROQUE_ORGAN_SECTIONS),
        },
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
 * Builds a sample document: one Piano track holding one 8-bar clip seeded with
 * the demo arpeggio phrase. A fixture for tests; the start screen's demo is
 * makeBwv565Document.
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
