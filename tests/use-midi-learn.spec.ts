import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { ccToGainDb, ccToPan } from '@/ui/midi/midi-learn';

const setStripGain = vi.fn();
const setStripPan = vi.fn();

vi.mock('@/project/commands', () => ({
  setStripGain: (...args: unknown[]) => setStripGain(...args),
  setStripPan: (...args: unknown[]) => setStripPan(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  setStripGain.mockReset();
  setStripPan.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMidiLearn', () => {
  it('binds the next CC to the armed target and applies it audibly', () => {
    const learn = useMidiLearn();
    learn.arm('gain', 'master');
    expect(learn.isArmed('gain', 'master')).toBe(true);

    learn.handleCc({ channel: 0, controller: 7, value: 100 });

    // Bound and no longer armed.
    expect(learn.isArmed('gain', 'master')).toBe(false);
    expect(learn.bindingFor('gain', 'master')).toEqual({ channel: 0, controller: 7 });
    // Applied immediately as an uncommitted gesture.
    expect(setStripGain).toHaveBeenCalledWith('master', ccToGainDb(100), { commit: false });

    // The gesture commits once the CC stream goes idle.
    vi.advanceTimersByTime(250);
    expect(setStripGain).toHaveBeenLastCalledWith('master', ccToGainDb(100), { commit: true });
  });

  it('re-arming the same target cancels the arm', () => {
    const learn = useMidiLearn();
    learn.arm('pan', 5);
    learn.arm('pan', 5);
    expect(learn.armed.value).toBeNull();
  });

  it('drives a bound target on matching channel + controller only', () => {
    const learn = useMidiLearn();
    learn.arm('pan', 3);
    learn.handleCc({ channel: 2, controller: 10, value: 0 });
    setStripPan.mockClear();

    // Wrong controller — ignored.
    learn.handleCc({ channel: 2, controller: 11, value: 127 });
    // Wrong channel — ignored.
    learn.handleCc({ channel: 4, controller: 10, value: 127 });
    expect(setStripPan).not.toHaveBeenCalled();

    // Exact match drives the strip pan.
    learn.handleCc({ channel: 2, controller: 10, value: 127 });
    expect(setStripPan).toHaveBeenCalledWith(3, ccToPan(127), { commit: false });
  });

  it('clears one binding and all bindings', () => {
    const learn = useMidiLearn();
    learn.arm('gain', 'master');
    learn.handleCc({ channel: 0, controller: 7, value: 64 });
    learn.arm('gain', 1);
    learn.handleCc({ channel: 0, controller: 8, value: 64 });
    expect(learn.bindings.size).toBe(2);

    learn.clear('gain', 'master');
    expect(learn.bindingFor('gain', 'master')).toBeUndefined();
    expect(learn.bindings.size).toBe(1);

    learn.clearAll();
    expect(learn.bindings.size).toBe(0);
  });

  it('drops a stale binding whose target command throws', () => {
    setStripGain.mockImplementation(() => {
      throw new RangeError('unknown track');
    });
    const learn = useMidiLearn();
    learn.arm('gain', 999);
    learn.handleCc({ channel: 0, controller: 20, value: 90 });
    // The failed apply removed the binding instead of leaving it dangling.
    expect(learn.bindingFor('gain', 999)).toBeUndefined();
  });
});
