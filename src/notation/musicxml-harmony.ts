import {
  chordSuffix,
  normalizedChordExtensions,
  normalizedChordOmissions,
} from '@/compose/chord-quality';
import {
  type NotatedChordSymbol,
  type NotatedMeasure,
  type NotatedScore,
  ppqToDivisions,
} from './model';
import { PPQ_EPSILON } from './musicxml-shared';
import { escapeXml } from './musicxml-xml';
import { spellChordPitchClass } from './pitch-spelling';

/**
 * MusicXML `<kind>` values for libsonare audio-domain `ChordQuality`
 * ordinals (Major = 0, Minor = 1, ...). Qualities without a standard
 * MusicXML kind (Add9, MinorAdd9, Sus2Add4, Unknown) are absent and fall
 * back to `<kind text="...">other</kind>`.
 */
const CHORD_QUALITY_KIND: ReadonlyMap<number, string> = new Map([
  [0, 'major'],
  [1, 'minor'],
  [2, 'diminished'],
  [3, 'augmented'],
  [4, 'dominant'],
  [5, 'major-seventh'],
  [6, 'minor-seventh'],
  [7, 'suspended-second'],
  [8, 'suspended-fourth'],
  [12, 'diminished-seventh'],
  [13, 'half-diminished'],
  [14, 'major-ninth'],
  [15, 'dominant-ninth'],
]);

/**
 * Builds MusicXML `<harmony>` elements for a chord symbol. The primary entry
 * remains a pop/jazz root-based symbol; Roman numeral text is preserved as an
 * alternate functional harmony when present.
 */
export function harmonyXml(
  symbol: NotatedChordSymbol,
  measure: NotatedMeasure,
  score: NotatedScore,
  keyFifths: number,
): string[] {
  if (!isPitchClass(symbol.rootPc)) {
    return [];
  }
  const root = spellChordPitchClass(symbol.rootPc, keyFifths);
  const rootAlter = root.alter === 0 ? '' : `<root-alter>${root.alter}</root-alter>`;
  const rootXml = `<root><root-step>${root.step}</root-step>${rootAlter}</root>`;
  const kindXml = chordKindXml(symbol);
  const degreeXml = chordDegreeXml(symbol);
  let bassXml = '';
  if (isPitchClass(symbol.bassPc)) {
    const bass = spellChordPitchClass(symbol.bassPc, keyFifths);
    const bassAlter = bass.alter === 0 ? '' : `<bass-alter>${bass.alter}</bass-alter>`;
    bassXml = `<bass><bass-step>${bass.step}</bass-step>${bassAlter}</bass>`;
  }
  const offset = ppqToDivisions(symbol.ppq - measure.startPpq, score.divisions);
  const offsetXml = offset === 0 ? '' : `<offset>${offset}</offset>`;
  const harmonies = [`<harmony>${rootXml}${kindXml}${bassXml}${degreeXml}${offsetXml}</harmony>`];
  const romanNumeral = symbol.romanNumeral?.trim();
  if (romanNumeral !== undefined && romanNumeral !== '') {
    harmonies.push(
      `<harmony type="alternate"><function>${escapeXml(romanNumeral)}</function>${kindXml}${degreeXml}${offsetXml}</harmony>`,
    );
  }
  return harmonies;
}

/** Builds a MusicXML chord kind while preserving compact display suffixes. */
function chordKindXml(symbol: NotatedChordSymbol): string {
  const quality = symbol.quality;
  const add9BaseKind = quality === 10 ? 'major' : quality === 11 ? 'minor' : undefined;
  const kindName =
    add9BaseKind ?? (quality === undefined ? undefined : CHORD_QUALITY_KIND.get(quality));
  if (kindName === undefined) {
    return `<kind text="${escapeXml(symbol.text)}">other</kind>`;
  }
  const text =
    quality === undefined ? undefined : chordKindText(quality, symbol.extensions, symbol.omissions);
  const textXml = text === undefined ? '' : ` text="${escapeXml(text)}"`;
  return `<kind${textXml}>${kindName}</kind>`;
}

/**
 * Visible `<kind text>` suffix for a base quality plus its added and omitted
 * tones, taken from the shared chord naming so the exported text matches the
 * score view and the chord track. A plain major carries no text attribute.
 */
function chordKindText(
  quality: number,
  extensions: ReadonlyArray<number> | undefined,
  omissions?: ReadonlyArray<number>,
): string | undefined {
  const suffix = chordSuffix(quality, extensions, omissions);
  return suffix === '' ? undefined : suffix;
}

