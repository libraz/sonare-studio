import {
  type ChordData,
  type ChordQuality,
  type ChordSpan,
  chordFromSpan,
  chordPitchClasses,
  MAJOR_MASK,
} from '@libraz/libcantus';
import { describe, expect, it } from 'vitest';
import {
  buildChordTimeline,
  chordSymbolAtPpq,
  inferChordTimelineFromNotes,
} from '@/compose/chord-at-tick';
import { detectChordRegions } from '@/compose/chord-detection';
import {
  audioQualityToLibcantus,
  chordSpanToEditorChord,
  editorChordToChord,
  editorChordToChordSpan,
} from '@/compose/chord-io';
import { libcantusQualityToEditor, QUALITY_SUFFIX } from '@/compose/chord-quality';
import {
  assertMaskConventionParity,
  DEFAULT_KEY_SCALE,
  effectiveKeyScale,
  keyScaleToScaleHighlight,
  scaleHighlightToKeyScale,
  tonicPcFromKeyFifths,
} from '@/compose/key';
import { strongBeatAt, timeSignatureAtPpq } from '@/compose/meter';
import {
  editorNotesToNoteEvents,
  editorNoteToNoteEvent,
  noteEventsToNewEditorNotes,
  noteEventToNewEditorNote,
} from '@/compose/notes-io';
import { harmonicTracksOnly, isDrumTrack, isMelodyTrack, topVoiceOnly } from '@/compose/tracks';
import {
  CHORD_QUALITY_CHOICES,
  chordTonePitchClasses,
  type EditorChordSymbol,
} from '@/project/chords';
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

