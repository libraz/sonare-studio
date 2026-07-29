import { describe, expect, it } from 'vitest';
import type { NotatedMeasure, NotatedScore } from '@/notation/model';
import { serializeMusicXml } from '@/notation/musicxml';
import type { EditorClip, EditorSection, EditorTrack } from '@/project/types';
import { scoreKeyMarkerName, scoreLyricMarkerName } from '@/ui/score/marker-editors';
import {
  applyKeySignatureMarks,
  applyLayoutBreaks,
  applyLoopMarks,
  applyLyricMarks,
  applyMarkerTexts,
  applyMultiMeasureRests,
  applySectionMarks,
  applyTempoMarks,
  buildFullScore,
  buildFullScoreProjection,
  fullScorePartTrackIds,
  transposeChordSymbols,
  transposeKeyFifths,
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

function lyricScore(): NotatedScore {
  const out = score();
  for (const measure of out.parts[0].measures) {
    measure.voices = [
      {
        voice: 1,
        events: [
          {
            kind: 'note',
            pitches: [60],
            voice: 1,
            startPpq: measure.startPpq,
            durationPpq: 1,
            value: { base: 'quarter', dots: 0 },
            tieStart: false,
            tieStop: false,
          },
        ],
      },
    ];
  }
  return out;
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
  it('uses one all-part audible projection for Full Score engraving and harmony', () => {
    const projection = buildFullScoreProjection(
      {
        clips: [
          midiClip({
            id: 1,
            trackId: 1,
            startPpq: 0,
            sourceOffsetPpq: 0,
            notes: [{ id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
          midiClip({
            id: 2,
            trackId: 2,
            startPpq: 0,
            sourceOffsetPpq: 0,
            notes: [
              { id: 2, pitch: 64, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
              { id: 3, pitch: 67, velocity: 96, startPpq: 8, durationPpq: 1, channel: 0 },
            ],
          }),
        ],
        scoreAnnotations: {},
      } as never,
      0,
      4,
    );

    expect(projection.notes.map((note) => note.pitch)).toEqual([60, 64]);
    expect(projection.notesByTrack.get(1)?.map((note) => note.pitch)).toEqual([60]);
    expect(projection.notesByTrack.get(2)?.map((note) => note.pitch)).toEqual([64]);
  });

  it('builds one named part per overlapping MIDI track with automatic clefs', () => {
    const out = buildFullScore(
      {
        tracks: [
          { ...track(1), name: 'Bass' },
          { ...track(2), name: 'Lead' },
          { ...track(3), name: 'Audio', kind: 'audio' },
        ],
        clips: [
          midiClip({
            id: 1,
            trackId: 1,
            notes: [{ id: 1, pitch: 36, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 }],
          }),
          midiClip({
            id: 2,
            trackId: 2,
            notes: [{ id: 2, pitch: 72, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 }],
          }),
          midiClip({
            id: 3,
            trackId: 3,
            notes: [{ id: 3, pitch: 60, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 }],
          }),
        ],
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

    expect(out.parts.map((part) => [part.id, part.name, part.clef])).toEqual([
      ['P1', 'Bass', 'bass'],
      ['P2', 'Lead', 'treble'],
    ]);
  });

  it('preserves imported MusicXML part ids when rebuilding a full score', () => {
    const out = buildFullScore(
      {
        tracks: [
          { ...track(1), name: 'Flute', musicXmlPartId: 'flute-01' },
          { ...track(2), name: 'Cello', musicXmlPartId: 'cello-01' },
        ],
        clips: [
          midiClip({
            id: 1,
            trackId: 1,
            notes: [{ id: 1, pitch: 72, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
          midiClip({
            id: 2,
            trackId: 2,
            notes: [{ id: 2, pitch: 48, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
        ],
      } as never,
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 4,
        displayTransposeSemitones: 0,
      },
    );

    expect(out.parts.map((part) => part.id)).toEqual(['flute-01', 'cello-01']);
  });

  it('exports both pitched and percussion parts for one imported hybrid track', () => {
    const out = buildFullScore(
      {
        tracks: [{ ...track(1), name: 'Hybrid', musicXmlPartId: 'hybrid-01' }],
        clips: [
          midiClip({
            id: 1,
            trackId: 1,
            startPpq: 0,
            sourceOffsetPpq: 0,
            lengthPpq: 4,
            notes: [
              { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
              { id: 2, pitch: 36, velocity: 96, startPpq: 1, durationPpq: 1, channel: 9 },
            ],
          }),
        ],
      } as never,
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 4,
        displayTransposeSemitones: 0,
      },
    );

    expect(out.parts.map((part) => part.id)).toEqual(['hybrid-01', 'hybrid-01-percussion']);
  });

  it('maps every hybrid Full Score part back to its source track', () => {
    const store = {
      tracks: [
        { ...track(1), name: 'Hybrid' },
        { ...track(2), name: 'Lead' },
      ],
      clips: [
        midiClip({
          id: 1,
          trackId: 1,
          startPpq: 0,
          sourceOffsetPpq: 0,
          lengthPpq: 4,
          notes: [
            { id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
            { id: 2, pitch: 36, velocity: 96, startPpq: 1, durationPpq: 1, channel: 9 },
          ],
        }),
        midiClip({
          id: 2,
          trackId: 2,
          startPpq: 0,
          sourceOffsetPpq: 0,
          lengthPpq: 4,
          notes: [{ id: 3, pitch: 72, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
        }),
      ],
      scoreAnnotations: {},
    } as never;

    expect(fullScorePartTrackIds(store, 0, 4)).toEqual([1, 1, 2]);
  });

  it('applies the production full-score fingering option to every part', () => {
    const out = buildFullScore(
      {
        tracks: [track(1)],
        clips: [
          midiClip({
            startPpq: 0,
            lengthPpq: 8,
            sourceOffsetPpq: 0,
            notes: [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, index) => ({
              id: index + 1,
              pitch,
              velocity: 96,
              startPpq: index,
              durationPpq: 0.75,
              channel: 0,
            })),
          }),
        ],
      } as never,
      {
        divisionPpq: 0.25,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 8,
        displayTransposeSemitones: 0,
        estimateFingering: true,
      },
    );

    const fingers = out.parts[0].measures
      .flatMap((measure) => measure.voices)
      .flatMap((voice) => voice.events)
      .filter((event) => event.kind === 'note')
      .map((event) => event.fingering?.[0]);
    expect(fingers).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
  });

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

  it('keeps identical note ids in different clips distinct through MusicXML', () => {
    const out = buildFullScore(
      {
        tracks: [track(1), track(2)],
        clips: [
          midiClip({
            id: 10,
            trackId: 1,
            startPpq: 0,
            sourceOffsetPpq: 0,
            notes: [{ id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
          midiClip({
            id: 20,
            trackId: 2,
            startPpq: 0,
            sourceOffsetPpq: 0,
            notes: [{ id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          }),
        ],
        scoreAnnotations: {
          10: { 1: { dynamics: 'f' } },
          20: { 1: { articulation: 'staccato' } },
        },
      } as never,
      {
        divisionPpq: 1,
        timeSig: { beats: 4, beatUnit: 4 },
        keyFifths: 0,
        clipStartPpq: 0,
        clipLengthPpq: 4,
        displayTransposeSemitones: 0,
      },
    );

    const identities = out.parts.map(
      (part) =>
        part.measures[0].voices[0].events.find((event) => event.kind === 'note')
          ?.sourceIdentities?.[0],
    );
    expect(identities).toEqual([
      { clipId: 10, noteId: 1, occurrence: 0 },
      { clipId: 20, noteId: 1, occurrence: 0 },
    ]);
    const xml = serializeMusicXml(out);
    expect(xml).toContain('xml:id="sonare-note-c10n1o0-s0-p0"');
    expect(xml).toContain('xml:id="sonare-note-c20n1o0-s0-p0"');
    expect(xml).toContain('<f/>');
    expect(xml).toContain('<staccato placement="above"/>');
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
    expect(out.measureTempoMarks).toEqual({
      0: [{ bpm: 120, offsetPpq: 0 }],
      1: [
        { bpm: 96, offsetPpq: 0 },
        { bpm: 88, offsetPpq: 2 },
      ],
    });
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
    expect(out.measureTempoMarks).toEqual({
      0: [{ bpm: 120, offsetPpq: 0 }],
      1: [{ bpm: 90, offsetPpq: 0 }],
    });
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
      0: [{ text: 'rit.', bpm: 120, offsetPpq: 0 }],
      1: [{ text: 'a tempo', bpm: 90, offsetPpq: 0 }],
      2: [{ text: 'accel.', bpm: 90, offsetPpq: 0 }],
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
    expect(out.measureTempoMarks).toEqual({
      0: [{ bpm: 120, offsetPpq: 0 }],
      2: [{ bpm: 96, offsetPpq: 0 }],
    });
  });

  it('keeps a mid-measure tempo offset on a variable-meter grid', () => {
    const out = variableMeterScore();
    applyTempoMarks(
      out,
      [
        { startPpq: 0, bpm: 120 },
        { startPpq: 5, bpm: 84 },
      ],
      120,
      0,
      10,
      4,
    );
    expect(out.measureTempoMarks).toEqual({
      0: [{ bpm: 120, offsetPpq: 0 }],
      1: [{ bpm: 84, offsetPpq: 1 }],
    });
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
        { id: 4, ppq: 8, name: 'Key: E minor' },
        { id: 5, ppq: 8, name: 'Lyric: sing' },
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

describe('applyLyricMarks', () => {
  it('adds lyric markers as score lyrics in timeline order', () => {
    const out = lyricScore();
    applyLyricMarks(
      out,
      [
        { id: 1, ppq: 4, name: 'Lyric: world' },
        { id: 2, ppq: 0, name: 'Lyric: hello' },
        { id: 3, ppq: 6, name: 'Text: ignored' },
      ],
      0,
      12,
    );

    expect(out.lyrics).toEqual([
      { ppq: 0, text: 'hello' },
      { ppq: 4, text: 'world' },
    ]);
  });

  it('parses structured lyric markers for verse, syllabic and melisma extend', () => {
    const out = lyricScore();
    applyLyricMarks(
      out,
      [
        { id: 1, ppq: 0, name: 'Lyric 2: begin: glo~' },
        { id: 2, ppq: 4, name: 'Lyric #2: end: ria' },
        { id: 3, ppq: 8, name: 'Lyric: plain' },
      ],
      0,
      12,
    );

    expect(out.lyrics).toEqual([
      { ppq: 0, text: 'glo', verse: 2, syllabic: 'begin', extend: true },
      { ppq: 4, text: 'ria', verse: 2, syllabic: 'end' },
      { ppq: 8, text: 'plain' },
    ]);
  });

  it('consumes lyric marker names produced by the score marker editor helpers', () => {
    const out = lyricScore();
    applyLyricMarks(
      out,
      [
        {
          id: 1,
          ppq: 0,
          name: scoreLyricMarkerName('glo', { verse: 3, syllabic: 'begin', extend: true }),
        },
        { id: 2, ppq: 4, name: scoreLyricMarkerName('ria', { verse: 3, syllabic: 'end' }) },
      ],
      0,
      12,
    );

    expect(out.lyrics).toEqual([
      { ppq: 0, text: 'glo', verse: 3, syllabic: 'begin', extend: true },
      { ppq: 4, text: 'ria', verse: 3, syllabic: 'end' },
    ]);
  });

  it('ignores lyric markers outside the score window', () => {
    const out = lyricScore();
    applyLyricMarks(
      out,
      [
        { id: 1, ppq: 0, name: 'Lyric: before' },
        { id: 2, ppq: 8, name: 'Lyric: in' },
        { id: 3, ppq: 16, name: 'Lyric: after' },
      ],
      4,
      8,
    );

    expect(out.lyrics).toEqual([{ ppq: 8, text: 'in' }]);
  });

  it('snaps arbitrary marker positions to the nearest note attack', () => {
    const out = lyricScore();
    applyLyricMarks(out, [{ id: 1, ppq: 6.25, name: 'Lyric: snap' }], 0, 12);
    expect(out.lyrics).toEqual([{ ppq: 8, text: 'snap' }]);
  });
});

describe('applyKeySignatureMarks', () => {
  it('transposes key signatures and chord pitch classes together', () => {
    expect(transposeKeyFifths(-1, 2)).toBe(1); // F major -> G major
    expect(transposeChordSymbols([{ ppq: 0, text: 'F/C', rootPc: 5, bassPc: 0 }], 2)).toEqual([
      { ppq: 0, text: 'F/C', rootPc: 7, bassPc: 2 },
    ]);
  });

  it('transposes key markers by the display transposition', () => {
    const out = score();
    applyKeySignatureMarks(out, [{ id: 1, ppq: 4, name: 'Key: F major' }], 0, 12, 4, 2);

    expect(out.measureKeyFifths).toEqual({ 1: 1 }); // F + whole step = G major
  });

  it('adds measure-aligned key signature changes from key markers', () => {
    const out = score();
    applyKeySignatureMarks(
      out,
      [
        { id: 1, ppq: 0, name: 'Key: C major' },
        { id: 2, ppq: 4, name: 'Key: E minor' },
        { id: 3, ppq: 6, name: 'Key: Bb major' },
        { id: 4, ppq: 8, name: 'Key: F# major' },
      ],
      0,
      12,
      4,
    );

    expect(out.measureKeyFifths).toEqual({ 1: 1, 2: 6 });
  });

  it('consumes key marker names produced by the score marker editor helpers', () => {
    const out = score();
    applyKeySignatureMarks(
      out,
      [
        { id: 1, ppq: 0, name: scoreKeyMarkerName('C', 'major') },
        { id: 2, ppq: 4, name: scoreKeyMarkerName('Bb', 'minor') },
      ],
      0,
      12,
      4,
    );

    expect(out.measureKeyFifths).toEqual({ 1: -5 });
  });

  it('normalizes the selectable Db minor marker to its MusicXML-safe enharmonic key', () => {
    const out = score();
    applyKeySignatureMarks(out, [{ id: 1, ppq: 4, name: 'Key: Db minor' }], 0, 12, 4);

    expect(out.measureKeyFifths).toEqual({ 1: 4 });
  });

  it('uses the latest preceding key marker at the score window start', () => {
    const out = score();
    applyKeySignatureMarks(
      out,
      [
        { id: 1, ppq: 0, name: 'Key: F major' },
        { id: 2, ppq: 4, name: 'Key: D major' },
        { id: 3, ppq: 12, name: 'Key: Bb major' },
      ],
      8,
      8,
      4,
    );

    expect(out.measureKeyFifths).toEqual({ 0: 2, 1: -2 });
  });

  it('uses score measure starts for key changes after time-signature changes', () => {
    const out = variableMeterScore();
    applyKeySignatureMarks(out, [{ id: 1, ppq: 7, name: 'Key: Bb major' }], 0, 10, 4);
    expect(out.measureKeyFifths).toEqual({ 2: -2 });
  });

  it('keeps key changes after an opening pickup on the variable measure grid', () => {
    const out: NotatedScore = {
      parts: [
        {
          id: 'P1',
          name: 'Pickup',
          clef: 'treble',
          measures: [
            meterMeasure(0, 0, 1, 4, 4),
            meterMeasure(1, 1, 3, 3, 4),
            meterMeasure(2, 4, 3, 3, 4),
          ],
        },
      ],
      keyFifths: 0,
      divisions: 960,
    };

    applyKeySignatureMarks(out, [{ id: 1, ppq: 4, name: 'Key: D major' }], 0, 7, 4);
    expect(out.measureKeyFifths).toEqual({ 2: 2 });
  });
});

describe('applyMultiMeasureRests', () => {
  it('marks consecutive silent grand-staff measures as a multi-measure rest', () => {
    const whole = { base: 'whole' as const, dots: 0 };
    const fullRest = (voice: 1 | 2, startPpq: number) => ({
      kind: 'rest' as const,
      voice,
      startPpq,
      durationPpq: 4,
      value: whole,
    });
    const measures = [0, 1].map((index) => ({
      index,
      startPpq: index * 4,
      lengthPpq: 4,
      timeSig: { beats: 4, beatUnit: 4 },
      voices: [
        { voice: 1 as const, staff: 1 as const, events: [fullRest(1, index * 4)] },
        { voice: 2 as const, staff: 2 as const, events: [fullRest(2, index * 4)] },
      ],
    }));
    const out: NotatedScore = {
      parts: [{ id: 'P1', name: 'Piano', clef: 'grand', measures }],
      keyFifths: 0,
      divisions: 960,
    };

    applyMultiMeasureRests(out);
    expect(out.multiMeasureRests).toEqual({ 0: { count: 2 } });
  });

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

  it.each([
    ['key change', (out: NotatedScore) => (out.measureKeyFifths = { 3: -2 })],
    [
      'tempo mark',
      (out: NotatedScore) => (out.measureTempoMarks = { 3: [{ bpm: 90, offsetPpq: 0 }] }),
    ],
    ['rehearsal', (out: NotatedScore) => (out.measureRehearsals = { 3: 'B' })],
    ['repeat', (out: NotatedScore) => (out.measureRepeats = { 3: 'start' })],
    ['barline', (out: NotatedScore) => (out.measureBarlines = { 3: 'double' })],
    ['layout break', (out: NotatedScore) => (out.measureBreaks = { 3: 'system' })],
    ['text direction', (out: NotatedScore) => (out.measureTexts = { 3: [{ text: 'Cue' }] })],
    ['chord symbol', (out: NotatedScore) => (out.chordSymbols = [{ ppq: 12, text: 'C' }])],
  ])('splits empty runs at a %s', (_label, addStructure) => {
    const out: NotatedScore = {
      ...score(),
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [measure(0), ...[1, 2, 3, 4, 5].map(restMeasure)],
        },
      ],
    };
    addStructure(out);

    applyMultiMeasureRests(out);

    expect(out.multiMeasureRests).toEqual({ 1: { count: 2 }, 4: { count: 2 } });
  });

  it('splits an empty run at a time-signature change', () => {
    const changed = restMeasure(3);
    changed.startPpq = 12;
    changed.lengthPpq = 3;
    changed.timeSig = { beats: 3, beatUnit: 4 };
    changed.voices[0].events[0].startPpq = 12;
    changed.voices[0].events[0].durationPpq = 3;
    const continued = [
      { index: 4, startPpq: 15 },
      { index: 5, startPpq: 18 },
    ].map(({ index, startPpq }) => {
      const rest = restMeasure(index);
      rest.startPpq = startPpq;
      rest.lengthPpq = 3;
      rest.timeSig = { beats: 3, beatUnit: 4 };
      rest.voices[0].events[0].startPpq = startPpq;
      rest.voices[0].events[0].durationPpq = 3;
      return rest;
    });
    const out: NotatedScore = {
      ...score(),
      parts: [
        {
          id: 'P1',
          name: 'Lead',
          clef: 'treble',
          measures: [measure(0), restMeasure(1), restMeasure(2), changed, ...continued],
        },
      ],
    };

    applyMultiMeasureRests(out);

    expect(out.multiMeasureRests).toEqual({ 1: { count: 2 }, 4: { count: 2 } });
  });
});
