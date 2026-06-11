import { describe, expect, it, vi } from 'vitest';
import {
  type ArrangeClip,
  type ClipInteractionCommands,
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';

/** Linear view: 10 px per PPQ, two 50 px lanes, no scroll or ruler offset. */
const view: ClipInteractionsView = {
  ppqToX: (ppq) => ppq * 10,
  xToPpq: (x) => x / 10,
  laneTop: (index) => index * 50,
  laneIndexAtY: (y) => Math.floor(y / 50),
  laneHeight: 50,
  laneCount: 2,
};

interface Setup {
  interactions: ReturnType<typeof useClipInteractions>;
  commands: { [K in keyof ClipInteractionCommands]: ReturnType<typeof vi.fn> };
  clips: ArrangeClip[];
}

function makeSetup(): Setup {
  // Clip 1: x [40, 120) on lane 0 (track 10).
  const clips: ArrangeClip[] = [{ id: 1, trackId: 10, startPpq: 4, lengthPpq: 8 }];
  const commands = {
    selectClip: vi.fn(),
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    duplicateClip: vi.fn(() => 99),
    createClip: vi.fn(() => 77),
  };
  const interactions = useClipInteractions({
    view,
    getClips: () => clips,
    getTrackIds: () => [10, 20],
    getGridPpq: () => 1,
    getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
    commands,
  });
  return { interactions, commands, clips };
}

describe('useClipInteractions selection', () => {
  it('selects a clip on pointerdown and commits nothing on a plain click', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    expect(commands.selectClip).toHaveBeenCalledWith(1);
    interactions.onPointerUp({ x: 80, y: 25 });
    expect(commands.moveClip).not.toHaveBeenCalled();
    expect(commands.trimClip).not.toHaveBeenCalled();
    expect(commands.duplicateClip).not.toHaveBeenCalled();
  });

  it('does nothing on pointerdown over empty space', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 200, y: 25 });
    interactions.onPointerUp({ x: 200, y: 25 });
    expect(commands.selectClip).not.toHaveBeenCalled();
  });
});

describe('useClipInteractions move', () => {
  it('moves a clip horizontally with grid snapping', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 104, y: 25 }); // +2.4 PPQ, snaps to 6
    expect(interactions.previewClip.value).toMatchObject({
      clipId: 1,
      trackId: 10,
      startPpq: 6,
      copy: false,
    });
    interactions.onPointerUp({ x: 104, y: 25 });
    expect(commands.moveClip).toHaveBeenCalledWith(1, 6, undefined);
    expect(interactions.previewClip.value).toBeNull();
  });

  it('bypasses snapping while meta is held', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 104, y: 25 }, { meta: true });
    interactions.onPointerUp({ x: 104, y: 25 }, { meta: true });
    expect(commands.moveClip).toHaveBeenCalledWith(1, 6.4, undefined);
  });

  it('moves a clip to another lane and passes the new track id', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 80, y: 75 });
    expect(interactions.previewClip.value?.trackId).toBe(20);
    interactions.onPointerUp({ x: 80, y: 75 });
    expect(commands.moveClip).toHaveBeenCalledWith(1, 4, 20);
  });

  it('clamps the target lane to the lane extent', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 80, y: 500 }); // far below the last lane
    interactions.onPointerUp({ x: 80, y: 500 });
    expect(commands.moveClip).toHaveBeenCalledWith(1, 4, 20);
  });

  it('clamps the move so the clip start stays non-negative', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerUp({ x: 0, y: 25 }); // not promoted: no threshold move
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 0, y: 25 }); // -8 PPQ from start 4
    interactions.onPointerUp({ x: 0, y: 25 });
    expect(commands.moveClip).toHaveBeenLastCalledWith(1, 0, undefined);
  });
});

describe('useClipInteractions duplicate', () => {
  it('alt-drag duplicates on the same track instead of moving', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 }, { alt: true });
    interactions.onPointerMove({ x: 160, y: 75 }, { alt: true });
    const preview = interactions.previewClip.value;
    expect(preview).toMatchObject({ clipId: 1, startPpq: 12, copy: true });
    // Duplicates stay on the source track even when the pointer changes lanes.
    expect(preview?.trackId).toBe(10);
    interactions.onPointerUp({ x: 160, y: 75 }, { alt: true });
    expect(commands.duplicateClip).toHaveBeenCalledWith(1, 12);
    expect(commands.moveClip).not.toHaveBeenCalled();
  });

  it('does not duplicate when the drag returns to the origin', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 }, { alt: true });
    interactions.onPointerMove({ x: 120, y: 25 }, { alt: true });
    interactions.onPointerUp({ x: 80, y: 25 }, { alt: true });
    expect(commands.duplicateClip).not.toHaveBeenCalled();
  });
});

describe('useClipInteractions trim', () => {
  it('trims the end edge with grid snapping', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 119, y: 25 }); // trim-end zone
    interactions.onPointerMove({ x: 139, y: 25 }); // end 12 -> 14
    expect(interactions.previewClip.value).toMatchObject({ startPpq: 4, lengthPpq: 10 });
    interactions.onPointerUp({ x: 139, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(1, 4, 10);
  });

  it('trims the start edge and keeps the clip end fixed', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 41, y: 25 }); // trim-start zone
    interactions.onPointerMove({ x: 21, y: 25 }); // start 4 -> 2
    interactions.onPointerUp({ x: 21, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(1, 2, 10);
  });

  it('clamps trims to the minimum clip length', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 41, y: 25 });
    interactions.onPointerMove({ x: 300, y: 25 }); // way past the clip end
    interactions.onPointerUp({ x: 300, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(1, 11.75, 0.25);
  });

  it('commits nothing when the trim lands on the original extent', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 119, y: 25 });
    interactions.onPointerMove({ x: 125, y: 25 }); // snaps back to end 12
    interactions.onPointerUp({ x: 121, y: 25 });
    expect(commands.trimClip).not.toHaveBeenCalled();
  });
});

describe('useClipInteractions double-click', () => {
  it('creates a one-bar clip on an empty lane and selects it', () => {
    const { interactions, commands } = makeSetup();
    interactions.onDoubleClick({ x: 95, y: 75 }); // PPQ 9.5 on lane 1
    expect(commands.createClip).toHaveBeenCalledWith(20, 8, 4);
    expect(commands.selectClip).toHaveBeenCalledWith(77);
  });

  it('ignores double-clicks on clips and outside the lanes', () => {
    const { interactions, commands } = makeSetup();
    interactions.onDoubleClick({ x: 80, y: 25 }); // on clip 1
    interactions.onDoubleClick({ x: 95, y: 120 }); // below the last lane
    expect(commands.createClip).not.toHaveBeenCalled();
  });
});

describe('useClipInteractions feedback and cancel', () => {
  it('reflects the hover zone in the cursor', () => {
    const { interactions } = makeSetup();
    interactions.onPointerMove({ x: 80, y: 25 });
    expect(interactions.cursor.value).toBe('pointer');
    interactions.onPointerMove({ x: 41, y: 25 });
    expect(interactions.cursor.value).toBe('ew-resize');
    interactions.onPointerMove({ x: 200, y: 25 });
    expect(interactions.cursor.value).toBe('default');
  });

  it('cancel aborts an in-flight drag without committing', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 104, y: 25 });
    expect(interactions.previewClip.value).not.toBeNull();
    interactions.cancel();
    expect(interactions.previewClip.value).toBeNull();
    interactions.onPointerUp({ x: 104, y: 25 });
    expect(commands.moveClip).not.toHaveBeenCalled();
  });
});
