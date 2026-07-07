import { chordPitchClasses, MAJOR_MASK } from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import {
  buildChordTimeline,
  chordSymbolAtPpq,
  inferChordTimelineFromNotes,
} from '@/compose/chord-at-tick';
import {
  audioQualityToLibcantus,
  chordSpanToEditorChord,
  editorChordToChord,
  editorChordToChordSpan,
} from '@/compose/chord-io';
import {
  assertMaskConventionParity,
  DEFAULT_KEY_SCALE,
  effectiveKeyScale,
  keyScaleToScaleHighlight,
  scaleHighlightToKeyScale,
  tonicPcFromKeyFifths,
} from '@/compose/key';
import { segmentAtPpq, timeSignatureAtPpq } from '@/compose/meter';
import {
  editorNotesToNoteEvents,
  editorNoteToNoteEvent,
  noteEventsToNewEditorNotes,
  noteEventToNewEditorNote,
} from '@/compose/notes-io';
import { harmonicTracksOnly, isDrumTrack, topVoiceOnly } from '@/compose/tracks';
import type { EditorChordSymbol } from '@/project/chords';
import type { EditorNote, EditorTrack, ScaleHighlightConfig } from '@/project/types';
import { MAJOR_MODE_MASK } from '@/project/types';

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

describe('key adapter', () => {
  it('agrees with libcantus on the major mask', () => {
    expect(MAJOR_MODE_MASK).toBe(2741);
    expect(MAJOR_MASK).toBe(MAJOR_MODE_MASK);
    expect(assertMaskConventionParity()).toBe(true);
  });

  it('round-trips a scale-highlight config through KeyScale', () => {
    const config: ScaleHighlightConfig = { enabled: true, rootPc: 7, modeMask: MAJOR_MODE_MASK };
    const key = scaleHighlightToKeyScale(config);
    expect(key).toEqual({ rootPc: 7, modeMask12: MAJOR_MODE_MASK });
    expect(keyScaleToScaleHighlight(key)).toEqual(config);
  });

  it('falls back to C major when highlighting is disabled', () => {
    const config: ScaleHighlightConfig = { enabled: false, rootPc: 5, modeMask: 123 };
    expect(effectiveKeyScale(config)).toEqual(DEFAULT_KEY_SCALE);
  });

  it('derives major tonics from key-signature fifths', () => {
    expect(tonicPcFromKeyFifths(0)).toBe(0); // C
    expect(tonicPcFromKeyFifths(1)).toBe(7); // G
    expect(tonicPcFromKeyFifths(-1)).toBe(5); // F
    expect(tonicPcFromKeyFifths(2)).toBe(2); // D
  });
});

describe('chord-io adapter', () => {
  const exactOrdinals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 15];

  it('round-trips every exact quality ordinal edit -> libcantus -> edit', () => {
    for (const quality of exactOrdinals) {
      const symbol = chordSymbol({ rootPc: 2, quality });
      const span = editorChordToChordSpan(symbol, 0);
      const back = chordSpanToEditorChord(span, 0, 4);
      expect(back.quality).toBe(quality);
      expect(back.rootPc).toBe(2);
      expect(back.extensions).toBeUndefined();
    }
  });

  it('degrades qualities the editor cannot name to base + extensions', () => {
    // libcantus min9 has no exact editor ordinal: min7 (6) + a 9th (2 semitones).
    const editor = chordSpanToEditorChord({ rootPc: 0, quality: 'min9', startBeat: 0 }, 0, 4);
    expect(editor.quality).toBe(6);
    expect(editor.extensions).toEqual([2]);
  });

  it('maps the m(add9) ordinal to a plain minor libcantus quality', () => {
    expect(audioQualityToLibcantus(11)).toBe('min');
  });

  it('builds a libcantus chord with the expected pitch classes', () => {
    const chord = editorChordToChord(chordSymbol({ rootPc: 0, quality: 5 })); // Cmaj7
    expect(chordPitchClasses(chord)).toEqual([0, 4, 7, 11]);
  });

  it('preserves a slash bass when it differs from the root', () => {
    const span = editorChordToChordSpan(chordSymbol({ rootPc: 0, quality: 0, bassPc: 7 }), 0);
    expect(span.bassPc).toBe(7);
    const back = chordSpanToEditorChord(span, 0, 4);
    expect(back.bassPc).toBe(7);
  });
});

