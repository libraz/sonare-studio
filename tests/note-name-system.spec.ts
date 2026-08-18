import {
  formatNote,
  midiToNote,
  type NoteNameSystem,
  noteToMidi,
  parseNote,
} from '@libraz/libcantus';
import { afterEach, describe, expect, it } from 'vitest';
import { keyLabel } from '@/components/lists/key-modes';
import { useAppSettings } from '@/composables/useAppSettings';
import { useNoteNames } from '@/composables/useNoteNames';
import { buildTheoryCard, theoryLabelsFor } from '@/compose/explain';
import { buildGuidance, type NoteAnalysis } from '@/compose/guidance';
import {
  formatPitch,
  formatSpelledPitch,
  PITCH_CLASS_NAMES,
  parsePitch,
  pitchClassNames,
} from '@/lib/pitch';
import type { NotatedMeasure, NotatedScore, NoteValue } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { chordPitchClassName } from '@/notation/pitch-spelling';
import { decodeSzd, encodeSzd } from '@/persistence/szd';
import { type EditorChordSymbol, formatChordName } from '@/project/chords';
import { PROJECT_DOCUMENT_SCHEMA_VERSION, type ProjectDocument } from '@/project/serialization';
import { MESSAGES } from '@/ui/i18n';
import { formatMidiNote } from '@/ui/sample-editor/note-names';
import { rootOptions, scaleName } from '@/ui/sample-editor/scales';
import { transposeChordSymbols } from '@/ui/score/use-score-notation';

/** Every offered system, so a new one cannot be added without a table row. */
const SYSTEMS: ReadonlyArray<NoteNameSystem> = [
  'english',
  'german',
  'japanese',
  'italian',
  'fixedDo',
];

const appSettings = useAppSettings();

/** Runs `run` with the note-name preference set, restoring it afterwards. */
function withSystem<T>(system: NoteNameSystem, run: () => T): T {
  appSettings.set('noteNameSystem', system);
  try {
    return run();
  } finally {
    appSettings.set('noteNameSystem', 'english');
  }
}

afterEach(() => {
  appSettings.set('noteNameSystem', 'english');
});

/**
 * A D-minor cadential step A3 - C#4 - D4, analyzed. The raised leading tone is
 * chromatic in the key, so its letter is decided by the line rather than by the
 * key signature, and the card's title is whatever that reading names.
 */
const D_MINOR_LEADING_TONE = buildGuidance({
  notes: [
    { id: 1, pitch: 57, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
    { id: 2, pitch: 61, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
    { id: 3, pitch: 62, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 },
  ],
  clipStartPpq: 0,
  clipLengthPpq: 4,
  chordSymbols: [],
  // Natural minor {0,2,3,5,7,8,10} on D.
  key: { enabled: true, rootPc: 2, modeMask: 0b010110101101 },
  timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
});

/** Chord symbols carrying a root, a bass and an accidental in their text. */
const CHORD_SYMBOLS: ReadonlyArray<EditorChordSymbol> = [
  { startPpq: 0, endPpq: 4, rootPc: 1, quality: 5 },
  { startPpq: 4, endPpq: 8, rootPc: 9, quality: 6, bassPc: 4 },
];

/** A two-measure score whose chord-symbol text comes from the export path. */
function scoreFixture(): NotatedScore {
  const quarter: NoteValue = { base: 'quarter', dots: 0 };
  const measures: NotatedMeasure[] = [0, 1].map((index) => ({
    index,
    startPpq: index * 4,
    lengthPpq: 4,
    timeSig: { beats: 4, beatUnit: 4 },
    voices: [
      {
        voice: 1,
        events: [61, 63, 66, 68].map((pitch, step) => ({
          kind: 'note' as const,
          pitches: [pitch],
          voice: 1 as const,
          startPpq: index * 4 + step,
          durationPpq: 1,
          value: quarter,
          tieStart: false,
          tieStop: false,
        })),
      },
    ],
  }));
  // transposeChordSymbols rebuilds each symbol's text through the notation
  // layer's own spelling, which is the text the exporter writes.
  const chordSymbols = transposeChordSymbols(
    [
      { ppq: 0, text: 'Cmaj7', rootPc: 0, quality: 5 },
      { ppq: 4, text: 'Am7/E', rootPc: 9, quality: 6, bassPc: 4 },
    ],
    1,
    2,
  );
  return {
    parts: [{ id: 'P1', name: 'Lead', clef: 'treble', measures }],
    keyFifths: 2,
    divisions: 960,
    chordSymbols,
  };
}

/** A project document carrying the chord track and a MIDI clip. */
function documentFixture(): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: 'Note names',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Lead',
        color: '#60a5fa',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'Theme',
            startPpq: 0,
            lengthPpq: 8,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 8,
            notes: [{ pitch: 61, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
      },
    ],
    markers: [],
    sections: [],
    chords: CHORD_SYMBOLS.map((chord) => ({ ...chord })),
  };
}