/** The pitch classes a libcantus chord sounds, deduplicated and ascending. */
function soundedPitchClasses(chord: ChordData): number[] {
  return [...new Set(chordPitchClasses(chord))].sort((a, b) => a - b);
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
  const exactOrdinals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

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

  it('maps the m(add9) ordinal to the exact libcantus quality', () => {
    expect(audioQualityToLibcantus(11)).toBe('minAdd9');
  });

  it('builds a libcantus chord with the expected pitch classes', () => {
    const chord = editorChordToChord(chordSymbol({ rootPc: 0, quality: 5 })); // Cmaj7
    expect(chordPitchClasses(chord)).toEqual([0, 4, 7, 11]);
  });

  it.each([
    ['m(add9)', chordSymbol({ quality: 11 }), 'minAdd9', [0, 2, 3, 7]],
    ['min9', chordSymbol({ quality: 6, extensions: [14] }), 'min9', [0, 2, 3, 7, 10]],
    ['7b9', chordSymbol({ quality: 4, extensions: [13] }), '7b9', [0, 1, 4, 7, 10]],
    ['13', chordSymbol({ quality: 4, extensions: [14, 21] }), '13', [0, 2, 4, 7, 9, 10]],
  ])('preserves %s in compose conversion', (_label, symbol, quality, pitchClasses) => {
    const chord = editorChordToChord(symbol);
    expect(chord.quality).toBe(quality);
    expect(chordPitchClasses(chord)).toEqual(pitchClasses);
  });

  // libcantus's `13` sounds a ninth. A dominant carrying only the thirteenth is
  // still named C13, but it is not that quality, so the conversion must leave it
  // a dom7 with the thirteenth attached rather than adding a tone nobody asked
  // for.
  it('does not promote a thirteenth without a ninth to the 13 quality', () => {
    const symbol = chordSymbol({ quality: 4, extensions: [9] });
    expect(editorChordToChordSpan(symbol, 0).quality).toBe('dom7');
    expect(chordPitchClasses(editorChordToChord(symbol))).toEqual([0, 4, 7, 9, 10]);
  });

  it.each([
    [chordSymbol({ quality: 6, extensions: [2] }), 'min9'],
    [chordSymbol({ quality: 4, extensions: [1] }), '7b9'],
    [chordSymbol({ quality: 4, extensions: [2, 9] }), '13'],
  ])('promotes known extensions in ChordSpan conversion', (symbol, quality) => {
    expect(editorChordToChordSpan(symbol, 0).quality).toBe(quality);
  });

  it.each([
    ['7sus4'],
    ['7alt'],
    ['13b9'],
    ['maj13'],
    ['maj7#11'],
    ['min11'],
    ['min13'],
    ['min6/9'],
    ['minMaj9'],
    ['minMaj11'],
    ['minMaj13'],
    // These four have no ordinal because they omit an intrinsic tone, which the
    // editor can now say outright rather than approximating.
    ['5'],
    ['11'],
    ['majb5'],
    ['7b5'],
  ] as const)('round-trips the %s quality the editor has no ordinal for', (quality) => {
    const editor = chordSpanToEditorChord({ rootPc: 0, quality, startBeat: 0 }, 0, 4);
    expect(editorChordToChordSpan(editor, 0).quality).toBe(quality);
  });

  // A lowered fifth and a raised eleventh are the same pitch class, so the only
  // thing telling them apart is whether the perfect fifth is still sounding.
  it('tells a lowered fifth from a raised eleventh by the fifth it omits', () => {
    const flatFive = chordSpanToEditorChord({ rootPc: 0, quality: '7b5', startBeat: 0 }, 0, 4);
    expect(flatFive).toMatchObject({ quality: 4, extensions: [6], omissions: [7] });
    expect(editorChordToChordSpan(flatFive, 0).quality).toBe('7b5');

    const sharpEleven = chordSpanToEditorChord({ rootPc: 0, quality: '7#11', startBeat: 0 }, 0, 4);
    expect(sharpEleven).toMatchObject({ quality: 4, extensions: [6] });
    expect(sharpEleven.omissions).toBeUndefined();
    expect(editorChordToChordSpan(sharpEleven, 0).quality).toBe('7#11');
  });

  // A libcantus quality is only the nearest name for a chord the union cannot
  // spell exactly, so a span may carry the tone set outright. Reading it from
  // the quality instead would sound tones the chord does not have.
  it('reads a span from its own tone set rather than from its quality', () => {
    // An augmented sixth: the dominant-seventh shape with no fifth.
    const span: ChordSpan = { rootPc: 8, quality: 'dom7', startBeat: 0, intervals: [0, 4, 10] };
    const editor = chordSpanToEditorChord(span, 0, 4);
    expect(editor).toMatchObject({ rootPc: 8, quality: 4, omissions: [7] });
    expect(editor.extensions).toBeUndefined();
    expect(soundedPitchClasses(editorChordToChord(editor))).toEqual(
      soundedPitchClasses(chordFromSpan(span)),
    );
  });

  it('expresses a tone set the base quality lacks as extensions', () => {
    // A dominant with a lowered ninth and a raised eleventh over an intact triad.
    const span: ChordSpan = {
      rootPc: 0,
      quality: 'dom7',
      startBeat: 0,
      intervals: [0, 4, 7, 10, 13, 18],
    };
    const editor = chordSpanToEditorChord(span, 0, 4);
    expect(editor).toMatchObject({ quality: 4, extensions: [1, 6] });
    expect(editor.omissions).toBeUndefined();
    expect(soundedPitchClasses(editorChordToChord(editor))).toEqual(
      soundedPitchClasses(chordFromSpan(span)),
    );
  });

  it('reads a span with no tone set from its quality alone', () => {
    for (const quality of Object.keys(QUALITY_SUFFIX) as ChordQuality[]) {
      const mapped = libcantusQualityToEditor(quality);
      const editor = chordSpanToEditorChord({ rootPc: 0, quality, startBeat: 0 }, 0, 4);
      expect(editor.quality).toBe(mapped.quality);
      expect(editor.extensions).toEqual(mapped.extensions);
      expect(editor.omissions).toEqual(mapped.omissions);
    }
  });

  // The editor offers combinations libcantus has no quality string for, so the
  // span has to carry their tones; naming them with the nearest quality would
  // drop the very tones that make them those chords.
  it.each(CHORD_QUALITY_CHOICES)('sounds the tones $label declares as a span', (choice) => {
    const symbol = chordSymbol({
      quality: choice.quality,
      ...(choice.extensions === undefined ? {} : { extensions: [...choice.extensions] }),
      ...(choice.omissions === undefined ? {} : { omissions: [...choice.omissions] }),
    });
    expect(soundedPitchClasses(chordFromSpan(editorChordToChordSpan(symbol, 0)))).toEqual(
      chordTonePitchClasses(symbol),
    );
  });

  it('preserves a slash bass when it differs from the root', () => {
    const span = editorChordToChordSpan(chordSymbol({ rootPc: 0, quality: 0, bassPc: 7 }), 0);
    expect(span.bassPc).toBe(7);
    const back = chordSpanToEditorChord(span, 0, 4);
    expect(back.bassPc).toBe(7);
  });
});

