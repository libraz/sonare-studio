import { describe, expect, it } from 'vitest';
import {
  ccToGainDb,
  ccToPan,
  clampCcValue,
  formatMidiCcBinding,
  gainDbToCc,
  MIDI_FADER_MAX_DB,
  MIDI_FADER_MIN_DB,
  midiLearnTargetId,
  panToCc,
  parseMidiLearnTargetId,
} from '@/ui/midi/midi-learn';

describe('clampCcValue', () => {
  it('rounds and clamps to [0, 127]', () => {
    expect(clampCcValue(-5)).toBe(0);
    expect(clampCcValue(200)).toBe(127);
    expect(clampCcValue(63.6)).toBe(64);
    expect(clampCcValue(Number.NaN)).toBe(0);
  });
});

describe('gain mapping', () => {
  it('maps the CC extremes and center across the fader window', () => {
    expect(ccToGainDb(0)).toBe(MIDI_FADER_MIN_DB);
    expect(ccToGainDb(127)).toBe(MIDI_FADER_MAX_DB);
    expect(ccToGainDb(64)).toBeCloseTo(
      MIDI_FADER_MIN_DB + (64 / 127) * (MIDI_FADER_MAX_DB - MIDI_FADER_MIN_DB),
      5,
    );
  });

  it('round-trips dB back to the originating CC value', () => {
    for (const cc of [0, 32, 64, 100, 127]) {
      expect(gainDbToCc(ccToGainDb(cc))).toBe(cc);
    }
    expect(gainDbToCc(Number.NaN)).toBe(0);
  });
});

describe('pan mapping', () => {
  it('maps 0/64/127 to hard left / center / hard right', () => {
    expect(ccToPan(0)).toBe(-1);
    expect(ccToPan(64)).toBe(0);
    expect(ccToPan(127)).toBe(1);
  });

  it('round-trips pan back through the center', () => {
    expect(panToCc(0)).toBe(64);
    expect(panToCc(1)).toBe(127);
    expect(panToCc(-1)).toBe(1);
    expect(panToCc(Number.NaN)).toBe(64);
  });
});

describe('target ids', () => {
  it('encodes and decodes master and track targets', () => {
    expect(midiLearnTargetId('gain', 'master')).toBe('gain:master');
    expect(midiLearnTargetId('pan', 7)).toBe('pan:7');
    expect(parseMidiLearnTargetId('gain:master')).toEqual({ param: 'gain', scope: 'master' });
    expect(parseMidiLearnTargetId('pan:7')).toEqual({ param: 'pan', scope: 7 });
  });

  it('rejects malformed ids', () => {
    expect(parseMidiLearnTargetId('nope')).toBeNull();
    expect(parseMidiLearnTargetId('mute:1')).toBeNull();
    expect(parseMidiLearnTargetId('gain:abc')).toBeNull();
  });
});

describe('formatMidiCcBinding', () => {
  it('shows a 1-based channel', () => {
    expect(formatMidiCcBinding({ channel: 0, controller: 7 })).toBe('CC 7 · Ch 1');
    expect(formatMidiCcBinding({ channel: 15, controller: 74 })).toBe('CC 74 · Ch 16');
  });
});
