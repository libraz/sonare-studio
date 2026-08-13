import { describe, expect, it, vi } from 'vitest';
import {
  type ArrangeClip,
  type ClipInteractionCommands,
  type ClipInteractionsView,
  useClipInteractions,
} from '@/ui/arrangement/use-clip-interactions';
import type { EditorToolId } from '@/ui/editor/tools';

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
  commands: { [K in keyof ClipInteractionCommands]-?: ReturnType<typeof vi.fn> };
  clips: ArrangeClip[];
  onSplitBlocked: ReturnType<typeof vi.fn>;
  setTool: (tool: EditorToolId) => void;
}

function makeSetup(
  options: { readOnly?: boolean; loopEnabled?: boolean; snapPpq?: (ppq: number) => number } = {},
): Setup {
  // Clip 1: x [40, 120) on lane 0 (track 10).
  const clips: ArrangeClip[] = [
    {
      id: 1,
      trackId: 10,
      startPpq: 4,
      lengthPpq: 8,
      loopEnabled: options.loopEnabled,
    },
  ];
  let tool: EditorToolId = 'select';
  const onSplitBlocked = vi.fn();
  const commands = {
    selectClip: vi.fn(),
    clearClipSelection: vi.fn(),
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    duplicateClip: vi.fn(() => 99),
    createClip: vi.fn(() => 77),
    setClipFades: vi.fn(),
    deleteClip: vi.fn(),
    splitClip: vi.fn(() => 88),
  };
  const interactions = useClipInteractions({
    view,
    getClips: () => clips,
    getTrackIds: () => [10, 20],
    canEditClip: () => options.readOnly !== true,
    canEditTrack: () => options.readOnly !== true,
    getGridPpq: () => 1,
    ...(options.snapPpq ? { snapPpq: options.snapPpq } : {}),
    getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
    getTool: () => tool,
    onSplitBlocked,
    commands,
  });
  return {
    interactions,
    commands,
    clips,
    onSplitBlocked,
    setTool: (next: EditorToolId) => {
      tool = next;
    },
  };
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

  it('clears clip selection on pointerdown over an empty lane', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 200, y: 25 });
    interactions.onPointerUp({ x: 200, y: 25 });
    expect(commands.selectClip).not.toHaveBeenCalled();
    expect(commands.clearClipSelection).toHaveBeenCalledWith(10);
  });

  it('selects read-only clips without committing edit-tool gestures', () => {
    const { interactions, commands, setTool } = makeSetup({ readOnly: true });
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 160, y: 25 });
    interactions.onPointerUp({ x: 160, y: 25 });
    expect(commands.selectClip).toHaveBeenCalledWith(1);
    expect(commands.moveClip).not.toHaveBeenCalled();

    setTool('erase');
    interactions.onPointerDown({ x: 80, y: 25 });
    expect(commands.deleteClip).not.toHaveBeenCalled();
    interactions.onDoubleClick({ x: 200, y: 25 });
    expect(commands.createClip).not.toHaveBeenCalled();
  });
});

interface MultiSelectionSetup {
  interactions: ReturnType<typeof useClipInteractions>;
  commands: {
    selectClips: ReturnType<typeof vi.fn>;
    clearClipSelection: ReturnType<typeof vi.fn>;
    moveClips: ReturnType<typeof vi.fn>;
  };
  selected: () => ReadonlySet<number>;
}

/** Three clips across two lanes for marquee and grouped-move coverage. */
function makeMultiSelectionSetup(initialSelection: number[] = []): MultiSelectionSetup {
  const clips: ArrangeClip[] = [
    { id: 1, trackId: 10, startPpq: 4, lengthPpq: 4 },
    { id: 2, trackId: 10, startPpq: 10, lengthPpq: 4 },
    { id: 3, trackId: 20, startPpq: 5, lengthPpq: 4 },
  ];
  let selection = new Set(initialSelection);
  const commands = {
    selectClips: vi.fn((ids: readonly number[]) => {
      selection = new Set(ids);
    }),
    clearClipSelection: vi.fn(() => {
      selection = new Set();
    }),
    moveClips: vi.fn(),
  };
  const interactions = useClipInteractions({
    view,
    getClips: () => clips,
    getSelectedClipIds: () => selection,
    getTrackIds: () => [10, 20],
    getGridPpq: () => 1,
    getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
    commands: {
      selectClip: vi.fn(),
      ...commands,
      moveClip: vi.fn(),
      trimClip: vi.fn(),
      duplicateClip: vi.fn(() => 99),
      createClip: vi.fn(() => null),
    },
  });
  return { interactions, commands, selected: () => selection };
}

