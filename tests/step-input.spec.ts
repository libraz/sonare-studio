import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStepInput } from '@/composables/useStepInput';
import { addNote, noteEndLimitPpq } from '@/project/commands';
import { useProjectStore } from '@/project/store';

// The step cursor writes through the project commands; mock them so the spec
// runs without the wasm-backed Project.
vi.mock('@/project/commands', () => ({
  addNote: vi.fn(() => 42),
  noteEndLimitPpq: vi.fn(() => Number.POSITIVE_INFINITY),
}));

const addNoteMock = vi.mocked(addNote);
const noteEndLimitMock = vi.mocked(noteEndLimitPpq);

describe('useStepInput', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    addNoteMock.mockClear();
    noteEndLimitMock.mockReset();
    noteEndLimitMock.mockReturnValue(Number.POSITIVE_INFINITY);
  });

  it('starts disarmed with the cursor at 0', () => {
    const step = useStepInput();
    expect(step.armed.value).toBe(false);
    expect(step.cursorPpq.value).toBe(0);
  });

  it('derives the step from the store snapDivision (divisions per whole note)', () => {
    const store = useProjectStore();
    const step = useStepInput();
    expect(step.stepPpq.value).toBe(0.25); // default sixteenth grid
    store.snapDivision = 4;
    expect(step.stepPpq.value).toBe(1); // beat grid
    store.snapDivision = 8;
    expect(step.stepPpq.value).toBe(0.5);
    store.snapDivision = 16 / 3;
    expect(step.stepPpq.value).toBeCloseTo(0.75, 12);
  });

  it('writes a note at the cursor and advances one step when armed', () => {
    const step = useStepInput();
    step.arm();
    const id = step.enterNote(60);
    expect(id).toBe(42);
    expect(addNoteMock).toHaveBeenCalledWith({ pitch: 60, startPpq: 0, durationPpq: 0.25 });
    expect(step.cursorPpq.value).toBe(0.25);
  });

  it('passes an explicit velocity through to the command', () => {
    const step = useStepInput();
    step.arm();
    step.enterNote(61, 80);
    expect(addNoteMock).toHaveBeenCalledWith({
      pitch: 61,
      startPpq: 0,
      durationPpq: 0.25,
      velocity: 80,
    });
  });

  it('writes consecutive notes at consecutive steps', () => {
    const step = useStepInput();
    step.arm();
    step.enterNote(60);
    step.enterNote(62);
    expect(addNoteMock).toHaveBeenNthCalledWith(2, {
      pitch: 62,
      startPpq: 0.25,
      durationPpq: 0.25,
    });
    expect(step.cursorPpq.value).toBe(0.5);
  });

  it('keeps step-entered notes on an imported percussion channel', () => {
    const store = useProjectStore();
    store.tracks = [
      {
        id: 7,
        name: 'Imported Kit',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 0,
      },
    ];
    store.activeTrackId = 7;
    store.notes = [{ id: 1, pitch: 36, velocity: 96, startPpq: 0, durationPpq: 0.25, channel: 9 }];
    const step = useStepInput();
    step.arm();

    step.enterNote(38);

    expect(addNoteMock).toHaveBeenCalledWith({
      pitch: 38,
      startPpq: 0,
      durationPpq: 0.25,
      channel: 9,
    });
  });

  it('uses sibling clip notes when the active percussion clip is empty', () => {
    const store = useProjectStore();
    store.tracks = [
      {
        id: 7,
        name: 'Imported Part',
        color: '#fff',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 0,
      },
    ];
    store.activeTrackId = 7;
    store.clips = [
      {
        id: 1,
        trackId: 7,
        name: 'Source',
        startPpq: 0,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [{ id: 1, pitch: 36, velocity: 96, startPpq: 0, durationPpq: 0.25, channel: 9 }],
      },
      {
        id: 2,
        trackId: 7,
        name: 'New take',
        startPpq: 4,
        lengthPpq: 4,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
      },
    ];
    store.clipId = 2;
    store.notes = [];
    const step = useStepInput();
    step.arm();

    step.enterNote(38);

    expect(addNoteMock).toHaveBeenCalledWith({
      pitch: 38,
      startPpq: 0,
      durationPpq: 0.25,
      channel: 9,
    });
  });

  it('converts the timeline cursor to the active clip source window', () => {
    const store = useProjectStore();
    store.clips = [
      {
        id: 7,
        trackId: 3,
        name: 'Trimmed',
        startPpq: 8,
        lengthPpq: 2,
        sourceOffsetPpq: 4,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
      },
    ];
    store.clipId = 7;
    const step = useStepInput();
    step.arm(8.5);

    step.enterNote(60);

    expect(addNoteMock).toHaveBeenCalledWith({
      pitch: 60,
      startPpq: 4.5,
      durationPpq: 0.25,
    });
    expect(step.cursorPpq.value).toBe(8.75);
  });

  it('clamps step notes to the clip start and grows past the clip end', () => {
    const store = useProjectStore();
    store.snapDivision = 4;
    store.clips = [
      {
        id: 7,
        trackId: 3,
        name: 'Trimmed',
        startPpq: 8,
        lengthPpq: 2,
        sourceOffsetPpq: 4,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        notes: [],
      },
    ];
    store.clipId = 7;
    const step = useStepInput();

    step.arm(2);
    step.enterNote(60);
    expect(addNoteMock).toHaveBeenLastCalledWith({
      pitch: 60,
      startPpq: 4,
      durationPpq: 1,
    });
    expect(step.cursorPpq.value).toBe(9);

    step.setCursor(10);
    step.enterNote(62);
    step.enterNote(64);
    expect(addNoteMock).toHaveBeenNthCalledWith(2, { pitch: 62, startPpq: 6, durationPpq: 1 });
    expect(addNoteMock).toHaveBeenNthCalledWith(3, { pitch: 64, startPpq: 7, durationPpq: 1 });
    expect(step.cursorPpq.value).toBe(12);
  });

  it('refuses a note that would pass the clip growth limit without moving the cursor', () => {
    const store = useProjectStore();
    store.snapDivision = 4;
    store.clips = [
      {
        id: 7,
        trackId: 3,
        name: 'Looped',
        startPpq: 0,
        lengthPpq: 8,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: true,
        loopLengthPpq: 2,
        notes: [],
      },
    ];
    store.clipId = 7;
    noteEndLimitMock.mockReturnValue(2);
    const step = useStepInput();

    step.arm(1);
    expect(step.enterNote(60)).toBe(42);
    expect(step.cursorPpq.value).toBe(2);
    addNoteMock.mockClear();

    expect(step.enterNote(62)).toBeNull();
    expect(addNoteMock).not.toHaveBeenCalled();
    expect(step.cursorPpq.value).toBe(2);
  });

  it('uses the active meter bar as the step while Bar snap is selected', () => {
    const store = useProjectStore();
    store.snapBar = true;
    store.timeSignatures = [{ startPpq: 0, numerator: 3, denominator: 4 }];
    const step = useStepInput();
    step.arm();

    step.enterNote(60);

    expect(addNoteMock).toHaveBeenCalledWith({ pitch: 60, startPpq: 0, durationPpq: 3 });
    expect(step.cursorPpq.value).toBe(3);
  });

  it('does not write and returns null while disarmed', () => {
    const step = useStepInput();
    expect(step.enterNote(60)).toBeNull();
    expect(addNoteMock).not.toHaveBeenCalled();
    expect(step.cursorPpq.value).toBe(0);
  });

  it('arm() accepts a start position and clamps it to >= 0', () => {
    const step = useStepInput();
    step.arm(8);
    expect(step.armed.value).toBe(true);
    expect(step.cursorPpq.value).toBe(8);
    step.arm(-1);
    expect(step.cursorPpq.value).toBe(0);
  });

  it('arm() without a position keeps the current cursor', () => {
    const step = useStepInput();
    step.setCursor(3);
    step.arm();
    expect(step.cursorPpq.value).toBe(3);
  });

  it('rest() advances one step without writing', () => {
    const step = useStepInput();
    step.arm();
    step.rest();
    expect(step.cursorPpq.value).toBe(0.25);
    expect(addNoteMock).not.toHaveBeenCalled();
  });

  it('back() moves one step back and clamps at 0', () => {
    const step = useStepInput();
    step.setCursor(0.5);
    step.back();
    expect(step.cursorPpq.value).toBe(0.25);
    step.back();
    expect(step.cursorPpq.value).toBe(0);
    step.back();
    expect(step.cursorPpq.value).toBe(0);
  });

  it('uses the note length of the grid in effect at entry time', () => {
    const store = useProjectStore();
    const step = useStepInput();
    step.arm();
    step.enterNote(60);
    store.snapDivision = 4;
    step.enterNote(62);
    expect(addNoteMock).toHaveBeenNthCalledWith(2, {
      pitch: 62,
      startPpq: 0.25,
      durationPpq: 1,
    });
    expect(step.cursorPpq.value).toBe(1.25);
  });

  it('toggle() flips the armed state and disarm() keeps the cursor', () => {
    const step = useStepInput();
    step.toggle();
    expect(step.armed.value).toBe(true);
    step.setCursor(2);
    step.disarm();
    expect(step.armed.value).toBe(false);
    expect(step.cursorPpq.value).toBe(2);
  });
});
