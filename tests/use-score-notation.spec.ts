import { describe, expect, it } from 'vitest';
import type { NotatedMeasure, NotatedScore } from '@/notation/model';
import type { EditorClip, EditorSection, EditorTrack } from '@/project/types';
import {
  applyLayoutBreaks,
  applyLoopMarks,
  applyMarkerTexts,
  applyMultiMeasureRests,
  applySectionMarks,
  applyTempoMarks,
  buildFullScore,
} from '@/ui/score/use-score-notation';

function measure(index: number): NotatedMeasure {
  return {
    index,
    startPpq: index * 4,
    lengthPpq: 4,
    timeSig: { beats: 4, beatUnit: 4 },
    voices: [{ voice: 1, events: [] }],
  };
}

function meterMeasure(
  index: number,
  startPpq: number,
  lengthPpq: number,
  beats: number,
  beatUnit: number,
): NotatedMeasure {
  return {
    ...measure(index),
    startPpq,
    lengthPpq,
    timeSig: { beats, beatUnit },
  };
}

function restMeasure(index: number): NotatedMeasure {
  return {
    index,
    startPpq: index * 4,
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
            startPpq: index * 4,
            durationPpq: 4,
            value: { base: 'whole', dots: 0 },
            tieStart: false,
            tieStop: false,
          },
        ],
      },
    ],
  };
}

function score(): NotatedScore {
  return {
    parts: [
      { id: 'P1', name: 'Lead', clef: 'treble', measures: [measure(0), measure(1), measure(2)] },
    ],
    keyFifths: 0,
    divisions: 960,
  };
}

function track(id: number): EditorTrack {
  return {
    id,
    name: `Track ${id}`,
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
  };
}

function midiClip(overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Clip',
    startPpq: 8,
    lengthPpq: 2,
    sourceOffsetPpq: 2,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [
      { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { id: 2, pitch: 62, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 },
      { id: 3, pitch: 64, velocity: 96, startPpq: 3, durationPpq: 1, channel: 0 },
      { id: 4, pitch: 65, velocity: 96, startPpq: 4, durationPpq: 1, channel: 0 },
    ],
    ...overrides,
  };
}

function variableMeterScore(): NotatedScore {
  return {
    parts: [
      {
        id: 'P1',
        name: 'Lead',
        clef: 'treble',
        measures: [
          meterMeasure(0, 0, 4, 4, 4),
          meterMeasure(1, 4, 3, 3, 4),
          meterMeasure(2, 7, 3, 3, 4),
        ],
      },
    ],
    keyFifths: 0,
    divisions: 960,
  };
}

describe('buildFullScore', () => {
  it('uses playback note windows so trimmed MIDI clips do not show hidden notes', () => {
    const out = buildFullScore(
      {
        tracks: [track(1)],
        clips: [midiClip()],
      } as never,
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 8,
        clipLengthPpq: 4,
        displayTransposeSemitones: 0,
      },
    );

    const notes = out.parts[0].measures
      .flatMap((measure) => measure.voices)
      .flatMap((voice) => voice.events)
      .filter((event) => event.kind === 'note');

    expect(notes.map((event) => [event.startPpq, event.pitches])).toEqual([
      [8, [62]],
      [9, [64]],
    ]);
  });
});

function section(id: number, name: string, startPpq: number, endPpq = startPpq + 4): EditorSection {
  return { id, name, color: '#64748b', startPpq, endPpq };
}

describe('applySectionMarks', () => {
  it('adds rehearsal marks and double bars for section starts on measure boundaries', () => {
    const out = score();
    applySectionMarks(out, [section(1, 'Verse', 0), section(2, 'Chorus', 4)], 0, 12, 4);
    expect(out.measureRehearsals).toEqual({ 0: 'Verse', 1: 'Chorus' });
    expect(out.measureBarlines).toEqual({ 0: 'double' });
  });

  it('ignores unaligned and out-of-clip section starts', () => {
    const out = score();
    applySectionMarks(out, [section(1, 'Pickup', 2), section(2, 'After', 12)], 0, 12, 4);
    expect(out.measureRehearsals).toBeUndefined();
    expect(out.measureBarlines).toBeUndefined();
  });

  it('maps sections relative to the clip start', () => {
    const out = score();
    applySectionMarks(out, [section(1, 'B', 12)], 8, 12, 4);
    expect(out.measureRehearsals).toEqual({ 1: 'B' });
    expect(out.measureBarlines).toEqual({ 0: 'double' });
  });

  it('uses score measure starts after time-signature changes', () => {
    const out = variableMeterScore();
    applySectionMarks(out, [section(1, 'Bridge', 7)], 0, 10, 4);
    expect(out.measureRehearsals).toEqual({ 2: 'Bridge' });
    expect(out.measureBarlines).toEqual({ 1: 'double' });
  });
});

