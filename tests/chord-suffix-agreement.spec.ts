import { type ChordQuality, chordPitchClasses, makeChord } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { editorChordToChord } from '@/compose/chord-io';
import { chordSuffix, QUALITY_SUFFIX } from '@/compose/chord-quality';
import type { NotatedChordSymbol, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import { CHORD_QUALITY_CHOICES, chordTonePitchClasses, formatChordName } from '@/project/chords';
import { editorSymbolForQuality, LIBCANTUS_QUALITIES } from './helpers/chord-qualities';

/**
 * The three chord-naming surfaces (score view, chord track, MusicXML
 * `<kind text>`) all resolve through src/compose/chord-quality.ts, so a chord
 * carries one name everywhere. These tests pin that agreement over the whole
 * libcantus quality union and the whole editor dropdown.
 */

/** The editor symbol a libcantus quality maps to, rooted on C. */
function editorSymbol(quality: ChordQuality) {
  return editorSymbolForQuality(quality);
}

/** The chord track's name for a libcantus quality, rooted on C. */
function trackName(quality: ChordQuality): string {
  return formatChordName(editorSymbol(quality));
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

/** The `<kind text>` MusicXML exports for an editor quality and its tones. */
function kindText(
  quality: number,
  extensions: ReadonlyArray<number> | undefined,
  omissions?: ReadonlyArray<number>,
): string {
  const doc = serializeChordSymbol({
    ppq: 0,
    text: `C${chordSuffix(quality, extensions, omissions)}`,
    rootPc: 0,
    quality,
    ...(extensions === undefined ? {} : { extensions: [...extensions] }),
    ...(omissions === undefined ? {} : { omissions: [...omissions] }),
  });
  const kind = doc.querySelector('kind');
  if (kind === null) throw new Error('missing <kind>');
  return kind.getAttribute('text') ?? '';
}

describe('score view and chord track chord names', () => {
  it.each(LIBCANTUS_QUALITIES)('agrees on %s', (quality) => {
    expect(trackName(quality)).toBe(scoreName(quality));
  });

  it('names every quality in the union without degrading any of them', () => {
    const degraded = LIBCANTUS_QUALITIES.filter(
      (quality) => trackName(quality) !== scoreName(quality),
    );
    expect(degraded).toEqual([]);
  });

  // Naming is one thing, sounding another: a quality whose name survives the
  // bridge could still come back as a different chord. Omitted tones are the
  // reason it does not -- a power chord and a lowered fifth are their ordinal's
  // tone set minus a tone, which no amount of added tones could express.
  it.each(LIBCANTUS_QUALITIES)('sounds exactly the pitch classes of %s', (quality) => {
    const upstream = [...new Set(chordPitchClasses(makeChord(0, quality)))].sort((a, b) => a - b);
    expect(chordTonePitchClasses(editorSymbol(quality))).toEqual(upstream);
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
        ...(choice.omissions === undefined ? {} : { omissions: [...choice.omissions] }),
      }),
    ).toBe(`C${choice.suffix}`);
    expect(kindText(choice.quality, choice.extensions, choice.omissions)).toBe(choice.suffix);
  });
});

describe('naming a chord does not change the chord', () => {
  // Resolving a name goes through the libcantus quality bridge, and a quality
  // may sound a different tone set than the editor combination that reached it
  // (libcantus's `13` sounds a ninth a plain dominant-thirteenth need not). A
  // name may be borrowed from such a quality; the chord may not, so a dropdown
  // entry sounds exactly the tones it declares -- no exceptions.
  it.each(CHORD_QUALITY_CHOICES)('sounds the tones $label declares', (choice) => {
    const symbol = {
      startPpq: 0,
      endPpq: 4,
      rootPc: 0,
      quality: choice.quality,
      ...(choice.extensions === undefined ? {} : { extensions: [...choice.extensions] }),
      ...(choice.omissions === undefined ? {} : { omissions: [...choice.omissions] }),
    };
    expect(chordPitchClasses(editorChordToChord(symbol)).sort((a, b) => a - b)).toEqual(
      chordTonePitchClasses(symbol),
    );
  });
});

describe('consolidated chord suffixes', () => {
  it('names a major flat five only when the fifth is actually absent', () => {
    expect(chordSuffix(0, [6], [7])).toBe('majb5');
    expect(trackName('majb5')).toBe('Cmajb5');
    // The same raised eleventh over an intact triad is a different chord.
    expect(chordSuffix(0, [6])).toBe('(#11)');
  });

  it('names the minor-major extensions as chords rather than added tones', () => {
    expect(trackName('minMaj9')).toBe('Cm(maj9)');
    expect(trackName('minMaj11')).toBe('Cm(maj11)');
    expect(trackName('minMaj13')).toBe('Cm(maj13)');
  });

  it('names a dominant with #9 and b13 as the altered dominant', () => {
    const altered = CHORD_QUALITY_CHOICES.find((choice) => choice.label === 'Dominant 7 #9 b13');
    expect(altered?.suffix).toBe('7alt');
    expect(chordSuffix(4, [3, 8], [7])).toBe('7alt');
    expect(kindText(4, [3, 8], [7])).toBe('7alt');
  });

  it('names sus4 with a ninth and a seventh, which libcantus has no quality for', () => {
    expect(chordSuffix(8, [2, 10])).toBe('9sus4');
    expect(kindText(8, [2, 10])).toBe('9sus4');
  });

  it('names a power chord and a third-less eleventh from their omissions', () => {
    expect(chordSuffix(0, [], [4])).toBe('5');
    expect(chordSuffix(4, [2, 5], [4])).toBe('11');
    expect(kindText(0, [], [4])).toBe('5');
  });

  it('names a thirteenth without borrowing the ninth libcantus gives it', () => {
    expect(chordSuffix(4, [9])).toBe('13');
    expect(
      chordTonePitchClasses({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 4, extensions: [9] }),
    ).toEqual([0, 4, 7, 9, 10]);
  });

  it('falls back to the base suffix plus generic extension and omission labels', () => {
    expect(chordSuffix(4, [1, 6])).toBe('7(b9,#11)');
    expect(chordSuffix(8, [4])).toBe('sus4(add3)');
    expect(chordSuffix(4, [], [7])).toBe('7(omit5)');
  });
});
