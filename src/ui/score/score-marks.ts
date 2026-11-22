import { keySignatureFromMarker } from '@/compose/key-name';
import { pitchClassOf } from '@/lib/pitch';
import {
  measureHasMultiRestStructure,
  type NotatedChordSymbol,
  type NotatedLyric,
  type NotatedLyricSyllabic,
  type NotatedMeasure,
  type NotatedScore,
  type NotatedTempoMark,
  type NotatedTempoText,
} from '@/notation/model';
import { chordPitchClassName } from '@/notation/pitch-spelling';
import { normalizeTempoMap, tempoAtPpq } from '@/project/tempo-map';
import type { EditorMarker, EditorSection, TempoSegment } from '@/project/types';
import type { ScoreLayoutSettings } from '@/ui/score/layout';

/** Tolerance for matching section starts to engraved measure boundaries. */
const PPQ_EPSILON = 1e-6;

/** Adds section labels and double bars for section starts aligned to score measures. */
export function applySectionMarks(
  score: NotatedScore,
  sections: ReadonlyArray<EditorSection>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (sections.length === 0 || measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const rehearsals: Record<number, string> = {};
  const barlines: Record<number, 'double'> = {};
  for (const section of sections) {
    if (
      section.startPpq < clipStartPpq - PPQ_EPSILON ||
      section.startPpq >= clipEndPpq - PPQ_EPSILON
    ) {
      continue;
    }
    const measureIndex = measureIndexForPpq(score, section.startPpq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    const name = section.name.trim();
    if (name) rehearsals[measureIndex] = name;
    if (measureIndex > 0) barlines[measureIndex - 1] = 'double';
  }
  if (Object.keys(rehearsals).length > 0) score.measureRehearsals = rehearsals;
  if (Object.keys(barlines).length > 0) score.measureBarlines = barlines;
}

/** Adds exact metronome marks and textual ramp directions across the score grid. */
export function applyTempoMarks(
  score: NotatedScore,
  tempoSegments: ReadonlyArray<TempoSegment>,
  fallbackBpm: number,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const tempoMap = normalizeTempoMap(tempoSegments, fallbackBpm);
  const tempoMarks: Record<number, NotatedTempoMark[]> = {};
  const tempoTexts: Record<number, NotatedTempoText[]> = {};
  const addTempo = (ppq: number, bpm: number): void => {
    const position = measurePositionForPpq(score, ppq, clipStartPpq, measureLenPpq);
    if (position === undefined) return;
    const marks = tempoMarks[position.measureIndex] ?? [];
    const existing = marks.findIndex(
      (mark) => Math.abs(mark.offsetPpq - position.offsetPpq) <= PPQ_EPSILON,
    );
    const mark = { bpm, offsetPpq: position.offsetPpq };
    if (existing >= 0) marks[existing] = mark;
    else marks.push(mark);
    marks.sort((a, b) => a.offsetPpq - b.offsetPpq);
    tempoMarks[position.measureIndex] = marks;
  };
  const addText = (ppq: number, text: string, bpm?: number): void => {
    const position = measurePositionForPpq(score, ppq, clipStartPpq, measureLenPpq);
    if (position === undefined) return;
    const marks = tempoTexts[position.measureIndex] ?? [];
    marks.push({ text, ...(bpm !== undefined ? { bpm } : {}), offsetPpq: position.offsetPpq });
    marks.sort((a, b) => (a.offsetPpq ?? 0) - (b.offsetPpq ?? 0));
    tempoTexts[position.measureIndex] = marks;
  };
  addTempo(clipStartPpq, tempoAtPpq(tempoMap, clipStartPpq));
  for (const segment of tempoSegments) {
    if (
      segment.startPpq <= clipStartPpq + PPQ_EPSILON ||
      segment.startPpq >= clipEndPpq - PPQ_EPSILON
    ) {
      continue;
    }
    addTempo(segment.startPpq, tempoAtPpq(tempoMap, segment.startPpq));
  }
  const sortedSegments = [...tempoSegments]
    .filter((segment) => Number.isFinite(segment.startPpq))
    .sort((a, b) => a.startPpq - b.startPpq);
  for (let i = 0; i < sortedSegments.length - 1; i += 1) {
    const segment = sortedSegments[i];
    const next = sortedSegments[i + 1];
    if (
      segment.endBpm === undefined ||
      !Number.isFinite(segment.endBpm) ||
      segment.endBpm <= 0 ||
      Math.abs(segment.endBpm - segment.bpm) < PPQ_EPSILON
    ) {
      continue;
    }
    addText(
      segment.startPpq,
      segment.endBpm < segment.bpm ? 'rit.' : 'accel.',
      tempoAtPpq(tempoMap, segment.startPpq),
    );
    addText(next.startPpq, 'a tempo', tempoAtPpq(tempoMap, next.startPpq));
    addTempo(next.startPpq, tempoAtPpq(tempoMap, next.startPpq));
  }
  score.measureTempoMarks = tempoMarks;
  if (Object.keys(tempoTexts).length > 0) score.measureTempoTexts = tempoTexts;
}

/** Adds conservative system/page breaks for printable performance scores. */
export function applyLayoutBreaks(
  score: NotatedScore,
  sections: ReadonlyArray<EditorSection>,
  _clipStartPpq: number,
  measureLenPpq: number,
  settings: Pick<ScoreLayoutSettings, 'barsPerSystem' | 'barsPerPage'> = {
    barsPerSystem: 4,
    barsPerPage: 16,
  },
): void {
  if (measureLenPpq <= 0 || score.parts.length === 0) return;
  const measureCount = score.parts[0].measures.length;
  const breaks: Record<number, 'system' | 'page'> = {};
  const barsPerSystem = Math.max(0, Math.round(settings.barsPerSystem));
  const barsPerPage = Math.max(0, Math.round(settings.barsPerPage));
  if (barsPerSystem > 0) {
    for (let index = barsPerSystem; index < measureCount; index += barsPerSystem) {
      breaks[index] = 'system';
    }
  }
  if (barsPerPage > 0) {
    for (let index = barsPerPage; index < measureCount; index += barsPerPage) {
      breaks[index] = 'page';
    }
  }
  for (const section of sections) {
    const measureIndex = measureIndexForPpq(score, section.startPpq, _clipStartPpq, measureLenPpq);
    if (measureIndex !== undefined && measureIndex > 0 && breaks[measureIndex] !== 'page') {
      breaks[measureIndex] = 'system';
    }
  }
  if (Object.keys(breaks).length > 0) score.measureBreaks = breaks;
}

/** Adds measure-aligned timeline markers as general score text directions. */
export function applyMarkerTexts(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
): void {
  if (markers.length === 0 || measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const texts: Record<number, Array<{ text: string; defaultY?: number }>> = {};
  for (const marker of markers) {
    if (marker.ppq < clipStartPpq - PPQ_EPSILON || marker.ppq >= clipEndPpq - PPQ_EPSILON) continue;
    if (keySignaturePayload(marker.name) !== null) continue;
    if (lyricPayload(marker.name) !== null) continue;
    const measureIndex = measureIndexForPpq(score, marker.ppq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    const text = marker.name.trim();
    if (!text) continue;
    const list = texts[measureIndex] ?? [];
    list.push({ text, defaultY: 24 - list.length * 8 });
    texts[measureIndex] = list;
  }
  if (Object.keys(texts).length > 0) score.measureTexts = texts;
}

/** Adds MusicXML lyrics from "Lyric: ..." timeline markers. */
export function applyLyricMarks(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
): void {
  if (markers.length === 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const attacks = score.parts
    .flatMap((part, partIndex) =>
      part.measures.flatMap((measure) =>
        measure.voices.flatMap((voice) =>
          voice.events.flatMap((event) =>
            event.kind === 'note' && !event.tieStop
              ? [{ ppq: event.startPpq, partId: part.id, partIndex }]
              : [],
          ),
        ),
      ),
    )
    .sort((a, b) => a.ppq - b.ppq || a.partIndex - b.partIndex);
  if (attacks.length === 0) return;
  const lyrics = markers
    .filter((marker) => marker.ppq >= clipStartPpq - PPQ_EPSILON && marker.ppq < clipEndPpq)
    .flatMap((marker) => {
      const lyric = lyricPayload(marker.name);
      if (lyric === null) return [];
      const attack = attacks.reduce((nearest, candidate) =>
        Math.abs(candidate.ppq - marker.ppq) < Math.abs(nearest.ppq - marker.ppq)
          ? candidate
          : nearest,
      );
      return [{ ppq: attack.ppq, markerId: marker.id, ...lyric }];
    })
    .sort((a, b) => a.ppq - b.ppq || a.markerId - b.markerId)
    .map(({ markerId: _markerId, ...lyric }) => lyric);
  if (lyrics.length > 0) score.lyrics = lyrics;
}

/** Transposes a MusicXML fifths value while keeping an enharmonic conventional spelling. */
export function transposeKeyFifths(fifths: number, semitones: number): number {
  const shifted = fifths + semitones * 7;
  const modulo = pitchClassOf(shifted);
  return modulo > 6 ? modulo - 12 : modulo;
}

/**
 * Moves root and slash-bass pitch classes alongside display-transposed notes.
 * The display key controls the enharmonic spelling of the rebuilt text.
 */
export function transposeChordSymbols(
  symbols: ReadonlyArray<NotatedChordSymbol>,
  semitones: number,
  displayKeyFifths = 0,
): NotatedChordSymbol[] {
  const shift = pitchClassOf(semitones);
  if (shift === 0) return [...symbols];
  const isPitchClass = (pitchClass: number | undefined): pitchClass is number =>
    pitchClass !== undefined && Number.isInteger(pitchClass) && pitchClass >= 0 && pitchClass <= 11;
  const transposePitchClass = (pitchClass: number | undefined): number | undefined =>
    isPitchClass(pitchClass) ? (pitchClass + shift) % 12 : pitchClass;
  const transposeText = (
    symbol: NotatedChordSymbol,
    rootPc: number | undefined,
    bassPc: number | undefined,
  ): string => {
    if (!isPitchClass(rootPc)) return symbol.text;
    const rootToken = symbol.text.match(/^([A-Ga-g](?:#|b|♯|♭)?)/)?.[0];
    if (rootToken === undefined) return symbol.text;
    const remainder = symbol.text.slice(rootToken.length);
    const rootName = chordPitchClassName(rootPc, displayKeyFifths);
    if (!isPitchClass(bassPc)) return `${rootName}${remainder}`;
    const bassToken = remainder.match(/\/([A-Ga-g](?:#|b|♯|♭)?)$/)?.[0];
    if (bassToken === undefined) return `${rootName}${remainder}`;
    const suffix = remainder.slice(0, -bassToken.length);
    return `${rootName}${suffix}/${chordPitchClassName(bassPc, displayKeyFifths)}`;
  };
  return symbols.map((symbol) => {
    const rootPc = transposePitchClass(symbol.rootPc);
    const bassPc = transposePitchClass(symbol.bassPc);
    return {
      ...symbol,
      text: transposeText(symbol, rootPc, bassPc),
      rootPc,
      bassPc,
    };
  });
}

/** Adds MusicXML key-signature changes from measure-aligned "Key: ..." markers. */
export function applyKeySignatureMarks(
  score: NotatedScore,
  markers: ReadonlyArray<EditorMarker>,
  clipStartPpq: number,
  clipLengthPpq: number,
  measureLenPpq: number,
  displayTransposeSemitones = 0,
): void {
  if (markers.length === 0 || measureLenPpq <= 0 || score.parts.length === 0) return;
  const clipEndPpq = clipStartPpq + clipLengthPpq;
  const keyMarkers = markers
    .map((marker) => ({ marker, key: keySignaturePayload(marker.name) }))
    .filter(
      (entry): entry is { marker: EditorMarker; key: { fifths: number } } => entry.key !== null,
    )
    .sort((a, b) => a.marker.ppq - b.marker.ppq || a.marker.id - b.marker.id);
  if (keyMarkers.length === 0) return;

  let activeFifths = score.keyFifths;
  for (const { marker, key } of keyMarkers) {
    if (marker.ppq <= clipStartPpq + PPQ_EPSILON) {
      activeFifths = transposeKeyFifths(key.fifths, displayTransposeSemitones);
    }
  }

  const changes: Record<number, number> = {};
  if (activeFifths !== score.keyFifths) changes[0] = activeFifths;
  for (const { marker, key } of keyMarkers) {
    if (marker.ppq <= clipStartPpq + PPQ_EPSILON || marker.ppq >= clipEndPpq - PPQ_EPSILON) {
      continue;
    }
    const measureIndex = measureIndexForPpq(score, marker.ppq, clipStartPpq, measureLenPpq);
    if (measureIndex === undefined) continue;
    const fifths = transposeKeyFifths(key.fifths, displayTransposeSemitones);
    if (fifths === activeFifths) continue;
    activeFifths = fifths;
    changes[measureIndex] = fifths;
  }
  if (Object.keys(changes).length > 0) score.measureKeyFifths = changes;
}

/** Marks consecutive empty measures as multi-measure rests when safe. */
export function applyMultiMeasureRests(score: NotatedScore): void {
  if (score.parts.length !== 1) return;
  const measures = score.parts[0].measures;
  const rests: Record<number, { count: number }> = {};
  let start = -1;
  for (let index = 0; index <= measures.length; index += 1) {
    const empty =
      index < measures.length &&
      isEmptyMeasure(measures[index]) &&
      !measureHasMultiRestStructure(score, measures, index);
    if (empty && start < 0) start = index;
    if ((!empty || index === measures.length) && start >= 0) {
      const count = index - start;
      if (count >= 2) rests[start] = { count };
      start = -1;
    }
  }
  if (Object.keys(rests).length > 0) score.multiMeasureRests = rests;
}

function scoreMeasures(score: NotatedScore): ReadonlyArray<NotatedMeasure> {
  return score.parts[0]?.measures ?? [];
}

function measuresUseClipOrigin(
  measures: ReadonlyArray<NotatedMeasure>,
  clipStartPpq: number,
): boolean {
  const first = measures[0];
  return first !== undefined && Math.abs(first.startPpq - clipStartPpq) <= PPQ_EPSILON;
}

function legacyMeasureIndexForPpq(
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
  measureCount: number,
): number | undefined {
  const rel = ppq - clipStartPpq;
  const index = Math.round(rel / measureLenPpq);
  if (index < 0 || index >= measureCount) return undefined;
  return Math.abs(rel - index * measureLenPpq) <= PPQ_EPSILON ? index : undefined;
}

function measureIndexForPpq(
  score: NotatedScore,
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
): number | undefined {
  const measures = scoreMeasures(score);
  if (!measuresUseClipOrigin(measures, clipStartPpq)) {
    return legacyMeasureIndexForPpq(ppq, clipStartPpq, measureLenPpq, measures.length);
  }
  for (let index = 0; index < measures.length; index += 1) {
    if (Math.abs(ppq - measures[index].startPpq) <= PPQ_EPSILON) return index;
  }
  return undefined;
}

/** Resolves any in-measure PPQ to the model's variable-meter measure grid. */
function measurePositionForPpq(
  score: NotatedScore,
  ppq: number,
  clipStartPpq: number,
  measureLenPpq: number,
): { measureIndex: number; offsetPpq: number } | undefined {
  const measures = scoreMeasures(score);
  if (measuresUseClipOrigin(measures, clipStartPpq)) {
    for (let index = 0; index < measures.length; index += 1) {
      const measure = measures[index];
      const end = measure.startPpq + measure.lengthPpq;
      if (Math.abs(ppq - measure.startPpq) <= PPQ_EPSILON) {
        return { measureIndex: index, offsetPpq: 0 };
      }
      if (ppq > measure.startPpq && ppq < end - PPQ_EPSILON) {
        return { measureIndex: index, offsetPpq: ppq - measure.startPpq };
      }
    }
    return undefined;
  }
  const relative = ppq - clipStartPpq;
  if (relative < -PPQ_EPSILON) return undefined;
  const measureIndex = Math.floor(relative / measureLenPpq + PPQ_EPSILON);
  if (measureIndex < 0 || measureIndex >= measures.length) return undefined;
  return {
    measureIndex,
    offsetPpq: Math.max(0, relative - measureIndex * measureLenPpq),
  };
}

function keySignaturePayload(name: string): { fifths: number } | null {
  const key = keySignatureFromMarker(name);
  return key === null ? null : { fifths: key.fifths };
}

function lyricPayload(name: string): Omit<NotatedLyric, 'ppq' | 'partId'> | null {
  const match = name.trim().match(/^Lyric(?:\s+#?(\d+))?:\s*(.+)$/i);
  if (!match) return null;
  const verse = match[1] === undefined ? undefined : Number(match[1]);
  if (verse !== undefined && (!Number.isInteger(verse) || verse < 1)) return null;
  let text = match[2].trim();
  const syllabicMatch = text.match(/^(single|begin|middle|end):\s*(.+)$/i);
  const syllabic = syllabicMatch?.[1].toLowerCase() as NotatedLyricSyllabic | undefined;
  if (syllabicMatch) text = syllabicMatch[2].trim();
  const extend = text.endsWith('~');
  if (extend) text = text.slice(0, -1).trimEnd();
  return text === ''
    ? null
    : {
        text,
        ...(verse !== undefined ? { verse } : {}),
        ...(syllabic !== undefined ? { syllabic } : {}),
        ...(extend ? { extend } : {}),
      };
}

function isEmptyMeasure(measure: NotatedMeasure): boolean {
  return measure.voices.every(
    (voice) =>
      voice.events.length === 1 &&
      voice.events[0].kind === 'rest' &&
      Math.abs(voice.events[0].startPpq - measure.startPpq) <= PPQ_EPSILON &&
      Math.abs(voice.events[0].durationPpq - measure.lengthPpq) <= PPQ_EPSILON,
  );
}
