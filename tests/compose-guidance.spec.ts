import { NoteSafety } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import { buildTheoryCard } from '@/compose/explain';
import { buildGuidance, type GuidanceInput, resolutionTargetOf } from '@/compose/guidance';
import type { EditorChordSymbol } from '@/project/chords';
import type { EditorNote, EditorTrack, TimeSignatureSegment } from '@/project/types';
import { MAJOR_MODE_MASK, type ScaleHighlightConfig } from '@/project/types';
import { MESSAGES } from '@/ui/i18n';

function note(partial: Partial<EditorNote>): EditorNote {
  return {
    id: 1,
    pitch: 60,
    velocity: 96,
    startPpq: 0,
    durationPpq: 1,
    channel: 0,
    ...partial,
  };
}

function track(partial: Partial<EditorTrack>): EditorTrack {
  return {
    id: 1,
    name: 'Track',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...partial,
  } as EditorTrack;
}

function chordSymbol(partial: Partial<EditorChordSymbol>): EditorChordSymbol {
  return { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0, ...partial };
}

const C_MAJOR_KEY: ScaleHighlightConfig = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
const FOUR_FOUR: TimeSignatureSegment[] = [{ startPpq: 0, numerator: 4, denominator: 4 }];

function guidanceInput(partial: Partial<GuidanceInput>): GuidanceInput {
  return {
    notes: [],
    clipStartPpq: 0,
    chordSymbols: [],
    key: C_MAJOR_KEY,
    timeSignatures: FOUR_FOUR,
    ...partial,
  };
}

describe('buildGuidance', () => {
  it('labels E over a C major chord as the quality-locked third, safe', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 10, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    expect(result.keySet).toBe(true);
    expect(result.chordPresent).toBe(true);
    const analysis = result.byNoteId.get(10);
    expect(analysis).toBeDefined();
    expect(analysis?.role?.role).toBe('third');
    expect(analysis?.role?.lock).toBe('quality');
    expect(analysis?.safety?.safety).toBe(NoteSafety.Safe);
    expect(analysis?.isScaleTone).toBe(true);
    expect(analysis?.degree).toBe(2);
  });

  it('flags a note a semitone above a chord tone as not safe', () => {
    // F over C major sits a semitone above the third E: an avoid note.
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 20, pitch: 65, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(20);
    expect(analysis?.safety).toBeDefined();
    expect(analysis?.safety?.safety).not.toBe(NoteSafety.Safe);
  });

  it('never lets a percussion track downgrade a consonant melody note', () => {
    // The drum hits sit a semitone off the melody note; if they leaked into
    // otherVoices they would register as vertical dissonance.
    const drums = {
      track: track({ id: 2, name: 'Drums' }),
      notes: [
        note({ id: 100, pitch: 63, startPpq: 0, durationPpq: 4, channel: 9 }),
        note({ id: 101, pitch: 65, startPpq: 0, durationPpq: 4, channel: 9 }),
      ],
    };
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 30, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
        otherTracks: [drums],
      }),
    );
    const analysis = result.byNoteId.get(30);
    expect(analysis?.safety?.safety).toBe(NoteSafety.Safe);
  });

  it('emits a key-only segment when no progression exists', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 40, pitch: 62, startPpq: 0, durationPpq: 2 })],
      }),
    );
    expect(result.chordPresent).toBe(false);
    expect(result.segments.length).toBeGreaterThanOrEqual(1);
    const segment = result.segments[0];
    expect(segment.startBeat).toBe(0);
    expect(segment.endBeat).toBeGreaterThan(0);
    expect(segment.safetyByPc).toHaveLength(12);
    const analysis = result.byNoteId.get(40);
    expect(analysis?.degree).toBe(1); // D is the second degree of C major
    expect(analysis?.isScaleTone).toBe(true);
  });

  it('converts chord-segment spans to clip-relative beats', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 50, pitch: 60, startPpq: 0, durationPpq: 4 })],
        clipStartPpq: 8,
        chordSymbols: [chordSymbol({ startPpq: 8, endPpq: 12, rootPc: 0, quality: 0 })],
      }),
    );
    expect(result.chordPresent).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].startBeat).toBe(0);
    expect(result.segments[0].endBeat).toBe(4);
  });
});

describe('resolutionTargetOf', () => {
  it('returns the resolution pitch for a leading tone stepping up to the tonic', () => {
    // B (71) resolving up to C (72) over a G7 -> C: the analyzer marks B as a
    // leading tone whose resolveTo target is the following tonic.
    const result = buildGuidance(
      guidanceInput({
        notes: [
          note({ id: 70, pitch: 71, startPpq: 0, durationPpq: 1 }),
          note({ id: 71, pitch: 72, startPpq: 1, durationPpq: 1 }),
        ],
        chordSymbols: [
          chordSymbol({ startPpq: 0, endPpq: 1, rootPc: 7, quality: 4 }),
          chordSymbol({ startPpq: 1, endPpq: 4, rootPc: 0, quality: 0 }),
        ],
      }),
    );
    const analysis = result.byNoteId.get(70);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    expect(resolutionTargetOf(analysis)).toBe(72);
  });

  it('returns undefined for a plain chord tone with no resolution obligation', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 72, pitch: 60, startPpq: 0, durationPpq: 4 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(72);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    expect(resolutionTargetOf(analysis)).toBeUndefined();
  });
});

describe('buildTheoryCard', () => {
  it('builds a titled card with a scale-degree line', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 60, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(60);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 64, keySet: true, chordRoman: 'I', chordFunction: 'tonic' },
      MESSAGES.en.theory,
    );
    expect(card.title).toBe('E4 — 3rd');
    const scaleLine = card.lines.find((line) => line.label === 'Scale');
    expect(scaleLine?.text).toBe('Scale degree 3');
    const chordLine = card.lines.find((line) => line.label === 'Chord');
    expect(chordLine?.text).toBe('I — Tonic');
    expect(card.lines.length).toBeGreaterThan(0);
  });

  it('adds a color-tone line with the chord scale available tensions', () => {
    const result = buildGuidance(
      guidanceInput({
        // A note over a Cmaj7 chord: ionian offers D and A as color tones.
        notes: [note({ id: 61, pitch: 60, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 5 })],
      }),
    );
    const analysis = result.byNoteId.get(61);
    expect(analysis?.chordScale).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(analysis, { pitch: 60, keySet: true }, MESSAGES.en.theory);
    const colorLine = card.lines.find((line) => line.label === 'Color');
    expect(colorLine).toBeDefined();
    expect(colorLine?.text).toContain('tensions');
    expect(colorLine?.text).toContain('D');
    expect(colorLine?.text).toContain('A');
  });

  it('localizes the card from the Japanese message bundle', () => {
    const result = buildGuidance(
      guidanceInput({
        notes: [note({ id: 60, pitch: 64, startPpq: 0, durationPpq: 1 })],
        chordSymbols: [chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 })],
      }),
    );
    const analysis = result.byNoteId.get(60);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const card = buildTheoryCard(
      analysis,
      { pitch: 64, keySet: true, chordRoman: 'I', chordFunction: 'tonic' },
      MESSAGES.ja.theory,
    );
    expect(card.title).toBe('E4 — 第3音');
    const scaleLine = card.lines.find((line) => line.label === 'スケール');
    expect(scaleLine?.text).toBe('スケール度数 3');
    const chordLine = card.lines.find((line) => line.label === 'コード');
    expect(chordLine?.text).toBe('I — トニック');
  });
});
