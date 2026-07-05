import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMidiLearn } from '@/composables/useMidiLearn';
import { useProjectStore } from '@/project/store';
import {
  ccToGainDb,
  ccToLogRange,
  ccToPan,
  ccToRange,
  type MidiCcBinding,
  midiLearnEqTargetId,
  midiLearnInsertTargetId,
  midiLearnInstrumentTargetId,
  midiLearnMasteringTargetId,
  midiLearnSendTargetId,
  midiLearnStripControlTargetId,
  midiLearnTrackStateTargetId,
  midiLearnVcaTargetId,
} from '@/ui/midi/midi-learn';

const setStripGain = vi.fn();
const setStripPan = vi.fn();
const setStripEq = vi.fn();
const setMasteringParam = vi.fn();
const setStripInputTrim = vi.fn();
const setStripWidth = vi.fn();
const setStripChannelDelaySamples = vi.fn();
const setStripDualPan = vi.fn();
const setStripPolarityInvert = vi.fn();
const setStripPanLaw = vi.fn();
const setStripPanMode = vi.fn();
const setTrackMute = vi.fn();
const setTrackSolo = vi.fn();
const setVcaGroupGain = vi.fn();
const setVcaGroupMute = vi.fn();
const setVcaGroupSolo = vi.fn();
const setSend = vi.fn();
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
  setStripEq: (...args: unknown[]) => setStripEq(...args),
  setMasteringParam: (...args: unknown[]) => setMasteringParam(...args),
  setStripInputTrim: (...args: unknown[]) => setStripInputTrim(...args),
  setStripWidth: (...args: unknown[]) => setStripWidth(...args),
  setStripChannelDelaySamples: (...args: unknown[]) => setStripChannelDelaySamples(...args),
  setStripDualPan: (...args: unknown[]) => setStripDualPan(...args),
  setStripPolarityInvert: (...args: unknown[]) => setStripPolarityInvert(...args),
  setStripPanLaw: (...args: unknown[]) => setStripPanLaw(...args),
  setStripPanMode: (...args: unknown[]) => setStripPanMode(...args),
  setTrackMute: (...args: unknown[]) => setTrackMute(...args),
  setTrackSolo: (...args: unknown[]) => setTrackSolo(...args),
  setVcaGroupGain: (...args: unknown[]) => setVcaGroupGain(...args),
  setVcaGroupMute: (...args: unknown[]) => setVcaGroupMute(...args),
  setVcaGroupSolo: (...args: unknown[]) => setVcaGroupSolo(...args),
  setSend: (...args: unknown[]) => setSend(...args),
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
  setStripEq.mockReset();
  setMasteringParam.mockReset();
  setStripInputTrim.mockReset();
  setStripWidth.mockReset();
  setStripChannelDelaySamples.mockReset();
  setStripDualPan.mockReset();
  setStripPolarityInvert.mockReset();
  setStripPanLaw.mockReset();
  setStripPanMode.mockReset();
  setTrackMute.mockReset();
  setTrackSolo.mockReset();
  setVcaGroupGain.mockReset();
  setVcaGroupMute.mockReset();
  setVcaGroupSolo.mockReset();
  setSend.mockReset();
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

  it('clears delayed commit timers when its owning scope is disposed', () => {
    const scope = effectScope();
    const learn = scope.run(() => useMidiLearn());
    if (!learn) throw new Error('effect scope did not run');
    learn.arm('gain', 'master');
    learn.handleCc({ channel: 0, controller: 7, value: 100 });
    expect(setStripGain).toHaveBeenCalledTimes(1);
    expect(setStripGain).toHaveBeenLastCalledWith('master', ccToGainDb(100), { commit: false });

    scope.stop();
    vi.advanceTimersByTime(250);

    expect(setStripGain).toHaveBeenCalledTimes(1);
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

  it('drives an existing MSB binding with a high-resolution 14-bit value', () => {
    const learn = useMidiLearn();
    learn.arm('gain', 'master');
    learn.handleCc({ channel: 0, controller: 1, value: 64 });
    setStripGain.mockClear();

    learn.handleCc({ channel: 0, controller: 1, value: 64, value14: 16383 });

    expect(learn.bindingFor('gain', 'master')).toEqual({ channel: 0, controller: 1 });
    expect(setStripGain).toHaveBeenCalledWith('master', ccToGainDb(127), { commit: false });
  });

  it('learns and drives RPN/NRPN bindings by parameter number', () => {
    const learn = useMidiLearn();
    learn.arm('gain', 'master');
    learn.handleCc({
      channel: 0,
      controller: 6,
      value: 64,
      value14: 8192,
      kind: 'rpn',
      parameter: 2,
    });
    expect(learn.bindingFor('gain', 'master')).toEqual({
      channel: 0,
      controller: 6,
      kind: 'rpn',
      parameter: 2,
    });
    setStripGain.mockClear();

    learn.handleCc({
      channel: 0,
      controller: 6,
      value: 1,
      value14: 16383,
      kind: 'nrpn',
      parameter: 2,
    });
    learn.handleCc({
      channel: 0,
      controller: 6,
      value: 1,
      value14: 16383,
      kind: 'rpn',
      parameter: 3,
    });
    expect(setStripGain).not.toHaveBeenCalled();

    learn.handleCc({
      channel: 0,
      controller: 6,
      value: 1,
      value14: 16383,
      kind: 'rpn',
      parameter: 2,
    });
    expect(setStripGain).toHaveBeenCalledWith('master', ccToGainDb(127), { commit: false });
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

  it('binds and drives a mixer send level with coalesced commit', () => {
    const learn = useMidiLearn();
    const id = midiLearnSendTargetId(3, 'bus-1');
    learn.armId(id);
    expect(learn.isArmedId(id)).toBe(true);

    learn.handleCc({ channel: 0, controller: 22, value: 127 });

    expect(learn.isArmedId(id)).toBe(false);
    expect(learn.bindingForId(id)).toEqual({ channel: 0, controller: 22 });
    expect(setSend).toHaveBeenCalledWith(
      3,
      'bus-1',
      { levelDb: ccToGainDb(127), enabled: true },
      { commit: false },
    );

    vi.advanceTimersByTime(250);
    expect(setSend).toHaveBeenLastCalledWith(
      3,
      'bus-1',
      { levelDb: ccToGainDb(127), enabled: true },
      { commit: true },
    );
  });

  it('drops a stale mixer send binding whose bus no longer exists', () => {
    setSend.mockImplementation(() => {
      throw new RangeError('unknown bus');
    });
    const learn = useMidiLearn();
    const id = midiLearnSendTargetId(3, 'missing-bus');
    learn.armId(id);
    learn.handleCc({ channel: 0, controller: 23, value: 64 });

    expect(learn.bindingForId(id)).toBeUndefined();
  });

  it('binds and drives mixer send enabled and timing controls', () => {
    useProjectStore().tracks = [
      {
        id: 3,
        name: 'Lead',
        kind: 'midi',
        color: '#fff',
        solo: false,
        mute: false,
        mixer: {
          gainDb: 0,
          pan: 0,
          inserts: [],
          sends: [{ busId: 'bus-1', levelDb: -12, enabled: true }],
        },
      },
    ];
    const learn = useMidiLearn();
    const enabledId = midiLearnSendTargetId(3, 'bus-1', 'enabled');
    learn.armId(enabledId);
    learn.handleCc({ channel: 0, controller: 31, value: 0 });

    expect(learn.bindingForId(enabledId)).toEqual({ channel: 0, controller: 31 });
    expect(setSend).toHaveBeenCalledWith(3, 'bus-1', {
      levelDb: -12,
      enabled: false,
      timing: undefined,
    });

    const timingId = midiLearnSendTargetId(3, 'bus-1', 'timing');
    learn.armId(timingId);
    learn.handleCc({ channel: 0, controller: 32, value: 127 });

    expect(learn.bindingForId(timingId)).toEqual({ channel: 0, controller: 32 });
    expect(setSend).toHaveBeenLastCalledWith(3, 'bus-1', {
      levelDb: -12,
      enabled: true,
      timing: 'preFader',
    });
  });

  it('binds and drives track mute and solo states from CC thresholds', () => {
    const learn = useMidiLearn();
    const muteId = midiLearnTrackStateTargetId(7, 'mute');
    learn.armId(muteId);
    learn.handleCc({ channel: 0, controller: 33, value: 127 });
    expect(learn.bindingForId(muteId)).toEqual({ channel: 0, controller: 33 });
    expect(setTrackMute).toHaveBeenCalledWith(7, true);

    const soloId = midiLearnTrackStateTargetId(7, 'solo');
    learn.armId(soloId);
    learn.handleCc({ channel: 0, controller: 34, value: 0 });
    expect(learn.bindingForId(soloId)).toEqual({ channel: 0, controller: 34 });
    expect(setTrackSolo).toHaveBeenCalledWith(7, false);
  });

  it('binds and drives VCA gain, mute, and solo controls', () => {
    const learn = useMidiLearn();
    const gainId = midiLearnVcaTargetId('drums', 'gain');
    learn.armId(gainId);
    learn.handleCc({ channel: 0, controller: 35, value: 127 });
    expect(learn.bindingForId(gainId)).toEqual({ channel: 0, controller: 35 });
    expect(setVcaGroupGain).toHaveBeenCalledWith('drums', ccToGainDb(127), { commit: false });

    vi.advanceTimersByTime(250);
    expect(setVcaGroupGain).toHaveBeenLastCalledWith('drums', ccToGainDb(127), {
      commit: true,
    });

    const muteId = midiLearnVcaTargetId('drums', 'mute');
    learn.armId(muteId);
    learn.handleCc({ channel: 0, controller: 36, value: 0 });
    expect(learn.bindingForId(muteId)).toEqual({ channel: 0, controller: 36 });
    expect(setVcaGroupMute).toHaveBeenCalledWith('drums', false);

    const soloId = midiLearnVcaTargetId('drums', 'solo');
    learn.armId(soloId);
    learn.handleCc({ channel: 0, controller: 37, value: 127 });
    expect(learn.bindingForId(soloId)).toEqual({ channel: 0, controller: 37 });
    expect(setVcaGroupSolo).toHaveBeenCalledWith('drums', true);
  });

  it('binds and drives EQ band frequency, gain, and Q controls', () => {
    useProjectStore().tracks = [
      {
        id: 7,
        name: 'Lead',
        kind: 'midi',
        color: '#fff',
        solo: false,
        mute: false,
        mixer: {
          gainDb: 0,
          pan: 0,
          inserts: [],
          sends: [],
          eq: {
            enabled: true,
            bands: [{ type: 'Peak', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true }],
          },
        },
      },
    ];
    const learn = useMidiLearn();
    const frequencyId = midiLearnEqTargetId(7, 0, 'frequencyHz');
    learn.armId(frequencyId);
    learn.handleCc({ channel: 0, controller: 38, value: 127 });
    expect(learn.bindingForId(frequencyId)).toEqual({ channel: 0, controller: 38 });
    expect(setStripEq).toHaveBeenCalledWith(
      7,
      {
        enabled: true,
        bands: [
          {
            type: 'Peak',
            frequencyHz: ccToLogRange(127, 20, 20000),
            gainDb: 0,
            q: 1,
            enabled: true,
          },
        ],
      },
      { commit: false },
    );

    vi.advanceTimersByTime(250);
    expect(setStripEq).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        bands: [expect.objectContaining({ frequencyHz: ccToLogRange(127, 20, 20000) })],
      }),
      { commit: true },
    );

    const gainId = midiLearnEqTargetId(7, 0, 'gainDb');
    learn.armId(gainId);
    learn.handleCc({ channel: 0, controller: 39, value: 0 });
    expect(setStripEq).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ bands: [expect.objectContaining({ gainDb: -15 })] }),
      { commit: false },
    );

    const qId = midiLearnEqTargetId(7, 0, 'q');
    learn.armId(qId);
    learn.handleCc({ channel: 0, controller: 40, value: 127 });
    expect(setStripEq).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ bands: [expect.objectContaining({ q: 18 })] }),
      { commit: false },
    );
  });

  it('binds and drives mastering processor parameters across their control ranges', () => {
    useProjectStore().mixer.masteringChain = {
      processors: [{ processor: 'eq.tilt', params: { tiltDb: 0 }, enabled: true }],
    };
    const learn = useMidiLearn();
    const id = midiLearnMasteringTargetId(0, 'tiltDb');
    learn.armId(id);
    learn.handleCc({ channel: 0, controller: 41, value: 127 });

    expect(learn.bindingForId(id)).toEqual({ channel: 0, controller: 41 });
    expect(setMasteringParam).toHaveBeenCalledWith(0, 'tiltDb', 12, { commit: false });

    vi.advanceTimersByTime(250);
    expect(setMasteringParam).toHaveBeenLastCalledWith(0, 'tiltDb', 12, { commit: true });
  });

  it('binds and drives strip-local input trim and width controls', () => {
    const learn = useMidiLearn();
    const trimId = midiLearnStripControlTargetId('master', 'inputTrimDb');
    learn.armId(trimId);
    learn.handleCc({ channel: 0, controller: 24, value: 127 });
    expect(learn.bindingForId(trimId)).toEqual({ channel: 0, controller: 24 });
    expect(setStripInputTrim).toHaveBeenCalledWith('master', 48, { commit: false });

    const widthId = midiLearnStripControlTargetId(3, 'width');
    learn.armId(widthId);
    learn.handleCc({ channel: 1, controller: 25, value: 0 });
    expect(learn.bindingForId(widthId)).toEqual({ channel: 1, controller: 25 });
    expect(setStripWidth).toHaveBeenCalledWith(3, 0, { commit: false });

    vi.advanceTimersByTime(250);
    expect(setStripInputTrim).toHaveBeenLastCalledWith('master', 48, { commit: true });
    expect(setStripWidth).toHaveBeenLastCalledWith(3, 0, { commit: true });
  });

  it('binds and drives track-only strip panner detail controls', () => {
    useProjectStore().tracks = [
      {
        id: 7,
        name: 'Lead',
        kind: 'midi',
        color: '#fff',
        solo: false,
        mute: false,
        mixer: { gainDb: 0, pan: 0.25, inserts: [], sends: [] },
      },
    ];
    const learn = useMidiLearn();
    const delayId = midiLearnStripControlTargetId(7, 'channelDelaySamples');
    learn.armId(delayId);
    learn.handleCc({ channel: 0, controller: 26, value: 127 });
    expect(setStripChannelDelaySamples).toHaveBeenCalledWith(7, 96000);

    const dualRightId = midiLearnStripControlTargetId(7, 'dualPanRight');
    learn.armId(dualRightId);
    learn.handleCc({ channel: 0, controller: 27, value: 0 });
    expect(setStripDualPan).toHaveBeenCalledWith(7, 0.25, -1);
  });

  it('binds and drives strip polarity switches from CC thresholds', () => {
    useProjectStore().mixer.master.polarityInvertRight = true;
    const learn = useMidiLearn();
    const leftId = midiLearnStripControlTargetId('master', 'polarityLeft');
    learn.armId(leftId);
    learn.handleCc({ channel: 0, controller: 28, value: 127 });

    expect(learn.bindingForId(leftId)).toEqual({ channel: 0, controller: 28 });
    expect(setStripPolarityInvert).toHaveBeenCalledWith('master', true, true);

    setStripPolarityInvert.mockClear();
    learn.handleCc({ channel: 0, controller: 28, value: 0 });
    expect(setStripPolarityInvert).toHaveBeenCalledWith('master', false, true);
  });

  it('binds and drives strip pan law and pan mode enums', () => {
    const learn = useMidiLearn();
    const panLawId = midiLearnStripControlTargetId(7, 'panLaw');
    learn.armId(panLawId);
    learn.handleCc({ channel: 0, controller: 29, value: 127 });
    expect(learn.bindingForId(panLawId)).toEqual({ channel: 0, controller: 29 });
    expect(setStripPanLaw).toHaveBeenCalledWith(7, 'linear0dB');

    const panModeId = midiLearnStripControlTargetId(7, 'panMode');
    learn.armId(panModeId);
    learn.handleCc({ channel: 0, controller: 30, value: 127 });
    expect(learn.bindingForId(panModeId)).toEqual({ channel: 0, controller: 30 });
    expect(setStripPanMode).toHaveBeenCalledWith(7, 'dualPan');
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
