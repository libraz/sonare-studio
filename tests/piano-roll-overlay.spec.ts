import { describe, expect, it } from 'vitest';
import {
  buildGhostNotes,
  clipFrameOffsetPpq,
  contentCenterPitch,
  GHOST_NOTE_ALPHA,
  type GhostNote,
  ghostNoteColor,
  hitTestGhost,
  isNoteInView,
} from '@/components/piano-roll/overlay';
import { DEFAULT_NOTE_COLOR } from '@/components/piano-roll/theme';
import type { EditorClip, EditorNote, EditorTrack } from '@/project/types';
import type { NoteView } from '@/ui/canvas/hit-test';

let nextId = 1;

function makeNote(over: Partial<EditorNote> = {}): EditorNote {
  return {
    id: nextId++,
    pitch: 60,
    velocity: 96,
    startPpq: 0,
    durationPpq: 1,
    channel: 0,
    ...over,
  };
}

function makeTrack(over: Partial<EditorTrack> = {}): EditorTrack {
  return {
    id: 1,
    name: 'Track',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    ...over,
  };
}

function makeClip(over: Partial<EditorClip> = {}): EditorClip {
  return {
    id: 1,
    trackId: 1,
    name: 'Clip',
    startPpq: 0,
    lengthPpq: 32,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    ...over,
  };
}

/** Linear view: 10 px per PPQ, 10 px rows, pitch 127 at y = 0. */
const view: NoteView = {
  ppqToX: (ppq) => ppq * 10,
  pitchToY: (pitch) => (127 - pitch) * 10,
  rowHeight: 10,
};

describe('clipFrameOffsetPpq', () => {
  it('is zero between identical frames', () => {
    const clip = { startPpq: 8, sourceOffsetPpq: 2 };
    expect(clipFrameOffsetPpq(clip, clip)).toBe(0);
  });

  it('projects into the timeline when the target is null', () => {
    expect(clipFrameOffsetPpq({ startPpq: 8, sourceOffsetPpq: 2 }, null)).toBe(6);
  });

  it('composes source and target frames', () => {
    expect(
      clipFrameOffsetPpq({ startPpq: 8, sourceOffsetPpq: 2 }, { startPpq: 4, sourceOffsetPpq: 1 }),
    ).toBe(3);
  });
});

describe('ghostNoteColor', () => {
  it('desaturates toward the luma gray and applies the default alpha', () => {
    // For #ff0000: gray = 0.299 * 255 = 76.245, mixed at 0.65.
    expect(ghostNoteColor('#ff0000')).toBe(`rgba(139, 50, 50, ${GHOST_NOTE_ALPHA})`);
  });

  it('honors a custom alpha', () => {
    expect(ghostNoteColor('#ff0000', 0.5)).toBe('rgba(139, 50, 50, 0.5)');
  });

  it('expands 3-digit hex colors', () => {
    expect(ghostNoteColor('#f00')).toBe(ghostNoteColor('#ff0000'));
  });

  it('falls back to the default note color for unparseable input', () => {
    expect(ghostNoteColor('tomato')).toBe(ghostNoteColor(DEFAULT_NOTE_COLOR));
  });

  it('reduces the channel spread (less saturation than the source)', () => {
    const match = /^rgba\((\d+), (\d+), (\d+),/.exec(ghostNoteColor('#ff0000'));
    expect(match).not.toBeNull();
    const [r, g, b] = (match as RegExpExecArray).slice(1, 4).map(Number);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(255);
  });
});

describe('buildGhostNotes', () => {
  it('skips the active clip and colors ghosts by their track', () => {
    const tracks = [makeTrack({ id: 1, color: '#ff0000' }), makeTrack({ id: 2, color: '#00ff00' })];
    const clips = [
      makeClip({ id: 10, trackId: 1, notes: [makeNote({ pitch: 60 })] }),
      makeClip({ id: 11, trackId: 2, notes: [makeNote({ pitch: 64 })] }),
    ];
    const ghosts = buildGhostNotes({ clips, tracks, activeClipId: 10 });
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].clipId).toBe(11);
    expect(ghosts[0].trackId).toBe(2);
    expect(ghosts[0].pitch).toBe(64);
    expect(ghosts[0].color).toBe(ghostNoteColor('#00ff00'));
  });

  it('projects ghost notes into the active clip frame', () => {
    const tracks = [makeTrack({ id: 1 }), makeTrack({ id: 2 })];
    const clips = [
      makeClip({ id: 10, trackId: 1, startPpq: 4, sourceOffsetPpq: 1 }),
      makeClip({
        id: 11,
        trackId: 2,
        startPpq: 8,
        sourceOffsetPpq: 0,
        notes: [makeNote({ startPpq: 1, durationPpq: 2 })],
      }),
    ];
    const ghosts = buildGhostNotes({ clips, tracks, activeClipId: 10 });
    // Timeline position 8 + 1 = 9, re-expressed in the active clip's
    // source frame: 9 - (4 - 1) = 6.
    expect(ghosts[0].startPpq).toBe(6);
    expect(ghosts[0].durationPpq).toBe(2);
  });

  it('projects into the timeline frame when no clip is active', () => {
    const tracks = [makeTrack({ id: 2 })];
    const clips = [
      makeClip({
        id: 11,
        trackId: 2,
        startPpq: 8,
        sourceOffsetPpq: 2,
        notes: [makeNote({ startPpq: 3 })],
      }),
    ];
    const ghosts = buildGhostNotes({ clips, tracks, activeClipId: -1 });
    expect(ghosts[0].startPpq).toBe(9);
  });

  it('filters ghost notes to their clip audible window', () => {
    const tracks = [makeTrack({ id: 1 }), makeTrack({ id: 2 })];
    const clips = [
      makeClip({ id: 10, trackId: 1 }),
      makeClip({
        id: 11,
        trackId: 2,
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 2,
        notes: [
          makeNote({ pitch: 1, startPpq: 1, durationPpq: 1 }), // ends at window start
          makeNote({ pitch: 2, startPpq: 1.5, durationPpq: 1 }), // overlaps window start
          makeNote({ pitch: 3, startPpq: 3, durationPpq: 1 }), // inside
          makeNote({ pitch: 4, startPpq: 6, durationPpq: 1 }), // starts at window end
        ],
      }),
    ];
    const ghosts = buildGhostNotes({ clips, tracks, activeClipId: 10 });
    expect(ghosts.map((g) => g.pitch)).toEqual([2, 3]);
  });

  it('falls back to the default ghost color for clips on unknown tracks', () => {
    const clips = [makeClip({ id: 10 }), makeClip({ id: 11, trackId: 99, notes: [makeNote()] })];
    const ghosts = buildGhostNotes({ clips, tracks: [], activeClipId: 10 });
    expect(ghosts[0].color).toBe(ghostNoteColor(DEFAULT_NOTE_COLOR));
  });
});