/** One MusicXML `<degree>` element. */
function chordDegreeElement(value: number, alter: number, type: 'add' | 'subtract'): string {
  return `<degree><degree-value>${value}</degree-value><degree-alter>${alter}</degree-alter><degree-type>${type}</degree-type></degree>`;
}

/**
 * Adds explicit MusicXML degree data for the tones the printed kind does not
 * already imply: `add` for non-intrinsic chord tones, `subtract` for intrinsic
 * ones the chord leaves out.
 */
function chordDegreeXml(symbol: NotatedChordSymbol): string {
  const extensions = new Set(normalizedChordExtensions(symbol.quality, symbol.extensions));
  // add9 and minAdd9 export as a plain major/minor kind, so their ninth is
  // intrinsic to the editor quality but still needs an explicit degree.
  if (symbol.quality === 10 || symbol.quality === 11) extensions.add(2);
  const added = [...extensions]
    .map((extension) => chordDegreeForExtension(extension, symbol.quality))
    .filter((degree): degree is { value: number; alter: number } => degree !== undefined)
    .map(({ value, alter }) => chordDegreeElement(value, alter, 'add'));
  const subtracted = normalizedChordOmissions(symbol.quality, symbol.omissions)
    .map((omission) => chordDegreeForOmission(omission))
    .filter((degree): degree is { value: number; alter: number } => degree !== undefined)
    .map(({ value, alter }) => chordDegreeElement(value, alter, 'subtract'));
  return [...added, ...subtracted].join('');
}

/**
 * Maps an omitted intrinsic pitch class to the chord degree it occupies. The
 * degree names the position, so a minor and a major third both subtract the
 * third; the alteration follows the interval that was there.
 */
function chordDegreeForOmission(omission: number): { value: number; alter: number } | undefined {
  switch (omission) {
    case 2:
      return { value: 2, alter: 0 };
    case 3:
      return { value: 3, alter: -1 };
    case 4:
      return { value: 3, alter: 0 };
    case 5:
      return { value: 4, alter: 0 };
    case 6:
      return { value: 5, alter: -1 };
    case 7:
      return { value: 5, alter: 0 };
    case 8:
      return { value: 5, alter: 1 };
    case 9:
      return { value: 6, alter: 0 };
    case 10:
      return { value: 7, alter: -1 };
    case 11:
      return { value: 7, alter: 0 };
    default:
      return undefined;
  }
}

/** Maps a root-relative extension pitch class to a conventional chord degree. */
function chordDegreeForExtension(
  extension: number,
  quality: number | undefined,
): { value: number; alter: number } | undefined {
  switch (extension) {
    case 1:
      return { value: 9, alter: -1 };
    case 2:
      return { value: 9, alter: 0 };
    case 3:
      return { value: 9, alter: 1 };
    // A third or fifth the quality lacks (a suspended or diminished chord) is
    // added at its own degree rather than as a compound one.
    case 4:
      return { value: 3, alter: 0 };
    case 5:
      return { value: 11, alter: 0 };
    case 6:
      return { value: 11, alter: 1 };
    case 7:
      return { value: 5, alter: 0 };
    case 8:
      return { value: 13, alter: -1 };
    case 9:
      return { value: quality === 0 || quality === 1 ? 6 : 13, alter: 0 };
    case 10:
      return { value: 7, alter: -1 };
    case 11:
      return { value: 7, alter: 0 };
    default:
      return undefined;
  }
}

/**
 * Narrows an optional pitch-class field to a valid 0-11 value (the libsonare
 * 255 "unknown" sentinel and any other out-of-range value fail).
 */
function isPitchClass(pc: number | undefined): pc is number {
  return pc !== undefined && Number.isInteger(pc) && pc >= 0 && pc <= 11;
}

/**
 * Groups chord symbols by the index of the measure containing them; symbols
 * outside the measure grid are dropped.
 */
export function groupChordSymbolsByMeasure(
  symbols: ReadonlyArray<NotatedChordSymbol>,
  measures: ReadonlyArray<NotatedMeasure>,
): Map<number, NotatedChordSymbol[]> {
  const byMeasure = new Map<number, NotatedChordSymbol[]>();
  for (const symbol of symbols) {
    const measure = measures.find(
      (m) =>
        symbol.ppq >= m.startPpq - PPQ_EPSILON &&
        symbol.ppq < m.startPpq + m.lengthPpq - PPQ_EPSILON,
    );
    if (measure === undefined) {
      continue;
    }
    const list = byMeasure.get(measure.index);
    if (list === undefined) {
      byMeasure.set(measure.index, [symbol]);
    } else {
      list.push(symbol);
    }
  }
  return byMeasure;
}