describe('interchange paths ignore the note-name system', () => {
  it('serializes byte-identical MusicXML whichever system is selected', () => {
    const english = withSystem('english', () => serializeMusicXml(scoreFixture()));
    const japanese = withSystem('japanese', () => serializeMusicXml(scoreFixture()));
    expect(japanese).toBe(english);
    // The harmony the exporter writes keeps an ASCII root and the conventional
    // suffix, and nothing in the document leaves ASCII.
    expect(japanese).toContain('<root-step>C</root-step><root-alter>1</root-alter>');
    expect(japanese).toContain('<kind text="maj7">major-seventh</kind>');
    expect([...japanese].filter((ch) => (ch.codePointAt(0) ?? 0) > 127)).toEqual([]);
  });

  it('encodes a byte-identical .szd archive whichever system is selected', () => {
    const english = withSystem('english', () => encodeSzd(documentFixture()));
    const japanese = withSystem('japanese', () => encodeSzd(documentFixture()));
    expect([...japanese]).toEqual([...english]);
    expect(decodeSzd(japanese)).toEqual(documentFixture());
  });

  it('keeps chord-symbol text ASCII when no system is named', () => {
    const named = withSystem('japanese', () => ({
      root: chordPitchClassName(1, 2),
      chord: formatChordName(CHORD_SYMBOLS[1], 0),
    }));
    expect(named).toEqual({ root: 'C#', chord: 'Am7/E' });
  });
});

describe('pitch names in each system', () => {
  it.each(SYSTEMS)('formats pitches and pitch classes in %s', (system) => {
    // Expected values come from libcantus rather than from a hand-written
    // table, so a spelling change in the library surfaces here.
    for (const midi of [0, 60, 61, 69, 70, 127]) {
      expect(formatPitch(midi, system)).toBe(formatNote(midiToNote(midi, 'sharp'), { system }));
    }
    expect(pitchClassNames(system)).toEqual(
      PITCH_CLASS_NAMES.map((name) => formatNote(parseNote(name), { system })),
    );
  });

  it('names the Japanese 音名 with 嬰 / 変 prefixes', () => {
    expect(formatPitch(68, 'japanese')).toBe('嬰ト4');
    expect(formatPitch(60, 'japanese')).toBe('ハ4');
    expect(formatSpelledPitch({ step: 'E', alter: -1, octave: 3 }, 'japanese')).toBe('変ホ3');
  });

  it('names the German B natural as H', () => {
    expect(formatPitch(71, 'german')).toBe('h4');
    expect(formatPitch(70, 'german')).toBe('ais4');
  });

  it.each(SYSTEMS)('names keys in %s', (system) => {
    // A key is written as a tonic plus a localized mode word, so only the
    // tonic follows the system; the tonic is spelled as libcantus names it.
    const labels = MESSAGES.en.shell.lists.key;
    for (const tonic of ['C', 'G#', 'Eb']) {
      const rootPc = (noteToMidi({ ...parseNote(tonic), octave: 4 }) - 60 + 12) % 12;
      expect(keyLabel(rootPc, 'minor', labels, system)).toBe(
        `${formatNote(midiToNote(60 + rootPc, 'sharp'), { system }).replace(/-?\d+$/, '')} ${labels.modes.minor}`,
      );
    }
    expect(keyLabel(0, null, labels, system)).toBe(
      `${pitchClassNames(system)[0]} ${labels.customScale}`,
    );
  });

  it('leaves the chord-symbol suffix ASCII while naming the root', () => {
    expect(formatChordName(CHORD_SYMBOLS[0], 0, 'japanese')).toBe('変ニmaj7');
    expect(formatChordName(CHORD_SYMBOLS[1], 0, 'japanese')).toBe('イm7/ホ');
    expect(formatChordName(CHORD_SYMBOLS[1], 0, 'german')).toBe('am7/e');
  });

  it.each(SYSTEMS)('titles the theory card from the engraved spelling in %s', (system) => {
    // The title carries the spelling the score engraves the note with, which
    // reaches the reader through two different paths — English is joined from
    // the step and the alteration, every other system goes through the
    // localized formatter — so both are checked against the same spelled pitch.
    const analysis = D_MINOR_LEADING_TONE.byNoteId.get(2);
    expect(analysis?.engraved).toEqual({ step: 'C', alter: 1, octave: 4 });
    if (analysis === undefined) return;
    const labels = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    const card = buildTheoryCard(
      analysis,
      { pitch: 61, keySet: true, keyFifths: -1, noteNameSystem: system },
      labels,
    );
    expect(card.title).toBe(formatSpelledPitch({ step: 'C', alter: 1, octave: 4 }, system));
  });
});

