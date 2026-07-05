import { describe, expect, it } from 'vitest';
import { MidiCc14BitTracker } from '@/ui/midi/midi-cc-input';

describe('MidiCc14BitTracker', () => {
  it('emits the MSB controller and combined value for 14-bit CC pairs', () => {
    const tracker = new MidiCc14BitTracker();
    expect(tracker.decode(0, 1, 64)).toEqual({
      channel: 0,
      controller: 1,
      value: 64,
      value14: 8192,
    });
    expect(tracker.decode(0, 33, 5)).toEqual({
      channel: 0,
      controller: 1,
      value: 64,
      value14: 8197,
    });
  });

  it('keeps unrelated 7-bit controllers unchanged', () => {
    const tracker = new MidiCc14BitTracker();
    expect(tracker.decode(2, 74, 100)).toEqual({ channel: 2, controller: 74, value: 100 });
  });

  it('does not combine an LSB before its channel/controller MSB arrives', () => {
    const tracker = new MidiCc14BitTracker();
    expect(tracker.decode(0, 33, 5)).toEqual({ channel: 0, controller: 33, value: 5 });
    tracker.decode(1, 1, 64);
    expect(tracker.decode(0, 33, 5)).toEqual({ channel: 0, controller: 33, value: 5 });
  });

  it('decodes RPN data entry with the selected parameter and 14-bit value', () => {
    const tracker = new MidiCc14BitTracker();
    tracker.decode(0, 101, 0);
    tracker.decode(0, 100, 2);
    expect(tracker.decode(0, 6, 64)).toEqual({
      channel: 0,
      controller: 6,
      value: 64,
      value14: 8192,
      kind: 'rpn',
      parameter: 2,
    });
    expect(tracker.decode(0, 38, 5)).toEqual({
      channel: 0,
      controller: 6,
      value: 64,
      value14: 8197,
      kind: 'rpn',
      parameter: 2,
    });
  });

  it('switches NRPN and RPN selectors independently per channel', () => {
    const tracker = new MidiCc14BitTracker();
    tracker.decode(2, 99, 1);
    tracker.decode(2, 98, 12);
    expect(tracker.decode(2, 6, 10)).toEqual({
      channel: 2,
      controller: 6,
      value: 10,
      value14: 1280,
      kind: 'nrpn',
      parameter: 140,
    });

    tracker.decode(2, 101, 0);
    tracker.decode(2, 100, 0);
    expect(tracker.decode(2, 6, 20)).toMatchObject({
      kind: 'rpn',
      parameter: 0,
      value14: 2560,
    });

    expect(tracker.decode(3, 6, 20)).toEqual({ channel: 3, controller: 6, value: 20 });
  });
});