describe('chord detection', () => {
  // The detector names an augmented sixth after the nearest quality it has, a
  // dominant seventh, while the chord sounds no fifth. The region has to carry
  // that tone set through to the editor symbol, or the chord track would ask
  // for a pitch class the passage never sounds.
  it('carries the tones of an augmented sixth through to the editor symbol', () => {
    const events = editorNotesToNoteEvents([
      note({ id: 1, pitch: 60, startPpq: 0, durationPpq: 2 }),
      note({ id: 2, pitch: 64, startPpq: 0, durationPpq: 2 }),
      note({ id: 3, pitch: 67, startPpq: 0, durationPpq: 2 }),
      note({ id: 4, pitch: 65, startPpq: 2, durationPpq: 2 }),
      note({ id: 5, pitch: 69, startPpq: 2, durationPpq: 2 }),
      note({ id: 6, pitch: 72, startPpq: 2, durationPpq: 2 }),
      // Ab, C, F# -- an Italian sixth resolving onto the dominant.
      note({ id: 7, pitch: 56, startPpq: 4, durationPpq: 2 }),
      note({ id: 8, pitch: 60, startPpq: 4, durationPpq: 2 }),
      note({ id: 9, pitch: 66, startPpq: 4, durationPpq: 2 }),
      note({ id: 10, pitch: 55, startPpq: 6, durationPpq: 2 }),
      note({ id: 11, pitch: 59, startPpq: 6, durationPpq: 2 }),
      note({ id: 12, pitch: 62, startPpq: 6, durationPpq: 2 }),
    ]);
    const { regions } = detectChordRegions(events, [{ startPpq: 0, endPpq: 8, slotLengthPpq: 2 }]);

    const sixth = regions.find((region) => region.startPpq === 4);
    expect(sixth?.span).toMatchObject({ rootPc: 8, quality: 'dom7', intervals: [0, 4, 10] });
    const symbol = chordSpanToEditorChord(sixth!.span, sixth!.startPpq, sixth!.endPpq);
    // Exactly Ab, C and F#: naming the chord Ab7 would add an Eb nothing plays.
    expect(soundedPitchClasses(editorChordToChord(symbol))).toEqual([0, 6, 8]);
    expect(chordTonePitchClasses(symbol)).toEqual([0, 6, 8]);
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

  it('selects the governing meter at a position', () => {
    expect(timeSignatureAtPpq(segments, 0).numerator).toBe(4);
    expect(timeSignatureAtPpq(segments, 15).numerator).toBe(4);
    expect(timeSignatureAtPpq(segments, 16).numerator).toBe(3);
    expect(timeSignatureAtPpq(segments, 100).numerator).toBe(3);
  });

  it('falls back to 4/4 for an empty map', () => {
    expect(timeSignatureAtPpq([], 0)).toEqual({ numerator: 4, denominator: 4 });
  });

  it('keeps an additive grouping on the resolved signature', () => {
    const additive = [{ startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] }];
    expect(timeSignatureAtPpq(additive, 3).grouping).toEqual([2, 2, 3]);
  });

  it('starts a bar at every meter change, tolerating unsorted maps', () => {
    // Downbeats of both segments are strong; the second bar of the 3/4 segment
    // starts at beat 16 + 3 = 19. Passing the map out of order exercises the
    // shared helper's internal sort so both callers see the same verdict.
    const unsorted = [
      { startPpq: 16, numerator: 3, denominator: 4 },
      { startPpq: 0, numerator: 4, denominator: 4 },
    ];
    expect(strongBeatAt(unsorted, 0)).toBe(true);
    expect(strongBeatAt(unsorted, 1)).toBe(false);
    expect(strongBeatAt(unsorted, 16)).toBe(true);
    expect(strongBeatAt(unsorted, 19)).toBe(true);
  });

  it('treats additive-group starts as strong beats', () => {
    const additive = [{ startPpq: 0, numerator: 7, denominator: 8, grouping: [2, 2, 3] }];
    // Eighth-note units are 0.5 PPQ: 2+2+3 starts at 0, 1, and 2 PPQ.
    expect(strongBeatAt(additive, 0)).toBe(true);
    expect(strongBeatAt(additive, 1)).toBe(true);
    expect(strongBeatAt(additive, 2)).toBe(true);
    expect(strongBeatAt(additive, 0.5)).toBe(false);
    expect(strongBeatAt(additive, 1.5)).toBe(false);
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

  it('retains custom extension intervals and explicit gaps in the chord timeline', () => {
    const timeline = buildChordTimeline([
      chordSymbol({ startPpq: 0, endPpq: 2, quality: 1, extensions: [2] }),
      chordSymbol({ startPpq: 3, endPpq: 4, rootPc: 7, quality: 4, extensions: [1] }),
    ]);
    expect(chordPitchClasses(timeline.at(1)!)).toEqual([0, 2, 3, 7]);
    expect(timeline.at(2.5)).toBeNull();
    expect(timeline.at(3)?.quality).toBe('7b9');
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

  it('recognizes explicitly named melody tracks without classifying accompaniment', () => {
    expect(isMelodyTrack(track({ name: 'Lead Vocal' }))).toBe(true);
    expect(isMelodyTrack(track({ name: 'Topline' }))).toBe(true);
    expect(isMelodyTrack(track({ name: 'Piano Comp' }))).toBe(false);
  });

  it('classifies drum tracks by channel-10 majority', () => {
    const drumNotes = [note({ channel: 9 }), note({ channel: 9 }), note({ channel: 0 })];
    expect(isDrumTrack(track({ name: 'Kick' }), drumNotes)).toBe(true);
    const pitched = [note({ channel: 0 }), note({ channel: 0 }), note({ channel: 9 })];
    expect(isDrumTrack(track({ name: 'Bass' }), pitched)).toBe(false);
  });

  it('lets the explicit percussion flag override the heuristic', () => {
    const drumNotes = [note({ channel: 9 }), note({ channel: 9 })];
    // false forces harmonic even for a drum name on channel 10.
    expect(isDrumTrack(track({ name: 'Drums', percussion: false }), drumNotes)).toBe(false);
    // true forces percussion even for a harmonic name with no drum notes.
    expect(isDrumTrack(track({ name: 'Piano', percussion: true }))).toBe(true);
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
