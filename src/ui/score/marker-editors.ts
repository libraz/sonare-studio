import type { NotatedLyricSyllabic } from '@/notation/model';

export type ScoreKeyMode = 'major' | 'minor';

export const SCORE_LYRIC_SYLLABICS: readonly NotatedLyricSyllabic[] = [
  'single',
  'begin',
  'middle',
  'end',
];

export interface ScoreLyricMarkerOptions {
  /** MusicXML lyric verse number, 1-based. Defaults to 1 / omitted marker prefix. */
  verse?: number;
  /** MusicXML syllabic value. Defaults to single / omitted marker prefix. */
  syllabic?: NotatedLyricSyllabic;
  /** True to emit a MusicXML lyric extend mark for melisma. */
  extend?: boolean;
}

export const SCORE_KEY_ROOTS = [
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F#',
  'Db',
  'Ab',
  'Eb',
  'Bb',
  'F',
] as const;

export type ScoreKeyRoot = (typeof SCORE_KEY_ROOTS)[number];

export const SCORE_KEY_MODES: readonly ScoreKeyMode[] = ['major', 'minor'];

const PPQ_EPSILON = 1e-6;

export function scoreEditPpq(
  positionPpq: number | undefined,
  clipStartPpq: number,
  clipLengthPpq: number,
): number {
  const clipEndPpq = clipStartPpq + Math.max(0, clipLengthPpq);
  if (!Number.isFinite(positionPpq)) return clipStartPpq;
  const position = positionPpq as number;
  if (position < clipStartPpq || position >= clipEndPpq) return clipStartPpq;
  return Math.max(clipStartPpq, Math.min(clipEndPpq - PPQ_EPSILON, position));
}

export function scoreMeasureStartPpq(
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
): number {
  if (!Number.isFinite(ppq) || !Number.isFinite(measureLenPpq) || measureLenPpq <= 0) {
    return clipStartPpq;
  }
  const measureIndex = Math.max(0, Math.floor((ppq - clipStartPpq + PPQ_EPSILON) / measureLenPpq));
  return clipStartPpq + measureIndex * measureLenPpq;
}

export function scoreLyricMarkerName(text: string, options: ScoreLyricMarkerOptions = {}): string {
  const lyric = text.trim();
  if (lyric.length === 0) throw new RangeError('Lyric text is required');
  const verse = options.verse ?? 1;
  if (!Number.isInteger(verse) || verse < 1) {
    throw new RangeError(`Unsupported lyric verse: ${verse}`);
  }
  const syllabic = options.syllabic ?? 'single';
  if (!SCORE_LYRIC_SYLLABICS.includes(syllabic)) {
    throw new RangeError(`Unsupported lyric syllabic value: ${syllabic}`);
  }
  const prefix = verse === 1 ? 'Lyric' : `Lyric ${verse}`;
  const syllable = syllabic === 'single' ? lyric : `${syllabic}: ${lyric}`;
  return `${prefix}: ${options.extend === true ? `${syllable}~` : syllable}`;
}

export function scoreKeyMarkerName(root: ScoreKeyRoot, mode: ScoreKeyMode): string {
  if (!SCORE_KEY_ROOTS.includes(root)) throw new RangeError(`Unsupported key root: ${root}`);
  if (!SCORE_KEY_MODES.includes(mode)) throw new RangeError(`Unsupported key mode: ${mode}`);
  return `Key: ${root} ${mode}`;
}
