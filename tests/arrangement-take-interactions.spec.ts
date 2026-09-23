import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipCompSegment } from '@/project/types';
import type { ClipPoint } from '@/ui/arrangement/clip-hit';
import {
  MIN_COMP_DRAG_PPQ,
  type TakeLaneClip,
  useTakeInteractions,
} from '@/ui/arrangement/use-take-interactions';

// Geometry: 2 px per PPQ; take sub-rows of track 1 cover y in [100, 180)
// (two rows of 40 px each).
const PX_PER_PPQ = 2;
const ROWS_TOP = 100;
const ROW_HEIGHT = 40;
const ROW_COUNT = 2;

function takeRowAt(point: ClipPoint): { trackId: number; takeIndex: number } | null {
  if (point.y < ROWS_TOP || point.y >= ROWS_TOP + ROW_COUNT * ROW_HEIGHT) return null;
  return { trackId: 1, takeIndex: Math.floor((point.y - ROWS_TOP) / ROW_HEIGHT) };
}

/** Point on take sub-row `takeIndex` at timeline position `ppq`. */
function at(ppq: number, takeIndex: number): ClipPoint {
  return { x: ppq * PX_PER_PPQ, y: ROWS_TOP + takeIndex * ROW_HEIGHT + ROW_HEIGHT / 2 };
}