describe('useClipInteractions multi-selection', () => {
  it('marquee-selects every clip intersecting an empty-area drag', () => {
    const { interactions, commands, selected } = makeMultiSelectionSetup();
    interactions.onPointerDown({ x: 10, y: 5 });
    interactions.onPointerMove({ x: 145, y: 95 });
    expect(interactions.previewMarquee.value).toEqual({ left: 10, top: 5, width: 135, height: 90 });
    interactions.onPointerUp({ x: 145, y: 95 });

    expect(commands.selectClips).toHaveBeenLastCalledWith([1, 2, 3], 3);
    expect([...selected()]).toEqual([1, 2, 3]);
    expect(interactions.previewMarquee.value).toBeNull();
  });

  it('extends the existing selection when Shift-marqueeing', () => {
    const { interactions, commands, selected } = makeMultiSelectionSetup([1]);
    interactions.onPointerDown({ x: 90, y: 5 }, { shift: true });
    interactions.onPointerMove({ x: 145, y: 45 }, { shift: true });
    interactions.onPointerUp({ x: 145, y: 45 }, { shift: true });

    expect(commands.selectClips).toHaveBeenLastCalledWith([1, 2], 2);
    expect([...selected()]).toEqual([1, 2]);
  });

  it('keeps a selected group together when dragging one of its clips', () => {
    const { interactions, commands } = makeMultiSelectionSetup([1, 2]);
    interactions.onPointerDown({ x: 110, y: 25 }); // clip 2
    interactions.onPointerMove({ x: 130, y: 75 }); // +2 PPQ, one lane down
    expect(interactions.previewClips.value).toEqual([
      { clipId: 1, trackId: 20, startPpq: 6, lengthPpq: 4, copy: false },
      { clipId: 2, trackId: 20, startPpq: 12, lengthPpq: 4, copy: false },
    ]);
    interactions.onPointerUp({ x: 130, y: 75 });

    expect(commands.moveClips).toHaveBeenCalledWith([
      { clipId: 1, newStartPpq: 6, newTrackId: 20 },
      { clipId: 2, newStartPpq: 12, newTrackId: 20 },
    ]);
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

  it('keeps the clip under the pointer when the arrangement scrolls mid-drag', () => {
    let viewportStartPpq = 0;
    const scrollingView: ClipInteractionsView = {
      ...view,
      ppqToX: (ppq) => (ppq - viewportStartPpq) * 10,
      xToPpq: (x) => viewportStartPpq + x / 10,
    };
    const commands = {
      selectClip: vi.fn(),
      moveClip: vi.fn(),
      trimClip: vi.fn(),
      duplicateClip: vi.fn(() => 99),
      createClip: vi.fn(() => null),
    };
    const interactions = useClipInteractions({
      view: scrollingView,
      getClips: () => [{ id: 1, trackId: 10, startPpq: 4, lengthPpq: 8 }],
      getTrackIds: () => [10, 20],
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: ppq, lengthPpq: 4 }),
      commands,
    });

    interactions.onPointerDown({ x: 80, y: 25 }); // PPQ 8, grab offset 4 from the clip start.
    viewportStartPpq = 10;
    interactions.onPointerMove({ x: 84, y: 25 }, { meta: true }); // now PPQ 18.4
    expect(interactions.previewClip.value?.startPpq).toBeCloseTo(14.4, 9);
    interactions.onPointerUp({ x: 84, y: 25 }, { meta: true });

    expect(commands.moveClip).toHaveBeenCalledWith(1, expect.closeTo(14.4, 9), undefined);
  });

  it('uses the supplied meter-aware snap position for a move', () => {
    const { interactions, commands } = makeSetup({ snapPpq: () => 6.5 });
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 104, y: 25 });
    interactions.onPointerUp({ x: 104, y: 25 });

    expect(commands.moveClip).toHaveBeenCalledWith(1, 6.5, undefined);
  });

  it('moves a clip to another lane and passes the new track id', () => {
    const { interactions, commands } = makeSetup();
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 80, y: 75 });
    expect(interactions.previewClip.value?.trackId).toBe(20);
    interactions.onPointerUp({ x: 80, y: 75 });
    expect(commands.moveClip).toHaveBeenCalledWith(1, 4, 20);
  });

  it('keeps an off-grid clip position during a vertical-only drag', () => {
    const { clips, interactions, commands } = makeSetup();
    clips[0].startPpq = 4.4;

    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 80, y: 75 });
    interactions.onPointerUp({ x: 80, y: 75 });

    expect(commands.moveClip).toHaveBeenCalledWith(1, 4.4, 20);
  });

  it('does not commit when the source freezes during a drag', () => {
    const state = { readOnly: false };
    const { interactions, commands } = makeSetup(state);
    interactions.onPointerDown({ x: 80, y: 25 });
    interactions.onPointerMove({ x: 104, y: 25 });
    state.readOnly = true;
    interactions.onPointerUp({ x: 104, y: 25 });

    expect(commands.moveClip).not.toHaveBeenCalled();
    expect(interactions.previewClip.value).toBeNull();
  });

  it('does not enter a destination lane that freezes during a drag', () => {
    const { commands } = makeSetup();
    let destinationFrozen = false;
    const guarded = useClipInteractions({
      view,
      getClips: () => [{ id: 1, trackId: 10, startPpq: 4, lengthPpq: 8 }],
      getTrackIds: () => [10, 20],
      canMoveClipToTrack: (_clipId, trackId) => trackId !== 20 || !destinationFrozen,
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: ppq, lengthPpq: 4 }),
      commands,
    });
    guarded.onPointerDown({ x: 80, y: 25 });
    guarded.onPointerMove({ x: 80, y: 75 });
    expect(guarded.previewClip.value?.trackId).toBe(20);
    destinationFrozen = true;
    guarded.onPointerUp({ x: 80, y: 75 });

    expect(commands.moveClip).not.toHaveBeenCalled();
  });

  it('keeps the clip on its source lane when the destination is incompatible', () => {
    const { interactions, commands } = makeSetup();
    const canMoveClipToTrack = vi.fn((_clipId: number, trackId: number) => trackId !== 20);
    const guarded = useClipInteractions({
      view,
      getClips: () => [{ id: 1, trackId: 10, startPpq: 4, lengthPpq: 8 }],
      getTrackIds: () => [10, 20],
      canMoveClipToTrack,
      getGridPpq: () => 1,
      getBarRange: (ppq) => ({ startPpq: ppq, lengthPpq: 4 }),
      commands,
    });

    guarded.onPointerDown({ x: 80, y: 25 });
    guarded.onPointerMove({ x: 100, y: 75 });
    expect(guarded.previewClip.value).toMatchObject({ trackId: 10, startPpq: 6 });
    guarded.onPointerUp({ x: 100, y: 75 });

    expect(canMoveClipToTrack).toHaveBeenCalledWith(1, 20);
    expect(commands.moveClip).toHaveBeenCalledWith(1, 6, undefined);
    expect(interactions.previewClip.value).toBeNull();
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
    expect(commands.selectClip).toHaveBeenLastCalledWith(99);
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

interface AudioSetup {
  interactions: ReturnType<typeof useClipInteractions>;
  commands: Setup['commands'] & { setClipFades: ReturnType<typeof vi.fn> };
  clips: ArrangeClip[];
}

/**
 * One audio clip (id 2) at x [40, 120) on lane 0 with a 1-PPQ fade-in: the
 * fade-in handle sits at x = 50, and the rendered fade-out handle at x = 119.
 */
function makeAudioSetup(
  bounds: { minStartPpq: number; maxEndPpq: number } | null,
  lengthPpq = 8,
): AudioSetup {
  const clips: ArrangeClip[] = [
    { id: 2, trackId: 10, startPpq: 4, lengthPpq, kind: 'audio', fadeInPpq: 1 },
  ];
  const commands = {
    selectClip: vi.fn(),
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    duplicateClip: vi.fn(() => 99),
    createClip: vi.fn(() => null),
    setClipFades: vi.fn(),
  };
  const interactions = useClipInteractions({
    view,
    getClips: () => clips,
    getTrackIds: () => [10, 20],
    getGridPpq: () => 1,
    getBarRange: (ppq) => ({ startPpq: Math.floor(ppq / 4) * 4, lengthPpq: 4 }),
    getSourceBounds: () => bounds,
    commands,
  });
  return { interactions, commands, clips };
}

describe('useClipInteractions audio trim bounds', () => {
  it('clamps an end trim to the asset end', () => {
    const { interactions, commands } = makeAudioSetup({ minStartPpq: 2, maxEndPpq: 14 });
    interactions.onPointerDown({ x: 119, y: 25 }); // trim-end zone
    interactions.onPointerMove({ x: 200, y: 25 }); // way past the asset end
    expect(interactions.previewClip.value).toMatchObject({ startPpq: 4, lengthPpq: 10 });
    interactions.onPointerUp({ x: 200, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(2, 4, 10);
  });

  it('clamps a start trim to source offset zero', () => {
    const { interactions, commands } = makeAudioSetup({ minStartPpq: 2, maxEndPpq: 14 });
    interactions.onPointerDown({ x: 41, y: 25 }); // trim-start zone
    interactions.onPointerMove({ x: 0, y: 25 });
    interactions.onPointerUp({ x: 0, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(2, 2, 10);
  });

  it('keeps a minimum-length trim inside a narrower source window', () => {
    const { interactions, commands } = makeAudioSetup({ minStartPpq: 4, maxEndPpq: 4.1 });
    interactions.onPointerDown({ x: 119, y: 25 }); // trim-end zone
    interactions.onPointerMove({ x: 0, y: 25 }); // minimum length would pass the source end
    interactions.onPointerUp({ x: 0, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(2, 4, expect.closeTo(0.1, 9));
  });

  it('trims freely when no bounds are provided', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerDown({ x: 119, y: 25 });
    interactions.onPointerMove({ x: 200, y: 25 });
    interactions.onPointerUp({ x: 200, y: 25 });
    expect(commands.trimClip).toHaveBeenCalledWith(2, 4, 16);
  });
});

describe('useClipInteractions fade handles', () => {
  it('selects the clip and shows a resize cursor on a fade handle', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerMove({ x: 50, y: 3 });
    expect(interactions.cursor.value).toBe('ew-resize');
    interactions.onPointerDown({ x: 50, y: 3 });
    expect(commands.selectClip).toHaveBeenCalledWith(2);
  });

  it('drags the fade-in handle with boundary snapping and one commit', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerDown({ x: 50, y: 3 });
    interactions.onPointerMove({ x: 70, y: 3 }); // boundary 5 -> 7 PPQ
    expect(interactions.previewFades.value).toEqual({ clipId: 2, fadeInPpq: 3, fadeOutPpq: 0 });
    interactions.onPointerUp({ x: 70, y: 3 });
    expect(commands.setClipFades).toHaveBeenCalledTimes(1);
    expect(commands.setClipFades).toHaveBeenCalledWith(2, 3, 0);
    expect(interactions.previewFades.value).toBeNull();
  });

  it('clamps the fade-in to the clip length', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerDown({ x: 50, y: 3 });
    interactions.onPointerMove({ x: 300, y: 3 });
    interactions.onPointerUp({ x: 300, y: 3 });
    expect(commands.setClipFades).toHaveBeenCalledWith(2, 8, 0);
  });

  it('drags the fade-out handle from the clip end', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerDown({ x: 118, y: 3 }); // rendered fade-out handle is at x = 119
    interactions.onPointerMove({ x: 99, y: 3 }); // boundary 12 -> 10 PPQ
    expect(interactions.previewFades.value).toEqual({ clipId: 2, fadeInPpq: 1, fadeOutPpq: 2 });
    interactions.onPointerUp({ x: 99, y: 3 });
    expect(commands.setClipFades).toHaveBeenCalledWith(2, 1, 2);
  });

  it('commits nothing when the fades come back unchanged', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerDown({ x: 50, y: 3 });
    interactions.onPointerUp({ x: 50, y: 3 });
    expect(commands.setClipFades).not.toHaveBeenCalled();
  });

  it('leaves clicks below the handle band to the body/trim gestures', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onPointerDown({ x: 50, y: 25 });
    interactions.onPointerMove({ x: 70, y: 25 });
    interactions.onPointerUp({ x: 70, y: 25 });
    expect(commands.setClipFades).not.toHaveBeenCalled();
    expect(commands.moveClip).toHaveBeenCalledWith(2, 6, undefined);
  });

  it('does not start a fade on a narrow clip in the upper hit band', () => {
    const { interactions, commands } = makeAudioSetup(null, 0.8);
    interactions.onPointerDown({ x: 43.5, y: 3 });
    interactions.onPointerMove({ x: 63.5, y: 3 });
    interactions.onPointerUp({ x: 63.5, y: 3 });

    expect(commands.setClipFades).not.toHaveBeenCalled();
    expect(commands.selectClip).toHaveBeenCalledWith(2);
    expect(commands.moveClip).toHaveBeenCalledWith(2, 6, undefined);
  });

  it('leaves the narrow clip edge reachable for trim outside its rendered rect', () => {
    const { interactions, commands } = makeAudioSetup(null, 0.8);
    interactions.onPointerDown({ x: 47, y: 3 });
    interactions.onPointerMove({ x: 67, y: 3 });
    interactions.onPointerUp({ x: 67, y: 3 });

    expect(commands.setClipFades).not.toHaveBeenCalled();
    expect(commands.trimClip).toHaveBeenCalledWith(2, 4, 3);
  });

  it('leaves an empty-area drag reachable near a narrow clip handle', () => {
    const { interactions, commands } = makeAudioSetup(null, 0.8);
    interactions.onPointerDown({ x: 35, y: 3 });
    interactions.onPointerMove({ x: 25, y: 3 });

    expect(interactions.previewMarquee.value).toEqual({
      left: 25,
      top: 3,
      width: 10,
      height: 0,
    });
    expect(commands.setClipFades).not.toHaveBeenCalled();
    interactions.onPointerUp({ x: 25, y: 3 });
    expect(interactions.previewMarquee.value).toBeNull();
  });
});

describe('useClipInteractions create rejection', () => {
  it('does not select anything when createClip returns null', () => {
    const { interactions, commands } = makeAudioSetup(null);
    interactions.onDoubleClick({ x: 200, y: 25 }); // empty space on lane 0
    expect(commands.createClip).toHaveBeenCalledWith(10, 20, 4);
    expect(commands.selectClip).not.toHaveBeenCalled();
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

describe('useClipInteractions tools', () => {
  describe('erase tool', () => {
    it('deletes the clip under the pointer on pointerdown', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('erase');
      interactions.onPointerDown({ x: 80, y: 25 });
      expect(commands.deleteClip).toHaveBeenCalledWith(1);
    });

    it('deletes nothing over empty space', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('erase');
      interactions.onPointerDown({ x: 200, y: 25 });
      expect(commands.deleteClip).not.toHaveBeenCalled();
    });
  });

  describe('split tool', () => {
    it('splits the clip at the snapped pointer position and selects the right half', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('split');
      // x 84 = PPQ 8.4 snaps to 8, strictly inside clip [4, 12).
      interactions.onPointerDown({ x: 84, y: 25 });
      expect(commands.splitClip).toHaveBeenCalledWith(1, 8);
      expect(commands.selectClip).toHaveBeenCalledWith(88);
    });

    it('does not split at the clip boundary', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('split');
      interactions.onPointerDown({ x: 40, y: 25 }); // PPQ 4 = clip start
      expect(commands.splitClip).not.toHaveBeenCalled();
    });

    it('rejects loop clips with an explicit reason before calling the command', () => {
      const { interactions, commands, onSplitBlocked, setTool } = makeSetup({
        loopEnabled: true,
      });
      setTool('split');
      interactions.onPointerDown({ x: 84, y: 25 });
      expect(commands.splitClip).not.toHaveBeenCalled();
      expect(commands.selectClip).not.toHaveBeenCalledWith(88);
      expect(onSplitBlocked).toHaveBeenCalledWith(1, 'loop');
    });
  });

  describe('draw tool', () => {
    it('creates a one-bar clip from a click on an empty lane', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('draw');
      // Lane 1 (track 20), x 200 = PPQ 20 (bar-aligned), no drag.
      interactions.onPointerDown({ x: 200, y: 75 });
      interactions.onPointerUp({ x: 200, y: 75 });
      expect(commands.createClip).toHaveBeenCalledWith(20, 20, 4);
      expect(commands.selectClip).toHaveBeenCalledWith(77);
    });

    it('grows the drawn clip to the snapped drag length, kept at >= one bar', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('draw');
      interactions.onPointerDown({ x: 40, y: 75 }); // start PPQ 4
      interactions.onPointerMove({ x: 104, y: 75 }); // end raw 10.4 snaps to 10
      expect(interactions.previewDraft.value).toMatchObject({
        trackId: 20,
        startPpq: 4,
        lengthPpq: 6,
      });
      interactions.onPointerUp({ x: 104, y: 75 });
      expect(commands.createClip).toHaveBeenCalledWith(20, 4, 6);
      expect(interactions.previewDraft.value).toBeNull();
    });

    it('does nothing when drawing off the lane area', () => {
      const { interactions, commands, setTool } = makeSetup();
      setTool('draw');
      interactions.onPointerDown({ x: 200, y: 200 }); // below both lanes
      interactions.onPointerUp({ x: 200, y: 200 });
      expect(commands.createClip).not.toHaveBeenCalled();
    });
  });

  describe('hitClipAt', () => {
    it('returns the clip id under the point', () => {
      const { interactions } = makeSetup();
      // Clip 1 covers x [40, 120) on lane 0.
      expect(interactions.hitClipAt({ x: 80, y: 25 })).toBe(1);
    });

    it('returns null over empty space', () => {
      const { interactions } = makeSetup();
      expect(interactions.hitClipAt({ x: 200, y: 25 })).toBeNull();
    });
  });
});