describe('isNoteInView', () => {
  const window = { startPpq: 4, endPpq: 8, minPitch: 60, maxPitch: 72 };

  it('keeps notes intersecting the window', () => {
    expect(isNoteInView({ startPpq: 5, durationPpq: 1, pitch: 64 }, window)).toBe(true);
    expect(isNoteInView({ startPpq: 3, durationPpq: 2, pitch: 64 }, window)).toBe(true);
    expect(isNoteInView({ startPpq: 7.5, durationPpq: 4, pitch: 64 }, window)).toBe(true);
  });

  it('culls notes that only touch the horizontal edges', () => {
    expect(isNoteInView({ startPpq: 3, durationPpq: 1, pitch: 64 }, window)).toBe(false);
    expect(isNoteInView({ startPpq: 8, durationPpq: 1, pitch: 64 }, window)).toBe(false);
  });

  it('culls notes fully outside horizontally', () => {
    expect(isNoteInView({ startPpq: 0, durationPpq: 1, pitch: 64 }, window)).toBe(false);
    expect(isNoteInView({ startPpq: 20, durationPpq: 1, pitch: 64 }, window)).toBe(false);
  });

  it('treats the pitch bounds as inclusive', () => {
    expect(isNoteInView({ startPpq: 5, durationPpq: 1, pitch: 60 }, window)).toBe(true);
    expect(isNoteInView({ startPpq: 5, durationPpq: 1, pitch: 72 }, window)).toBe(true);
    expect(isNoteInView({ startPpq: 5, durationPpq: 1, pitch: 59 }, window)).toBe(false);
    expect(isNoteInView({ startPpq: 5, durationPpq: 1, pitch: 73 }, window)).toBe(false);
  });
});

describe('hitTestGhost', () => {
  function ghost(over: Partial<GhostNote> = {}): GhostNote {
    return {
      noteId: nextId++,
      clipId: 11,
      trackId: 2,
      pitch: 60,
      startPpq: 4,
      durationPpq: 2,
      color: 'rgba(0, 0, 0, 0.32)',
      ...over,
    };
  }

  // Pitch 60 row spans y = [670, 680); PPQ 4..6 spans x = [40, 60).
  const inside = { x: 50, y: 675 };

  it('returns the ghost under the point when no editable note covers it', () => {
    const g = ghost();
    expect(hitTestGhost([], [g], inside, view)).toBe(g);
  });

  it('gives editable notes priority over ghosts', () => {
    const editable = makeNote({ pitch: 60, startPpq: 4, durationPpq: 2 });
    expect(hitTestGhost([editable], [ghost()], inside, view)).toBeNull();
  });

  it('routes to the ghost when the editable note is elsewhere', () => {
    const editable = makeNote({ pitch: 72, startPpq: 0, durationPpq: 1 });
    const g = ghost();
    expect(hitTestGhost([editable], [g], inside, view)).toBe(g);
  });

  it('treats the whole ghost as body (no resize zones at the edges)', () => {
    const g = ghost();
    expect(hitTestGhost([], [g], { x: 40, y: 675 }, view)).toBe(g);
    expect(hitTestGhost([], [g], { x: 59, y: 675 }, view)).toBe(g);
  });

  it('picks the topmost (last) of overlapping ghosts', () => {
    const bottom = ghost({ clipId: 11 });
    const top = ghost({ clipId: 12 });
    expect(hitTestGhost([], [bottom, top], inside, view)).toBe(top);
  });

  it('returns null on empty space and for an empty ghost list', () => {
    expect(hitTestGhost([], [ghost()], { x: 200, y: 5 }, view)).toBeNull();
    expect(hitTestGhost([], [], inside, view)).toBeNull();
  });
});

describe('contentCenterPitch', () => {
  it('returns null for an empty list', () => {
    expect(contentCenterPitch([])).toBeNull();
  });

  it('returns the pitch of a single note', () => {
    expect(contentCenterPitch([{ pitch: 65 }])).toBe(65);
  });

  it('returns the rounded midpoint of the pitch extent', () => {
    expect(contentCenterPitch([{ pitch: 60 }, { pitch: 64 }, { pitch: 67 }])).toBe(64);
  });
});