describe('useTakeInteractions', () => {
  let clips: TakeLaneClip[];
  let activeTakeCalls: Array<{ clipId: number; takeIndex: number }>;
  let activeMidiTakeCalls: Array<{ clipId: number; takeIndex: number }>;
  let segmentCalls: Array<{ clipId: number; segments: ClipCompSegment[] }>;

  function create(snapEdge?: (clipId: number, ppq: number) => number) {
    return useTakeInteractions({
      snapEdge,
      view: {
        ppqToX: (ppq) => ppq * PX_PER_PPQ,
        xToPpq: (x) => x / PX_PER_PPQ,
        takeRowAt,
      },
      getClips: () => clips,
      commands: {
        setActiveTake: (clipId, takeIndex) => activeTakeCalls.push({ clipId, takeIndex }),
        setCompSegments: (clipId, segments) => segmentCalls.push({ clipId, segments }),
        setActiveMidiTake: (clipId, takeIndex) => activeMidiTakeCalls.push({ clipId, takeIndex }),
      },
    });
  }

  beforeEach(() => {
    clips = [
      {
        id: 7,
        trackId: 1,
        startPpq: 8,
        lengthPpq: 16,
        sourceOffsetPpq: 0,
        takes: [
          { assetId: 'a', name: 'Take 1' },
          { assetId: 'b', name: 'Take 2' },
        ],
      },
      {
        id: 9,
        trackId: 1,
        startPpq: 40,
        lengthPpq: 8,
        sourceOffsetPpq: 0,
        takes: [{ assetId: 'c', name: 'Take 1' }],
      },
    ];
    activeTakeCalls = [];
    activeMidiTakeCalls = [];
    segmentCalls = [];
  });

  it('ignores presses outside the take sub-rows', () => {
    const takes = create();
    expect(takes.onPointerDown({ x: 24, y: 50 })).toBe(false);
    expect(takes.onPointerUp({ x: 24, y: 50 })).toBe(false);
    expect(activeTakeCalls).toEqual([]);
    expect(segmentCalls).toEqual([]);
  });

  it('selects the pressed take for the whole clip on a plain click', () => {
    const takes = create();
    expect(takes.onPointerDown(at(12, 1))).toBe(true);
    expect(takes.onPointerUp(at(12, 1))).toBe(true);
    expect(activeTakeCalls).toEqual([{ clipId: 7, takeIndex: 1 }]);
    expect(segmentCalls).toEqual([]);
  });

  it('selects a whole MIDI cycle take on a plain click', () => {
    clips[0] = {
      id: 7,
      trackId: 1,
      startPpq: 8,
      lengthPpq: 16,
      sourceOffsetPpq: 0,
      midiTakes: [{}, {}],
    };
    const takes = create();
    takes.onPointerDown(at(12, 1));
    takes.onPointerUp(at(12, 1));
    expect(activeMidiTakeCalls).toEqual([{ clipId: 7, takeIndex: 1 }]);
    expect(segmentCalls).toEqual([]);
  });

  it('treats a drag below the 1/32-note threshold as a click', () => {
    const takes = create();
    takes.onPointerDown(at(12, 1));
    takes.onPointerMove(at(12 + MIN_COMP_DRAG_PPQ / 2, 1));
    takes.onPointerUp(at(12 + MIN_COMP_DRAG_PPQ / 2, 1));
    expect(activeTakeCalls).toEqual([{ clipId: 7, takeIndex: 1 }]);
    expect(segmentCalls).toEqual([]);
  });

  it('comps the dragged clip-relative range onto the pressed take', () => {
    const takes = create();
    takes.onPointerDown(at(12, 1));
    takes.onPointerMove(at(16, 1));
    takes.onPointerUp(at(16, 1));
    expect(activeTakeCalls).toEqual([]);
    expect(segmentCalls).toEqual([
      {
        clipId: 7,
        segments: [
          { startPpq: 0, takeIndex: 0 },
          { startPpq: 4, takeIndex: 1 },
          { startPpq: 8, takeIndex: 0 },
        ],
      },
    ]);
  });

  it('snaps both comp edges through the injected edge snap', () => {
    // A shared silence at clip-relative [3, 5) pulls an edge inside it to 4.
    const takes = create((_clipId, ppq) => (ppq >= 3 && ppq < 5 ? 4 : ppq));
    takes.onPointerDown(at(8 + 3.2, 1));
    takes.onPointerMove(at(8 + 10, 1));
    expect(takes.preview.value).toMatchObject({ startPpq: 4, endPpq: 10 });
    takes.onPointerUp(at(8 + 10, 1));
    expect(segmentCalls[0].segments).toEqual([
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 4, takeIndex: 1 },
      { startPpq: 10, takeIndex: 0 },
    ]);
  });

  it('normalizes a right-to-left drag and clamps it to the clip window', () => {
    const takes = create();
    // Press inside the clip (ppq 22 = clip-relative 14) and release left of
    // the clip start: the range clamps to [0, 14) on the pressed take.
    takes.onPointerDown(at(22, 1));
    takes.onPointerUp(at(4, 1));
    expect(segmentCalls).toEqual([
      {
        clipId: 7,
        segments: [
          { startPpq: 0, takeIndex: 1 },
          { startPpq: 14, takeIndex: 0 },
        ],
      },
    ]);
  });

  it('keeps the existing comp selection outside the dragged range', () => {
    clips[0].compSegments = [
      { startPpq: 0, takeIndex: 1 },
      { startPpq: 10, takeIndex: 0 },
    ];
    const takes = create();
    takes.onPointerDown(at(10, 0));
    takes.onPointerUp(at(14, 0));
    // Take 0 punches in over clip-relative [2, 6); the previous selection
    // (take 1 until 10, then take 0) resumes outside the dragged range.
    expect(segmentCalls).toEqual([
      {
        clipId: 7,
        segments: [
          { startPpq: 0, takeIndex: 1 },
          { startPpq: 2, takeIndex: 0 },
          { startPpq: 6, takeIndex: 1 },
          { startPpq: 10, takeIndex: 0 },
        ],
      },
    ]);
  });

  it('consumes presses inside the rows but outside every clip span', () => {
    const takes = create();
    expect(takes.onPointerDown(at(30, 0))).toBe(true);
    expect(takes.onPointerUp(at(30, 0))).toBe(true);
    expect(activeTakeCalls).toEqual([]);
    expect(segmentCalls).toEqual([]);
  });

  it('ignores take sub-rows beyond a clip take count', () => {
    const takes = create();
    expect(takes.onPointerDown(at(42, 1))).toBe(true);
    takes.onPointerUp(at(42, 1));
    expect(activeTakeCalls).toEqual([]);
    expect(segmentCalls).toEqual([]);
  });

  it('publishes a clip-relative drag preview and clears it on pointerup', () => {
    const takes = create();
    takes.onPointerDown(at(12, 0));
    takes.onPointerMove(at(18, 0));
    expect(takes.preview.value).toEqual({ clipId: 7, takeIndex: 0, startPpq: 4, endPpq: 10 });
    takes.onPointerUp(at(18, 0));
    expect(takes.preview.value).toBeNull();
  });

  it('shows a crosshair over clip spans and resets the cursor elsewhere', () => {
    const takes = create();
    expect(takes.onPointerMove(at(12, 0))).toBe(true);
    expect(takes.cursor.value).toBe('crosshair');
    expect(takes.onPointerMove(at(30, 0))).toBe(true);
    expect(takes.cursor.value).toBe('default');
    expect(takes.onPointerMove({ x: 24, y: 50 })).toBe(false);
    expect(takes.cursor.value).toBeNull();
  });

  it('cancel aborts an in-flight drag without committing', () => {
    const takes = create();
    takes.onPointerDown(at(12, 1));
    takes.onPointerMove(at(16, 1));
    takes.cancel();
    expect(takes.preview.value).toBeNull();
    expect(takes.onPointerUp(at(16, 1))).toBe(false);
    expect(activeTakeCalls).toEqual([]);
    expect(segmentCalls).toEqual([]);
  });
});