describe('the English default reproduces the previous output', () => {
  it.each([
    ['formatPitch', () => formatPitch(61), 'C#4'],
    ['pitchClassNames', () => pitchClassNames().join(' '), PITCH_CLASS_NAMES.join(' ')],
    ['chordPitchClassName', () => chordPitchClassName(3, -3), 'Eb'],
    ['formatChordName', () => formatChordName(CHORD_SYMBOLS[1], 0), 'Am7/E'],
    ['formatMidiNote', () => formatMidiNote(69), 'A4'],
    ['scaleName', () => scaleName(6, 4), 'F# Lydian'],
    ['rootOptions', () => rootOptions()[9].label, 'A'],
    [
      'keyLabel',
      () => keyLabel(0, 'major', MESSAGES.en.shell.lists.key),
      `C ${MESSAGES.en.shell.lists.key.modes.major}`,
    ],
    ['formatSpelledPitch', () => formatSpelledPitch({ step: 'B', alter: -1, octave: 2 }), 'Bb2'],
  ])('%s keeps its English output', (_name, produce, expected) => {
    expect(produce()).toBe(expected);
  });

  it('titles the theory card in English unless a system is named', () => {
    const analysis = { degree: 0, isScaleTone: false } as unknown as NoteAnalysis;
    const labels = theoryLabelsFor(MESSAGES.en.theory, 'normal', MESSAGES.en.harmony.cadence);
    expect(buildTheoryCard(analysis, { pitch: 61, keySet: false }, labels).title).toBe('C#4');
    expect(
      buildTheoryCard(analysis, { pitch: 61, keySet: false, noteNameSystem: 'japanese' }, labels)
        .title,
    ).toBe('嬰ハ4');
  });
});

describe('parsePitch input contract', () => {
  it.each([
    ['C#4', 61],
    ['db3', 49],
    ['B♭-1', 10],
    ['60', 60],
    ['  c#4 ', 61],
    ['bB3', 58],
    ['Cb4', 59],
    ['B#3', 60],
  ])('still accepts %s', (text, midi) => {
    expect(parsePitch(text)).toBe(midi);
    // The English shapes read the same whichever system is selected.
    for (const system of SYSTEMS) expect(parsePitch(text, system)).toBe(midi);
  });

  it.each(SYSTEMS)('round-trips its own names in %s', (system) => {
    for (const midi of [0, 60, 61, 69, 127]) {
      expect(parsePitch(formatPitch(midi, system), system)).toBe(midi);
    }
  });

  it('reads a system name only when that system is selected', () => {
    expect(parsePitch('嬰ハ4')).toBeNull();
    expect(parsePitch('嬰ハ4', 'japanese')).toBe(61);
    expect(parsePitch('H2')).toBeNull();
    expect(parsePitch('H2', 'german')).toBe(47);
  });

  it('rejects a name without an octave and one out of range', () => {
    expect(parsePitch('嬰ハ', 'japanese')).toBeNull();
    expect(parsePitch('ト9', 'japanese')).toBe(127);
    expect(parsePitch('嬰ト9', 'japanese')).toBeNull();
    expect(parsePitch('nonsense', 'japanese')).toBeNull();
  });
});

describe('useNoteNames', () => {
  it('defaults to English and follows the preference', () => {
    const noteNames = useNoteNames();
    expect(noteNames.system.value).toBe('english');
    expect(noteNames.formatPitch(61)).toBe('C#4');
    expect(noteNames.pitchClassNames.value[1]).toBe('C#');

    withSystem('japanese', () => {
      expect(noteNames.system.value).toBe('japanese');
      expect(noteNames.formatPitch(61)).toBe('嬰ハ4');
      expect(noteNames.pitchClassNames.value[1]).toBe('嬰ハ');
      expect(noteNames.parsePitch('嬰ハ4')).toBe(61);
      expect(noteNames.formatNoteName({ letter: 4, alter: 1 })).toBe('嬰ト');
    });
    expect(noteNames.formatPitch(61)).toBe('C#4');
  });
});
