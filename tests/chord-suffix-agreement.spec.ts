import { type ChordQuality, chordPitchClasses } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { editorChordToChord } from '@/compose/chord-io';
import { chordSuffix, libcantusQualityToEditor, QUALITY_SUFFIX } from '@/compose/chord-quality';
import type { NotatedChordSymbol, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { CHORD_QUALITY_CHOICES, chordTonePitchClasses, formatChordName } from '@/project/chords';

/**
 * The three chord-naming surfaces (score view, chord track, MusicXML
 * `<kind text>`) all resolve through src/compose/chord-quality.ts, so a chord
 * carries one name everywhere. These tests pin that agreement over the whole
 * libcantus quality union and the whole editor dropdown.
 */

const LIBCANTUS_QUALITIES = Object.keys(QUALITY_SUFFIX) as ChordQuality[];

/**
 * Qualities the editor ordinal set cannot represent, so the chord track shows
 * the nearest chord it can spell instead of the score view's name.
 */
const DEGRADED_TRACK_NAME: Readonly<Partial<Record<ChordQuality, string>>> = {
  // Power chord: no editor ordinal without a third, so it degrades to a triad.
  '5': 'C',
  // No lowered-fifth ordinal: the b5 degrades to the same pitch class the
  // editor uses for #11.
  '7b5': 'C7#11',
};

/** The chord track's name for a libcantus quality, rooted on C. */
function trackName(quality: ChordQuality): string {
  const mapped = libcantusQualityToEditor(quality);
  return formatChordName({
    startPpq: 0,
    endPpq: 4,
    rootPc: 0,
    quality: mapped.quality,
    ...(mapped.extensions === undefined ? {} : { extensions: [...mapped.extensions] }),
  });
}

/** The score view's name for a libcantus quality, rooted on C. */
function scoreName(quality: ChordQuality): string {
  return `C${QUALITY_SUFFIX[quality]}`;
}

/** Serializes a one-measure score carrying one chord symbol. */
function serializeChordSymbol(symbol: NotatedChordSymbol): Document {
  const score: NotatedScore = {
    parts: [
      {
        id: 'P1',
        name: 'Piano',
        clef: 'treble',
        measures: [
          {
            index: 0,
            startPpq: 0,
            lengthPpq: 4,
            timeSig: { beats: 4, beatUnit: 4 },
            voices: [
              {
                voice: 1,
                events: [
                  {
                    kind: 'rest',
                    pitches: [],
                    voice: 1,
                    startPpq: 0,
                    durationPpq: 4,
                    value: { base: 'whole', dots: 0 },
                    tieStart: false,
                    tieStop: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    divisions: 960,
    keyFifths: 0,
    chordSymbols: [symbol],
  };
  const doc = new DOMParser().parseFromString(serializeMusicXml(score), 'text/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

/** The `<kind text>` MusicXML exports for an editor quality plus extensions. */
function kindText(quality: number, extensions: ReadonlyArray<number> | undefined): string {
  const doc = serializeChordSymbol({
    ppq: 0,
    text: `C${chordSuffix(quality, extensions)}`,
    rootPc: 0,
    quality,
    ...(extensions === undefined ? {} : { extensions: [...extensions] }),
  });
  const kind = doc.querySelector('kind');
  if (kind === null) throw new Error('missing <kind>');
  return kind.getAttribute('text') ?? '';
}

describe('score view and chord track chord names', () => {
  it.each(LIBCANTUS_QUALITIES)('agrees on %s', (quality) => {
    expect(trackName(quality)).toBe(DEGRADED_TRACK_NAME[quality] ?? scoreName(quality));
  });

  it('degrades exactly two qualities the editor cannot spell', () => {
    const degraded = LIBCANTUS_QUALITIES.filter(
      (quality) => trackName(quality) !== scoreName(quality),
    );
    expect(degraded).toEqual(['5', '7b5']);
  });

  it('spells every suffix in ASCII', () => {
    for (const quality of LIBCANTUS_QUALITIES) {
      expect(QUALITY_SUFFIX[quality]).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});

describe('editor quality choices', () => {
  it.each(CHORD_QUALITY_CHOICES)('names $label the same way everywhere', (choice) => {
    expect(
      formatChordName({
        startPpq: 0,
        endPpq: 4,
        rootPc: 0,
        quality: choice.quality,
        ...(choice.extensions === undefined ? {} : { extensions: [...choice.extensions] }),
      }),
    ).toBe(`C${choice.suffix}`);
    expect(kindText(choice.quality, choice.extensions)).toBe(choice.suffix);
  });
});

describe('naming a chord does not change the chord', () => {
  // Resolving a name goes through the libcantus quality bridge, and a quality
  // may sound a different tone set than the editor combination that reached it
  // (libcantus's `11` omits the third an editor dominant-eleventh sounds). A
  // name may be taken from such a quality; the chord may not, so a dropdown
  // entry sounds exactly the tones it declares.
  //
  // The altered dominant is the one deliberate exception: its flat thirteenth
  // stands in for the perfect fifth rather than sitting beside it, so the chord
  // sounds one tone fewer than the combination lists.
  const OMITS_A_DECLARED_TONE: Readonly<Record<string, number>> = { '7alt': 7 };

  it.each(CHORD_QUALITY_CHOICES)('sounds the tones $label declares', (choice) => {
    const symbol = {
      startPpq: 0,
      endPpq: 4,
      rootPc: 0,
      quality: choice.quality,
      ...(choice.extensions === undefined ? {} : { extensions: [...choice.extensions] }),
    };
    const omitted = OMITS_A_DECLARED_TONE[choice.suffix];
    const declared = chordTonePitchClasses(symbol).filter((pc) => pc !== omitted);
    expect(chordPitchClasses(editorChordToChord(symbol)).sort((a, b) => a - b)).toEqual(declared);
  });
});

describe('consolidated chord suffixes', () => {
  it('spells a major flat five in ASCII', () => {
    expect(chordSuffix(0, [6])).toBe('majb5');
    expect(trackName('majb5')).toBe('Cmajb5');
  });

  it('names the minor-major extensions as chords rather than added tones', () => {
    expect(trackName('minMaj9')).toBe('Cm(maj9)');
    expect(trackName('minMaj11')).toBe('Cm(maj11)');
    expect(trackName('minMaj13')).toBe('Cm(maj13)');
  });

  it('names a dominant with #9 and b13 as the altered dominant', () => {
    const altered = CHORD_QUALITY_CHOICES.find((choice) => choice.label === 'Dominant 7 #9 b13');
    expect(altered?.suffix).toBe('7alt');
    expect(chordSuffix(4, [3, 8])).toBe('7alt');
    expect(kindText(4, [3, 8])).toBe('7alt');
  });

  it('names sus4 with a ninth and a seventh, which libcantus has no quality for', () => {
    expect(chordSuffix(8, [2, 10])).toBe('9sus4');
    expect(kindText(8, [2, 10])).toBe('9sus4');
  });

  it('falls back to the base suffix plus generic extension labels', () => {
    expect(chordSuffix(4, [1, 6])).toBe('7(b9,#11)');
    expect(chordSuffix(8, [4])).toBe('sus4(add3)');
  });
});
