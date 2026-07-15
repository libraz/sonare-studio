import { describe, expect, it } from 'vitest';
import { buildGhostNotes } from '@/components/piano-roll/overlay';
import { buildMidiClipSchedules } from '@/engine/midi-sync';
import {
  audibleMidiProjector,
  audibleMidiSourceNotes,
  audibleMidiSourcePoints,
  mergeAudibleMidiSourcePoints,
  projectMidiClipNoteOccurrences,
  projectMidiNoteOccurrences,
} from '@/project/midi-projection';
import type { EditorClip, EditorTrack } from '@/project/types';
import { buildScoreProjection } from '@/ui/score/use-score-notation';

function clip(overrides: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 10,
    trackId: 1,
    name: 'Loop',
    startPpq: 8,
    lengthPpq: 5,
    sourceOffsetPpq: 2,
    gain: 1,
    loopEnabled: true,
    loopLengthPpq: 2,
    notes: [
      { id: 1, pitch: 60, velocity: 100, startPpq: 1, durationPpq: 1, channel: 0 },
      { id: 2, pitch: 62, velocity: 100, startPpq: 2, durationPpq: 0.5, channel: 0 },
      { id: 3, pitch: 64, velocity: 100, startPpq: 3, durationPpq: 1, channel: 0 },
      { id: 4, pitch: 65, velocity: 100, startPpq: 4, durationPpq: 1, channel: 0 },
    ],
    ...overrides,
  };
}

describe('projectMidiNoteOccurrences', () => {
  it('projects expression points into the same trimmed source window and preserves hidden points', () => {
    const fixture = clip(); // source window [2, 4], because the loop is two PPQ
    const stored = [
      { ppq: 0, value: 10 },
      { ppq: 1, value: 20 },
      { ppq: 3, value: 30 },
    ];

    expect(audibleMidiSourcePoints(fixture, stored)).toEqual([
      { ppq: 2, value: 10 },
      { ppq: 3, value: 20 },
    ]);
    expect(
      mergeAudibleMidiSourcePoints(fixture, stored, [
        { ppq: 2.5, value: 40 },
        { ppq: 8, value: 99 },
      ]),
    ).toEqual([
      { ppq: 0.5, value: 40 },
      { ppq: 3, value: 30 },
    ]);
  });

  it('projects trim, move and loop repeats while retaining composite identity', () => {
    const notes = projectMidiNoteOccurrences(clip());

    expect(notes.map((note) => [note.startPpq, note.pitch, note.sourceIdentity])).toEqual([
      [8, 62, { clipId: 10, noteId: 2, occurrence: 0 }],
      [9, 64, { clipId: 10, noteId: 3, occurrence: 0 }],
      [10, 62, { clipId: 10, noteId: 2, occurrence: 1 }],
      [11, 64, { clipId: 10, noteId: 3, occurrence: 1 }],
      [12, 62, { clipId: 10, noteId: 2, occurrence: 2 }],
    ]);
    expect(notes.some((note) => note.sourceIdentity.noteId === 1)).toBe(false);
    expect(notes.at(-1)?.durationPpq).toBe(0.5);
  });

  it('keeps one moved/trimmed/looped fixture onset-identical across live and UI surfaces', () => {
    const fixture = clip({
      notes: [
        { id: 1, pitch: 60, velocity: 100, startPpq: 1.5, durationPpq: 1, channel: 0 },
        { id: 2, pitch: 62, velocity: 100, startPpq: 2, durationPpq: 0.5, channel: 0 },
        { id: 3, pitch: 64, velocity: 100, startPpq: 3, durationPpq: 1, channel: 0 },
        { id: 4, pitch: 65, velocity: 100, startPpq: 4, durationPpq: 1, channel: 0 },
      ],
    });
    const expectedTimelineOnsets = [8, 8, 9, 10, 10, 11, 12, 12];
    const projected = audibleMidiProjector(fixture);

    expect(projected.map((entry) => entry.timelineStartPpq)).toEqual(expectedTimelineOnsets);
    expect(projected.map((entry) => entry.clipStartPpq + fixture.startPpq)).toEqual(
      expectedTimelineOnsets,
    );
    expect(audibleMidiSourceNotes(fixture).map((note) => note.id)).toEqual([2, 1, 3]);

    // Guidance, chord detection, and clip-local generation consume this adapter.
    expect(
      projectMidiClipNoteOccurrences(fixture).map((note) => note.startPpq + fixture.startPpq),
    ).toEqual(expectedTimelineOnsets);

    const track: EditorTrack = {
      id: fixture.trackId,
      name: 'Lead',
      color: '#60a5fa',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      order: 0,
    };
    const [live] = buildMidiClipSchedules([track], [fixture], [{ startPpq: 0, bpm: 60 }], 100);
    const liveOnsets = live.events
      .filter((event) => (((event.word0 as number) >>> 20) & 0x0f) === 0x09)
      .map((event) => event.renderFrame / 100);
    const scoreOnsets = buildScoreProjection([fixture]).notes.map((note) => note.startPpq);
    const ghostOnsets = buildGhostNotes({
      clips: [fixture],
      tracks: [track],
      activeClipId: -1,
    }).map((note) => note.startPpq);

    expect(liveOnsets).toEqual(expectedTimelineOnsets);
    expect(scoreOnsets).toEqual(expectedTimelineOnsets);
    expect(ghostOnsets).toEqual(expectedTimelineOnsets);
  });
});