describe('notes-io adapter', () => {
  it('treats PPQ as beats with coefficient 1 (never divides by a tick resolution)', () => {
    const event = editorNoteToNoteEvent(note({ startPpq: 480, durationPpq: 2 }));
    expect(event.startBeat).toBe(480);
    expect(event.durationBeat).toBe(2);
  });

  it('applies a clip beat offset for absolute positioning', () => {
    const event = editorNoteToNoteEvent(note({ startPpq: 4 }), 16);
    expect(event.startBeat).toBe(20);
  });

  it('sorts converted events by onset then pitch', () => {
    const events = editorNotesToNoteEvents([
      note({ id: 1, pitch: 67, startPpq: 4 }),
      note({ id: 2, pitch: 60, startPpq: 0 }),
      note({ id: 3, pitch: 64, startPpq: 0 }),
    ]);
    expect(events.map((e) => e.pitch)).toEqual([60, 64, 67]);
  });

  it('clamps pitch and drops non-positive durations on the reverse path', () => {
    expect(noteEventToNewEditorNote({ pitch: 200, startBeat: 0, durationBeat: 1 })?.pitch).toBe(
      127,
    );
    expect(noteEventToNewEditorNote({ pitch: 60, startBeat: 0, durationBeat: 0 })).toBeNull();
    expect(noteEventToNewEditorNote({ pitch: 60, startBeat: -1, durationBeat: 1 })).toBeNull();
  });

  it('subtracts the beat offset and defaults velocity when writing back', () => {
    const notes = noteEventsToNewEditorNotes([{ pitch: 60, startBeat: 20, durationBeat: 1 }], {
      channel: 2,
      beatOffset: 16,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pitch: 60, startPpq: 4, velocity: 96, channel: 2 });
  });
});

describe('meter adapter', () => {
  const segments = [
    { startPpq: 0, numerator: 4, denominator: 4 },
    { startPpq: 16, numerator: 3, denominator: 4 },
  ];

  it('selects the governing segment at a position', () => {
    expect(segmentAtPpq(segments, 0).numerator).toBe(4);
    expect(segmentAtPpq(segments, 15).numerator).toBe(4);
    expect(segmentAtPpq(segments, 16).numerator).toBe(3);
    expect(segmentAtPpq(segments, 100).numerator).toBe(3);
  });

  it('falls back to 4/4 for an empty map', () => {
    expect(timeSignatureAtPpq([], 0)).toEqual({ numerator: 4, denominator: 4 });
  });
});

describe('chord-at-tick adapter', () => {
  const symbols = [
    chordSymbol({ startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 }),
    chordSymbol({ startPpq: 4, endPpq: 8, rootPc: 7, quality: 4 }),
  ];

  it('builds a queryable timeline honouring PPQ = beat', () => {
    const timeline = buildChordTimeline(symbols);
    expect(timeline.at(0)?.rootPc).toBe(0);
    expect(timeline.at(5)?.rootPc).toBe(7);
    expect(timeline.at(20)).toBeNull();
  });

  it('finds the editor symbol covering a position (half-open regions)', () => {
    expect(chordSymbolAtPpq(symbols, 0)?.rootPc).toBe(0);
    expect(chordSymbolAtPpq(symbols, 4)?.rootPc).toBe(7);
    expect(chordSymbolAtPpq(symbols, 8)).toBeNull();
  });

  it('infers a timeline from note content as a fallback', () => {
    const events = editorNotesToNoteEvents([
      note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 4 }),
      note({ id: 2, pitch: 64, startPpq: 0, durationPpq: 4 }),
      note({ id: 3, pitch: 67, startPpq: 0, durationPpq: 4 }),
    ]);
    const result = inferChordTimelineFromNotes(events);
    expect(result.timeline.at(0)?.rootPc).toBe(0); // C major
  });
});

describe('track hygiene', () => {
  it('classifies drum tracks by name', () => {
    expect(isDrumTrack(track({ name: 'Drums' }))).toBe(true);
    expect(isDrumTrack(track({ name: 'Percussion' }))).toBe(true);
    expect(isDrumTrack(track({ name: 'Lead Synth' }))).toBe(false);
  });

  it('classifies drum tracks by channel-10 majority', () => {
    const drumNotes = [note({ channel: 9 }), note({ channel: 9 }), note({ channel: 0 })];
    expect(isDrumTrack(track({ name: 'Kick' }), drumNotes)).toBe(true);
    const pitched = [note({ channel: 0 }), note({ channel: 0 }), note({ channel: 9 })];
    expect(isDrumTrack(track({ name: 'Bass' }), pitched)).toBe(false);
  });

  it('splits harmonic from percussion tracks', () => {
    const items = [
      { track: track({ id: 1, name: 'Piano' }), notes: [note({})] },
      { track: track({ id: 2, name: 'Drums' }), notes: [note({ channel: 9 })] },
    ];
    const { harmonic, excluded } = harmonicTracksOnly(items);
    expect(harmonic.map((h) => h.track.id)).toEqual([1]);
    expect(excluded.map((e) => e.track.id)).toEqual([2]);
  });

  it('reduces polyphony to the top voice per onset', () => {
    const reduced = topVoiceOnly([
      { pitch: 60, startBeat: 0, durationBeat: 1 },
      { pitch: 64, startBeat: 0, durationBeat: 1 },
      { pitch: 67, startBeat: 0, durationBeat: 1 },
      { pitch: 62, startBeat: 1, durationBeat: 1 },
    ]);
    expect(reduced.map((n) => ({ pitch: n.pitch, startBeat: n.startBeat }))).toEqual([
      { pitch: 67, startBeat: 0 },
      { pitch: 62, startBeat: 1 },
    ]);
  });
});
