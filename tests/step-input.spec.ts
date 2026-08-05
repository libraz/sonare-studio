import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStepInput } from '@/composables/useStepInput';
import { addNote } from '@/project/commands';
import { useProjectStore } from '@/project/store';

// The step cursor writes through the project commands; mock them so the spec
// runs without the wasm-backed Project.
vi.mock('@/project/commands', () => ({
  addNote: vi.fn(() => 42),
}));

const addNoteMock = vi.mocked(addNote);

describe('useStepInput', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    addNoteMock.mockClear();
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

  it('clamps step notes to both ends of the active clip window', () => {
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

    step.setCursor(20);
    step.enterNote(62);
    expect(addNoteMock).toHaveBeenLastCalledWith({
      pitch: 62,
      startPpq: 5,
      durationPpq: 1,
    });
    expect(step.cursorPpq.value).toBe(10);
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
