import { describe, expect, it, vi } from 'vitest';
import {
  createValueGesture,
  gainGesture,
  insertParamGesture,
  panGesture,
  type StripGestureCommands,
} from '@/ui/mixer/strip-gestures';

/** Builds a fully mocked command layer for gesture assertions. */
function mockCommands(): StripGestureCommands {
  return {
    setStripGain: vi.fn(),
    setStripPan: vi.fn(),
    setInsertParam: vi.fn(),
  };
}

describe('createValueGesture', () => {
  it('applies intermediate values with commit false and the final with commit true', () => {
    const apply = vi.fn();
    const gesture = createValueGesture(apply, 0);
    gesture.update(1);
    gesture.update(2);
    gesture.end(3);
    expect(apply.mock.calls).toEqual([
      [1, { commit: false }],
      [2, { commit: false }],
      [3, { commit: true }],
    ]);
  });

  it('ends with the last updated value when none is passed', () => {
    const apply = vi.fn();
    const gesture = createValueGesture(apply, 0);
    gesture.update(5);
    gesture.end();
    expect(apply).toHaveBeenLastCalledWith(5, { commit: true });
  });

  it('tracks activity across the gesture lifecycle', () => {
    const gesture = createValueGesture(vi.fn(), 0);
    expect(gesture.active).toBe(false);
    gesture.update(1);
    expect(gesture.active).toBe(true);
    gesture.end();
    expect(gesture.active).toBe(false);
  });

  it('cancel commits the initial value back', () => {
    const apply = vi.fn();
    const gesture = createValueGesture(apply, 42);
    gesture.update(50);
    gesture.cancel();
    expect(apply).toHaveBeenLastCalledWith(42, { commit: true });
    expect(gesture.active).toBe(false);
  });

  it('cancel is a no-op when the gesture never started', () => {
    const apply = vi.fn();
    const gesture = createValueGesture(apply, 42);
    gesture.cancel();
    expect(apply).not.toHaveBeenCalled();
  });

  it('end without any update commits the initial value (click-set)', () => {
    const apply = vi.fn();
    const gesture = createValueGesture(apply, 7);
    gesture.end();
    expect(apply).toHaveBeenCalledWith(7, { commit: true });
  });
});

describe('gainGesture', () => {
  it('routes a fader drag through setStripGain with coalescing flags', () => {
    const commands = mockCommands();
    const gesture = gainGesture('master', 0, commands);
    gesture.update(-3);
    gesture.update(-6);
    gesture.end(-6.5);
    expect(commands.setStripGain).toHaveBeenNthCalledWith(1, 'master', -3, { commit: false });
    expect(commands.setStripGain).toHaveBeenNthCalledWith(2, 'master', -6, { commit: false });
    expect(commands.setStripGain).toHaveBeenNthCalledWith(3, 'master', -6.5, { commit: true });
    expect(commands.setStripPan).not.toHaveBeenCalled();
  });

  it('targets a track id', () => {
    const commands = mockCommands();
    gainGesture(3, 0, commands).end(-12);
    expect(commands.setStripGain).toHaveBeenCalledWith(3, -12, { commit: true });
  });
});

describe('panGesture', () => {
  it('routes a knob drag through setStripPan and restores on cancel', () => {
    const commands = mockCommands();
    const gesture = panGesture(2, 0.25, commands);
    gesture.update(0.5);
    gesture.cancel();
    expect(commands.setStripPan).toHaveBeenNthCalledWith(1, 2, 0.5, { commit: false });
    expect(commands.setStripPan).toHaveBeenNthCalledWith(2, 2, 0.25, { commit: true });
  });
});

describe('insertParamGesture', () => {
  it('routes a parameter drag through setInsertParam with slot and name', () => {
    const commands = mockCommands();
    const gesture = insertParamGesture('master', 1, 'thresholdDb', -24, commands);
    gesture.update(-20);
    gesture.end(-18);
    expect(commands.setInsertParam).toHaveBeenNthCalledWith(1, 'master', 1, 'thresholdDb', -20, {
      commit: false,
    });
    expect(commands.setInsertParam).toHaveBeenNthCalledWith(2, 'master', 1, 'thresholdDb', -18, {
      commit: true,
    });
  });
});
