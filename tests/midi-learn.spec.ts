import { describe, expect, it } from 'vitest';
import {
  ccToGainDb,
  ccToPan,
  ccToRange,
  clampCcValue,
  formatMidiCcBinding,
  gainDbToCc,
  MIDI_FADER_MAX_DB,
  MIDI_FADER_MIN_DB,
  midiLearnInsertTargetId,
  midiLearnInstrumentTargetId,
  midiLearnTargetId,
  midiLearnTargetScope,
  panToCc,
  parseMidiLearnInsertTargetId,
  parseMidiLearnInstrumentTargetId,
  parseMidiLearnTargetId,
  rangeToCc,
  sanitizeMidiCcBindings,
  withMidiLearnTargetScope,
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

describe('insert target ids', () => {
  it('encodes and decodes master and track insert-parameter targets', () => {
    expect(midiLearnInsertTargetId('master', 0, 'gainDb')).toBe('insert:master:0:gainDb');
    expect(midiLearnInsertTargetId(7, 2, 'thresholdDb')).toBe('insert:7:2:thresholdDb');
    expect(parseMidiLearnInsertTargetId('insert:master:0:gainDb')).toEqual({
      scope: 'master',
      index: 0,
      paramId: 'gainDb',
    });
    expect(parseMidiLearnInsertTargetId('insert:7:2:thresholdDb')).toEqual({
      scope: 7,
      index: 2,
      paramId: 'thresholdDb',
    });
  });

  it('round-trips through the encoder', () => {
    const id = midiLearnInsertTargetId(3, 5, 'ratio');
    expect(parseMidiLearnInsertTargetId(id)).toEqual({ scope: 3, index: 5, paramId: 'ratio' });
  });

  it('rejects malformed insert ids and non-insert ids', () => {
    expect(parseMidiLearnInsertTargetId('gain:master')).toBeNull();
    expect(parseMidiLearnInsertTargetId('insert:7')).toBeNull();
    expect(parseMidiLearnInsertTargetId('insert:7:2')).toBeNull();
    expect(parseMidiLearnInsertTargetId('insert:7:x:ratio')).toBeNull();
    expect(parseMidiLearnInsertTargetId('insert:7:2:')).toBeNull();
    expect(parseMidiLearnInsertTargetId('insert::2:ratio')).toBeNull();
  });
});

describe('instrument target ids', () => {
  it('encodes and decodes instrument-parameter targets', () => {
    expect(midiLearnInstrumentTargetId(7, 'cutoffHz')).toBe('instrument:7:cutoffHz');
    expect(parseMidiLearnInstrumentTargetId('instrument:7:cutoffHz')).toEqual({
      trackId: 7,
      paramId: 'cutoffHz',
    });
  });

  it('round-trips through the encoder', () => {
    const id = midiLearnInstrumentTargetId(12, 'ampReleaseMs');
    expect(parseMidiLearnInstrumentTargetId(id)).toEqual({ trackId: 12, paramId: 'ampReleaseMs' });
  });

  it('rejects malformed instrument ids and non-instrument ids', () => {
    expect(parseMidiLearnInstrumentTargetId('insert:7:2:ratio')).toBeNull();
    expect(parseMidiLearnInstrumentTargetId('instrument:7')).toBeNull();
    expect(parseMidiLearnInstrumentTargetId('instrument:7:')).toBeNull();
    expect(parseMidiLearnInstrumentTargetId('instrument:x:cutoffHz')).toBeNull();
    expect(parseMidiLearnInstrumentTargetId('instrument::cutoffHz')).toBeNull();
  });
});

describe('range mapping', () => {
  it('maps the CC extremes and center across an arbitrary range', () => {
    expect(ccToRange(0, -60, 0)).toBe(-60);
    expect(ccToRange(127, -60, 0)).toBe(0);
    expect(ccToRange(64, 0, 1)).toBeCloseTo(64 / 127, 5);
  });

  it('round-trips a value back to its CC and handles degenerate ranges', () => {
    for (const cc of [0, 32, 64, 100, 127]) {
      expect(rangeToCc(ccToRange(cc, -24, 24), -24, 24)).toBe(cc);
    }
    expect(rangeToCc(5, 10, 10)).toBe(0);
    expect(rangeToCc(Number.NaN, 0, 1)).toBe(0);
  });
});

describe('target scope helpers', () => {
  it('extracts the track scope of every target kind', () => {
    expect(midiLearnTargetScope('gain:master')).toBe('master');
    expect(midiLearnTargetScope('pan:7')).toBe(7);
    expect(midiLearnTargetScope('insert:3:0:thresholdDb')).toBe(3);
    expect(midiLearnTargetScope('insert:master:0:gainDb')).toBe('master');
    expect(midiLearnTargetScope('instrument:5:cutoffHz')).toBe(5);
    expect(midiLearnTargetScope('nonsense')).toBeNull();
  });

  it('rewrites the track scope, keeping the rest of the target', () => {
    expect(withMidiLearnTargetScope('gain:master', 4)).toBe('gain:4');
    expect(withMidiLearnTargetScope('pan:7', 2)).toBe('pan:2');
    expect(withMidiLearnTargetScope('insert:3:0:thresholdDb', 9)).toBe('insert:9:0:thresholdDb');
    expect(withMidiLearnTargetScope('instrument:5:cutoffHz', 1)).toBe('instrument:1:cutoffHz');
  });

  it('refuses to move an instrument target onto the master strip', () => {
    expect(withMidiLearnTargetScope('instrument:5:cutoffHz', 'master')).toBeNull();
    expect(withMidiLearnTargetScope('garbage', 1)).toBeNull();
  });
});

describe('sanitizeMidiCcBindings', () => {
  it('keeps well-formed entries and the trackScoped flag', () => {
    expect(
      sanitizeMidiCcBindings([
        { target: 'gain:master', channel: 0, controller: 7 },
        { target: 'insert:0:1:ratio', channel: 2, controller: 20, trackScoped: true },
      ]),
    ).toEqual([
      { target: 'gain:master', channel: 0, controller: 7 },
      { target: 'insert:0:1:ratio', channel: 2, controller: 20, trackScoped: true },
    ]);
  });

  it('drops malformed, out-of-range, duplicate and non-array inputs', () => {
    expect(sanitizeMidiCcBindings('nope')).toEqual([]);
    expect(
      sanitizeMidiCcBindings([
        { target: 'bogus:1', channel: 0, controller: 7 },
        { target: 'gain:master', channel: 16, controller: 7 },
        { target: 'pan:1', channel: 0, controller: 200 },
        { target: 'gain:master', channel: 0, controller: 7 },
        { target: 'gain:master', channel: 1, controller: 8 },
      ]),
    ).toEqual([{ target: 'gain:master', channel: 0, controller: 7 }]);
  });
});

describe('formatMidiCcBinding', () => {
  it('shows a 1-based channel', () => {
    expect(formatMidiCcBinding({ channel: 0, controller: 7 })).toBe('CC 7 · Ch 1');
    expect(formatMidiCcBinding({ channel: 15, controller: 74 })).toBe('CC 74 · Ch 16');
  });
});