describe('applyLoopMarks', () => {
  it('adds repeat marks for a measure-aligned loop range', () => {
    const out = score();
    applyLoopMarks(out, 4, 12, 0, 12, 4);
    expect(out.measureRepeats).toEqual({ 1: 'start', 2: 'end' });
  });

  it('marks a one-measure loop as both start and end', () => {
    const out = score();
    applyLoopMarks(out, 4, 8, 0, 12, 4);
    expect(out.measureRepeats).toEqual({ 1: 'start-end' });
  });

  it('ignores unaligned and out-of-clip loop ranges', () => {
    const unaligned = score();
    applyLoopMarks(unaligned, 2, 8, 0, 12, 4);
    expect(unaligned.measureRepeats).toBeUndefined();

    const outOfClip = score();
    applyLoopMarks(outOfClip, 4, 16, 0, 12, 4);
    expect(outOfClip.measureRepeats).toBeUndefined();
  });

  it('uses score measure starts for loops after time-signature changes', () => {
    const out = variableMeterScore();
    applyLoopMarks(out, 4, 10, 0, 10, 4);
    expect(out.measureRepeats).toEqual({ 1: 'start', 2: 'end' });
  });
});

describe('applyTempoMarks', () => {
  it('adds the clip-start tempo and measure-aligned tempo changes', () => {
    const out = score();
    applyTempoMarks(
      out,
      [
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 96 },
        { startPpq: 6, bpm: 88 },
      ],
      120,
      0,
      12,
      4,
    );
    expect(out.measureTempos).toEqual({ 0: 120, 1: 96 });
  });

  it('uses the instantaneous tempo at the clip start', () => {
    const out = score();
    applyTempoMarks(
      out,
      [
        { startPpq: 0, bpm: 120 },
        { startPpq: 8, bpm: 90 },
      ],
      120,
      4,
      12,
      4,
    );
    expect(out.measureTempos).toEqual({ 0: 120, 1: 90 });
  });

  it('adds ritardando, accelerando and a tempo text for ramped segments', () => {
    const out = score();
    applyTempoMarks(
      out,
      [
        { startPpq: 0, bpm: 120, endBpm: 90 },
        { startPpq: 4, bpm: 90 },
        { startPpq: 8, bpm: 90, endBpm: 132 },
        { startPpq: 12, bpm: 132 },
      ],
      120,
      0,
      16,
      4,
    );
    expect(out.measureTempoTexts).toEqual({
      0: { text: 'rit.', bpm: 120 },
      1: { text: 'a tempo', bpm: 90 },
      2: { text: 'accel.', bpm: 90 },
    });
  });

  it('uses score measure starts for tempo changes after time-signature changes', () => {
    const out = variableMeterScore();
    applyTempoMarks(
      out,
      [
        { startPpq: 0, bpm: 120 },
        { startPpq: 7, bpm: 96 },
      ],
      120,
      0,
      10,
      4,
    );
    expect(out.measureTempos).toEqual({ 0: 120, 2: 96 });
  });
});

describe('applyLayoutBreaks', () => {
  it('adds regular system breaks, page breaks and section starts', () => {
    const out: NotatedScore = {
      ...score(),
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: Array.from({ length: 18 }, (_, index) => measure(index)),
        },
      ],
    };

    applyLayoutBreaks(out, [section(1, 'Bridge', 12)], 0, 4);

    expect(out.measureBreaks).toEqual({
      3: 'system',
      4: 'system',
      8: 'system',
      12: 'system',
      16: 'page',
    });
  });

  it('uses score measure starts for section layout breaks after time-signature changes', () => {
    const out = variableMeterScore();
    applyLayoutBreaks(out, [section(1, 'Bridge', 7)], 0, 4, {
      barsPerSystem: 0,
      barsPerPage: 0,
    });
    expect(out.measureBreaks).toEqual({ 2: 'system' });
  });
});

describe('applyMarkerTexts', () => {
  it('adds measure-aligned timeline markers as score text', () => {
    const out = score();
    applyMarkerTexts(
      out,
      [
        { id: 1, ppq: 0, name: 'Solo' },
        { id: 2, ppq: 4, name: 'pizz.' },
        { id: 3, ppq: 6, name: 'ignored' },
      ],
      0,
      12,
      4,
    );

    expect(out.measureTexts).toEqual({
      0: [{ text: 'Solo', defaultY: 24 }],
      1: [{ text: 'pizz.', defaultY: 24 }],
    });
  });

  it('uses score measure starts for markers after time-signature changes', () => {
    const out = variableMeterScore();
    applyMarkerTexts(out, [{ id: 1, ppq: 7, name: 'To Coda' }], 0, 10, 4);
    expect(out.measureTexts).toEqual({ 2: [{ text: 'To Coda', defaultY: 24 }] });
  });
});

describe('applyMultiMeasureRests', () => {
  it('marks consecutive empty measures in a single-part score', () => {
    const out: NotatedScore = {
      ...score(),
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [measure(0), restMeasure(1), restMeasure(2), restMeasure(3)],
        },
      ],
    };

    applyMultiMeasureRests(out);

    expect(out.multiMeasureRests).toEqual({ 1: { count: 3 } });
  });
});
