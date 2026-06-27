import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useProjectStore } from '@/project/store';
import {
  ccToGainDb,
  ccToPan,
  ccToRange,
  type MidiCcBinding,
  midiLearnInsertTargetId,
  midiLearnInstrumentTargetId,
} from '@/ui/midi/midi-learn';

const setStripGain = vi.fn();
const setStripPan = vi.fn();
const listQuickControls = vi.fn();
const setQuickControl = vi.fn();
// The binding commands persist into the store map (the composable's
// `bindings`); the mock mutates that same map so the assertions still observe
// real binding state without standing up the full command/history stack.
const setMidiCcBinding = vi.fn((id: string, binding: MidiCcBinding) => {
  useProjectStore().midiCcBindings.set(id, { ...binding });
});
const clearMidiCcBinding = vi.fn((id: string) => {
  const map = useProjectStore().midiCcBindings;
  const had = map.has(id);
  map.delete(id);
  return had;
});
const clearAllMidiCcBindings = vi.fn(() => {
  useProjectStore().midiCcBindings.clear();
});

vi.mock('@/project/commands', () => ({
  setStripGain: (...args: unknown[]) => setStripGain(...args),
  setStripPan: (...args: unknown[]) => setStripPan(...args),
  setMidiCcBinding: (...args: [string, MidiCcBinding]) => setMidiCcBinding(...args),
  clearMidiCcBinding: (...args: [string]) => clearMidiCcBinding(...args),
  clearAllMidiCcBindings: () => clearAllMidiCcBindings(),
}));

vi.mock('@/project/quick-controls', () => ({
  listQuickControls: (...args: unknown[]) => listQuickControls(...args),
  setQuickControl: (...args: unknown[]) => setQuickControl(...args),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  setStripGain.mockReset();
  setStripPan.mockReset();
  listQuickControls.mockReset();
  setQuickControl.mockReset();
  setMidiCcBinding.mockClear();
  clearMidiCcBinding.mockClear();
  clearAllMidiCcBindings.mockClear();
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

  it('binds and drives an insert parameter across its quick-control range', () => {
    listQuickControls.mockReturnValue([
      { id: 'thresholdDb', name: 'Threshold', value: -24, min: -60, max: 0 },
    ]);
    const learn = useMidiLearn();
    const id = midiLearnInsertTargetId('master', 0, 'thresholdDb');
    learn.armId(id);
    expect(learn.isArmedId(id)).toBe(true);

    learn.handleCc({ channel: 0, controller: 30, value: 127 });

    expect(learn.isArmedId(id)).toBe(false);
    expect(learn.bindingForId(id)).toEqual({ channel: 0, controller: 30 });
    // CC 127 maps to the top of the parameter range (0 dB).
    expect(setQuickControl).toHaveBeenCalledWith(
      { type: 'insert', trackId: 'master', index: 0 },
      'thresholdDb',
      ccToRange(127, -60, 0),
      { commit: false },
    );

    vi.advanceTimersByTime(250);
    expect(setQuickControl).toHaveBeenLastCalledWith(
      { type: 'insert', trackId: 'master', index: 0 },
      'thresholdDb',
      ccToRange(127, -60, 0),
      { commit: true },
    );
  });

  it('drops an insert binding when the parameter is no longer present', () => {
    listQuickControls.mockReturnValue([]);
    const learn = useMidiLearn();
    const id = midiLearnInsertTargetId(5, 2, 'ratio');
    learn.armId(id);
    learn.handleCc({ channel: 1, controller: 40, value: 64 });
    expect(learn.bindingForId(id)).toBeUndefined();
    expect(setQuickControl).not.toHaveBeenCalled();
  });

  it('binds and drives an instrument parameter across its quick-control range', () => {
    listQuickControls.mockReturnValue([
      { id: 'cutoffHz', name: 'Cutoff', value: 8000, min: 20, max: 20000, unit: 'Hz' },
    ]);
    const learn = useMidiLearn();
    const id = midiLearnInstrumentTargetId(3, 'cutoffHz');
    learn.armId(id);
    learn.handleCc({ channel: 0, controller: 74, value: 0 });

    expect(learn.bindingForId(id)).toEqual({ channel: 0, controller: 74 });
    expect(setQuickControl).toHaveBeenCalledWith(
      { type: 'instrument', trackId: 3 },
      'cutoffHz',
      ccToRange(0, 20, 20000),
      { commit: false },
    );
  });
});
