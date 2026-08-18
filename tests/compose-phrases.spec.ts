import { describe, expect, it } from 'vitest';
import { analyzePhrases } from '@/compose/phrases';
import type { TrackWithNotes } from '@/compose/tracks';
import type { EditorChordSymbol } from '@/project/chords';
import type { EditorNote } from '@/project/types';

/**
 * Phrase structure is a reading, not a fact, so these pin the shape of the
 * answer, the exclusions and the positioning rather than the library's
 * judgement about where a particular piece breathes.
 */

let nextId = 1;

function note(pitch: number, startPpq: number, durationPpq = 1): EditorNote {
  return { id: nextId++, pitch, startPpq, durationPpq, velocity: 100, channel: 0 };
}

function track(name: string, notes: EditorNote[], extra: Record<string, unknown> = {}) {
  return {
    track: { id: 1, name, color: '#fff', kind: 'midi', mute: false, solo: false, ...extra },
    notes,
  } as unknown as TrackWithNotes;
}

/**
 * Four four-bar units of a I-IV-V-I turn, each closing with a held tonic, so
 * the melody breathes where the harmony arrives.
 */
function periodicMelody(): EditorNote[] {
  const notes: EditorNote[] = [];
  for (let unit = 0; unit < 4; unit += 1) {
    const at = unit * 16;
    notes.push(note(60, at), note(64, at + 1), note(67, at + 2), note(72, at + 3));
    notes.push(note(65, at + 4), note(69, at + 5), note(72, at + 6), note(69, at + 7));
    notes.push(note(67, at + 8), note(71, at + 9), note(74, at + 10), note(71, at + 11));
    notes.push(note(60, at + 12, 4));
  }
  return notes;
}

/** A I-IV-V-I progression per four-bar unit, four units long. */
function turnaround(): EditorChordSymbol[] {
  const chords: EditorChordSymbol[] = [];
  for (let unit = 0; unit < 4; unit += 1) {
    const at = unit * 16;
    chords.push({ startPpq: at, endPpq: at + 4, rootPc: 0, quality: 0 });
    chords.push({ startPpq: at + 4, endPpq: at + 8, rootPc: 5, quality: 0 });
    chords.push({ startPpq: at + 8, endPpq: at + 12, rootPc: 7, quality: 4 });
    chords.push({ startPpq: at + 12, endPpq: at + 16, rootPc: 0, quality: 0 });
  }
  return chords;
}

const METER = [{ startPpq: 0, numerator: 4, denominator: 4 }];

describe('analyzePhrases', () => {
  it('reads nothing from an arrangement with no notes', () => {
    expect(analyzePhrases([track('Piano', [])])).toEqual({
      phrases: [],
      cadences: [],
      hypermeter: null,
      excludedTrackNames: [],
    });
  });

  it('returns contiguous phrases in absolute PPQ covering the piece', () => {
    const { phrases } = analyzePhrases([track('Piano', periodicMelody())], turnaround(), METER);

    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]?.startPpq).toBe(0);
    for (const [index, phrase] of phrases.entries()) {
      expect(phrase.endPpq).toBeGreaterThan(phrase.startPpq);
      expect(phrase.confidence).toBeGreaterThanOrEqual(0);
      expect(phrase.confidence).toBeLessThanOrEqual(1);
      expect(phrase.structuralWeight).toBeGreaterThanOrEqual(0);
      expect(phrase.structuralWeight).toBeLessThanOrEqual(1);
      const previous = phrases[index - 1];
      if (previous !== undefined) expect(phrase.startPpq).toBe(previous.endPpq);
    }
  });

  it('names every boundary with the evidence that placed it', () => {
    const { phrases } = analyzePhrases([track('Piano', periodicMelody())], turnaround(), METER);
    const known = ['cadence', 'rest', 'longNote', 'repetition', 'hypermeter', 'pieceEnd'];

    for (const phrase of phrases) {
      expect(phrase.signals.length).toBeGreaterThan(0);
      for (const signal of phrase.signals) expect(known).toContain(signal);
    }
    // The last phrase is closed by the music running out.
    expect(phrases[phrases.length - 1]?.signals).toContain('pieceEnd');
  });

  it('ranks the cadences that close phrases, heaviest first', () => {
    const { phrases, cadences } = analyzePhrases(
      [track('Piano', periodicMelody())],
      turnaround(),
      METER,
    );

    expect(cadences.length).toBeGreaterThan(0);
    for (const [index, cadence] of cadences.entries()) {
      expect(phrases[cadence.phraseIndex]).toBeDefined();
      expect(cadence.endPpq).toBe(phrases[cadence.phraseIndex]?.endPpq);
      expect(cadence.rationale.length).toBeGreaterThan(0);
      const previous = cadences[index - 1];
      if (previous !== undefined) expect(cadence.weight).toBeLessThanOrEqual(previous.weight);
    }
    // Only the four types the editor names reach the report.
    for (const cadence of cadences) {
      expect(['authentic', 'plagal', 'half', 'deceptive']).toContain(cadence.type);
    }
  });

  it('reports how the bars group above the bar line', () => {
    const { hypermeter } = analyzePhrases([track('Piano', periodicMelody())], turnaround(), METER);

    expect(hypermeter).not.toBeNull();
    expect(hypermeter?.groupBars).toBeGreaterThan(0);
    expect(hypermeter?.confidence).toBeGreaterThanOrEqual(0);
    expect(hypermeter?.confidence).toBeLessThanOrEqual(1);
    expect(hypermeter?.rationale.length).toBeGreaterThan(0);
    for (const [index, downbeat] of (hypermeter?.downbeatPpqs ?? []).entries()) {
      expect(downbeat).toBeGreaterThanOrEqual(0);
      const previous = hypermeter?.downbeatPpqs[index - 1];
      if (previous !== undefined) expect(downbeat).toBeGreaterThan(previous);
    }
  });

  // Drum hits carry neither the melody's breathing nor the harmony's arrivals.
  it('excludes percussion tracks and reports them by name', () => {
    const drums = track('Drums', [note(36, 0), note(38, 1)], { percussion: true });
    const report = analyzePhrases([track('Piano', periodicMelody()), drums], turnaround(), METER);

    expect(report.excludedTrackNames).toEqual(['Drums']);
    expect(report.phrases.length).toBeGreaterThan(0);
  });

  it('reads nothing when every track is percussion', () => {
    const drums = track('Drums', [note(36, 0), note(38, 1)], { percussion: true });
    expect(analyzePhrases([drums])).toEqual({
      phrases: [],
      cadences: [],
      hypermeter: null,
      excludedTrackNames: ['Drums'],
    });
  });

  // Without a chord track the harmony has to be inferred, which is a different
  // reading of the same piece rather than a failure.
  it('reads phrases with no chord track by inferring the harmony', () => {
    const { phrases } = analyzePhrases([track('Piano', periodicMelody())], [], METER);

    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases[0]?.startPpq).toBe(0);
  });
});
