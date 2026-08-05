import { describe, expect, it } from 'vitest';
import {
  ccToGainDb,
  ccToLogRange,
  ccToPan,
  ccToRange,
  clampCcValue,
  formatMidiCcBinding,
  gainDbToCc,
  MIDI_FADER_MAX_DB,
  MIDI_FADER_MIN_DB,
  MIDI_LEARN_TRANSPORT_ACTIONS,
  midiLearnEqTargetId,
  midiLearnInsertTargetId,
  midiLearnInstrumentTargetId,
  midiLearnMasteringTargetId,
  midiLearnSendTargetId,
  midiLearnStripControlTargetId,
  midiLearnTargetId,
  midiLearnTargetScope,
  midiLearnTrackStateTargetId,
  midiLearnTransportTargetId,
  midiLearnVcaTargetId,
  panToCc,
  parseMidiLearnEqTargetId,
  parseMidiLearnInsertTargetId,
  parseMidiLearnInstrumentTargetId,
  parseMidiLearnMasteringTargetId,
  parseMidiLearnSendTargetId,
  parseMidiLearnStripControlTargetId,
  parseMidiLearnTargetId,
  parseMidiLearnTrackStateTargetId,
  parseMidiLearnTransportTargetId,
  parseMidiLearnVcaTargetId,
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

describe('transport target ids', () => {
  it('round-trips every learnable transport action', () => {
    for (const action of MIDI_LEARN_TRANSPORT_ACTIONS) {
      const id = midiLearnTransportTargetId(action);
      expect(parseMidiLearnTransportTargetId(id)).toBe(action);
      // Transport bindings belong to the session, not to a strip, so they
      // survive a track-scope rewrite untouched.
      expect(midiLearnTargetScope(id)).toBe('global');
    }
  });

  it('rejects ids that are not transport targets', () => {
    expect(parseMidiLearnTransportTargetId('transport:rewind')).toBeNull();
    expect(parseMidiLearnTransportTargetId('gain:master')).toBeNull();
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

  it('round-trips stable processor ids independently of slot order', () => {
    const id = midiLearnInsertTargetId(3, 'processor:lead/1', 'threshold:db');
    expect(id).toBe('insert-id:3:processor%3Alead%2F1:threshold%3Adb');
    expect(parseMidiLearnInsertTargetId(id)).toEqual({
      scope: 3,
      processorId: 'processor:lead/1',
      paramId: 'threshold:db',
    });
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

describe('send target ids', () => {
  it('encodes and decodes mixer-send level targets', () => {
    expect(midiLearnSendTargetId(7, 'bus:verb')).toBe('send:7:bus%3Averb');
    expect(parseMidiLearnSendTargetId('send:7:bus%3Averb')).toEqual({
      scope: 7,
      busId: 'bus:verb',
      param: 'level',
    });
  });

  it('encodes and decodes mixer-send switch and enum targets', () => {
    expect(midiLearnSendTargetId(7, 'bus:verb', 'enabled')).toBe('send:7:bus%3Averb:enabled');
    expect(parseMidiLearnSendTargetId('send:7:bus%3Averb:timing')).toEqual({
      scope: 7,
      busId: 'bus:verb',
      param: 'timing',
    });
  });

  it('rejects malformed send ids', () => {
    expect(parseMidiLearnSendTargetId('send:master:bus')).toBeNull();
    expect(parseMidiLearnSendTargetId('send:7')).toBeNull();
    expect(parseMidiLearnSendTargetId('send:7:')).toBeNull();
    expect(parseMidiLearnSendTargetId('gain:7')).toBeNull();
  });
});

describe('strip control target ids', () => {
  it('encodes and decodes track and master strip-local controls', () => {
    expect(midiLearnStripControlTargetId(7, 'inputTrimDb')).toBe('strip:7:inputTrimDb');
    expect(midiLearnStripControlTargetId('master', 'width')).toBe('strip:master:width');
    expect(parseMidiLearnStripControlTargetId('strip:master:polarityLeft')).toEqual({
      scope: 'master',
      param: 'polarityLeft',
    });
    expect(parseMidiLearnStripControlTargetId('strip:7:panLaw')).toEqual({
      scope: 7,
      param: 'panLaw',
    });
    expect(parseMidiLearnStripControlTargetId('strip:7:dualPanLeft')).toEqual({
      scope: 7,
      param: 'dualPanLeft',
    });
    expect(parseMidiLearnStripControlTargetId('strip:master:width')).toEqual({
      scope: 'master',
      param: 'width',
    });
  });

  it('rejects malformed or master-only-incompatible strip controls', () => {
    expect(parseMidiLearnStripControlTargetId('strip:7')).toBeNull();
    expect(parseMidiLearnStripControlTargetId('strip:7:nope')).toBeNull();
    expect(parseMidiLearnStripControlTargetId('strip:abc:width')).toBeNull();
    expect(parseMidiLearnStripControlTargetId('strip:master:channelDelaySamples')).toBeNull();
    expect(parseMidiLearnStripControlTargetId('strip:master:panLaw')).toBeNull();
    expect(parseMidiLearnStripControlTargetId('strip:master:panMode')).toBeNull();
    expect(parseMidiLearnStripControlTargetId('strip:master:dualPanLeft')).toBeNull();
  });
});

describe('track state target ids', () => {
  it('encodes and decodes track mute and solo targets', () => {
    expect(midiLearnTrackStateTargetId(7, 'mute')).toBe('track:7:mute');
    expect(parseMidiLearnTrackStateTargetId('track:7:solo')).toEqual({
      trackId: 7,
      param: 'solo',
    });
  });

  it('rejects malformed track state ids', () => {
    expect(parseMidiLearnTrackStateTargetId('track:master:mute')).toBeNull();
    expect(parseMidiLearnTrackStateTargetId('track:7')).toBeNull();
    expect(parseMidiLearnTrackStateTargetId('track:7:soloSafe')).toBeNull();
    expect(parseMidiLearnTrackStateTargetId('gain:7')).toBeNull();
  });
});

describe('VCA target ids', () => {
  it('encodes and decodes VCA gain, mute, and solo targets', () => {
    expect(midiLearnVcaTargetId('drum:vca', 'gain')).toBe('vca:drum%3Avca:gain');
    expect(parseMidiLearnVcaTargetId('vca:drum%3Avca:mute')).toEqual({
      groupId: 'drum:vca',
      param: 'mute',
    });
    expect(parseMidiLearnVcaTargetId('vca:drum%3Avca:solo')).toEqual({
      groupId: 'drum:vca',
      param: 'solo',
    });
  });

  it('rejects malformed VCA ids', () => {
    expect(parseMidiLearnVcaTargetId('vca:drums')).toBeNull();
    expect(parseMidiLearnVcaTargetId('vca::gain')).toBeNull();
    expect(parseMidiLearnVcaTargetId('vca:drums:pan')).toBeNull();
    expect(parseMidiLearnVcaTargetId('track:7:mute')).toBeNull();
  });
});

describe('EQ target ids', () => {
  it('encodes and decodes track and master EQ band targets', () => {
    expect(midiLearnEqTargetId(7, 2, 'frequencyHz')).toBe('eq:7:2:frequencyHz');
    expect(parseMidiLearnEqTargetId('eq:master:0:gainDb')).toEqual({
      scope: 'master',
      bandIndex: 0,
      param: 'gainDb',
    });
    expect(parseMidiLearnEqTargetId('eq:7:1:q')).toEqual({
      scope: 7,
      bandIndex: 1,
      param: 'q',
    });
  });

  it('rejects malformed EQ ids', () => {
    expect(parseMidiLearnEqTargetId('eq:7')).toBeNull();
    expect(parseMidiLearnEqTargetId('eq:7:x:gainDb')).toBeNull();
    expect(parseMidiLearnEqTargetId('eq:7:-1:gainDb')).toBeNull();
    expect(parseMidiLearnEqTargetId('eq:7:0:type')).toBeNull();
  });
});

describe('mastering target ids', () => {
  it('encodes and decodes mastering processor parameter targets', () => {
    expect(midiLearnMasteringTargetId(2, 'threshold:db')).toBe('mastering:2:threshold%3Adb');
    expect(parseMidiLearnMasteringTargetId('mastering:0:tiltDb')).toEqual({
      index: 0,
      paramId: 'tiltDb',
    });
  });

  it('round-trips stable mastering processor ids', () => {
    const id = midiLearnMasteringTargetId('master:limiter/1', 'ceiling:db');
    expect(id).toBe('mastering-id:master%3Alimiter%2F1:ceiling%3Adb');
    expect(parseMidiLearnMasteringTargetId(id)).toEqual({
      processorId: 'master:limiter/1',
      paramId: 'ceiling:db',
    });
  });

  it('rejects malformed mastering ids', () => {
    expect(parseMidiLearnMasteringTargetId('mastering:0')).toBeNull();
    expect(parseMidiLearnMasteringTargetId('mastering:x:tiltDb')).toBeNull();
    expect(parseMidiLearnMasteringTargetId('mastering:-1:tiltDb')).toBeNull();
    expect(parseMidiLearnMasteringTargetId('eq:0:0:q')).toBeNull();
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

  it('maps a CC value logarithmically across a positive range', () => {
    expect(ccToLogRange(0, 20, 20000)).toBe(20);
    expect(ccToLogRange(127, 20, 20000)).toBe(20000);
    expect(ccToLogRange(64, 0, 1)).toBeCloseTo(64 / 127, 5);
  });
});

describe('target scope helpers', () => {
  it('extracts the track scope of every target kind', () => {
    expect(midiLearnTargetScope('gain:master')).toBe('master');
    expect(midiLearnTargetScope('pan:7')).toBe(7);
    expect(midiLearnTargetScope('insert:3:0:thresholdDb')).toBe(3);
    expect(midiLearnTargetScope('insert:master:0:gainDb')).toBe('master');
    expect(midiLearnTargetScope('instrument:5:cutoffHz')).toBe(5);
    expect(midiLearnTargetScope('send:6:bus-1')).toBe(6);
    expect(midiLearnTargetScope('send:6:bus-1:enabled')).toBe(6);
    expect(midiLearnTargetScope('track:6:mute')).toBe(6);
    expect(midiLearnTargetScope('vca:drums:gain')).toBe('global');
    expect(midiLearnTargetScope('eq:6:0:frequencyHz')).toBe(6);
    expect(midiLearnTargetScope('eq:master:0:q')).toBe('master');
    expect(midiLearnTargetScope('mastering:0:tiltDb')).toBe('global');
    expect(midiLearnTargetScope('strip:6:inputTrimDb')).toBe(6);
    expect(midiLearnTargetScope('strip:master:width')).toBe('master');
    expect(midiLearnTargetScope('bus-strip:bus-1:width')).toBe('global');
    expect(midiLearnTargetScope('nonsense')).toBeNull();
  });

  it('rewrites the track scope, keeping the rest of the target', () => {
    expect(withMidiLearnTargetScope('gain:master', 4)).toBe('gain:4');
    expect(withMidiLearnTargetScope('pan:7', 2)).toBe('pan:2');
    expect(withMidiLearnTargetScope('insert:3:0:thresholdDb', 9)).toBe('insert:9:0:thresholdDb');
    expect(withMidiLearnTargetScope('instrument:5:cutoffHz', 1)).toBe('instrument:1:cutoffHz');
    expect(withMidiLearnTargetScope('send:5:bus-1', 8)).toBe('send:8:bus-1');
    expect(withMidiLearnTargetScope('send:5:bus-1:timing', 8)).toBe('send:8:bus-1:timing');
    expect(withMidiLearnTargetScope('track:5:solo', 8)).toBe('track:8:solo');
    expect(withMidiLearnTargetScope('eq:5:0:gainDb', 8)).toBe('eq:8:0:gainDb');
    expect(withMidiLearnTargetScope('eq:5:0:q', 'master')).toBe('eq:master:0:q');
    expect(withMidiLearnTargetScope('strip:5:inputTrimDb', 8)).toBe('strip:8:inputTrimDb');
    expect(withMidiLearnTargetScope('strip:5:width', 'master')).toBe('strip:master:width');
  });

  it('refuses to move an instrument target onto the master strip', () => {
    expect(withMidiLearnTargetScope('instrument:5:cutoffHz', 'master')).toBeNull();
    expect(withMidiLearnTargetScope('send:5:bus-1', 'master')).toBeNull();
    expect(withMidiLearnTargetScope('track:5:mute', 'master')).toBeNull();
    expect(withMidiLearnTargetScope('strip:5:panLaw', 'master')).toBeNull();
    expect(withMidiLearnTargetScope('strip:5:dualPanLeft', 'master')).toBeNull();
    expect(withMidiLearnTargetScope('garbage', 1)).toBeNull();
  });
});

describe('sanitizeMidiCcBindings', () => {
  it('keeps well-formed entries and the trackScoped flag', () => {
    expect(
      sanitizeMidiCcBindings([
        { target: 'gain:master', channel: 0, controller: 7 },
        { target: 'insert:0:1:ratio', channel: 2, controller: 20, trackScoped: true },
        { target: 'send:0:bus-1', channel: 3, controller: 21, trackScoped: true },
        { target: 'strip:0:inputTrimDb', channel: 4, controller: 22, trackScoped: true },
        { target: 'track:0:mute', channel: 5, controller: 23, trackScoped: true },
        { target: 'vca:drums:gain', channel: 6, controller: 24 },
        { target: 'eq:0:1:q', channel: 7, controller: 25, trackScoped: true },
        { target: 'mastering:0:tiltDb', channel: 8, controller: 26 },
        { target: 'pan:master', channel: 1, controller: 6, kind: 'rpn', parameter: 2 },
      ]),
    ).toEqual([
      { target: 'gain:master', channel: 0, controller: 7 },
      { target: 'insert:0:1:ratio', channel: 2, controller: 20, trackScoped: true },
      { target: 'send:0:bus-1', channel: 3, controller: 21, trackScoped: true },
      { target: 'strip:0:inputTrimDb', channel: 4, controller: 22, trackScoped: true },
      { target: 'track:0:mute', channel: 5, controller: 23, trackScoped: true },
      { target: 'vca:drums:gain', channel: 6, controller: 24 },
      { target: 'eq:0:1:q', channel: 7, controller: 25, trackScoped: true },
      { target: 'mastering:0:tiltDb', channel: 8, controller: 26 },
      { target: 'pan:master', channel: 1, controller: 6, kind: 'rpn', parameter: 2 },
    ]);
  });

  it('drops malformed, out-of-range, duplicate and non-array inputs', () => {
    expect(sanitizeMidiCcBindings('nope')).toEqual([]);
    expect(
      sanitizeMidiCcBindings([
        { target: 'bogus:1', channel: 0, controller: 7 },
        { target: 'gain:master', channel: 16, controller: 7 },
        { target: 'pan:1', channel: 0, controller: 200 },
        { target: 'pan:2', channel: 0, controller: 6, kind: 'nrpn', parameter: 20000 },
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
    expect(formatMidiCcBinding({ channel: 1, controller: 6, kind: 'rpn', parameter: 2 })).toBe(
      'RPN 2 · Ch 2',
    );
    expect(formatMidiCcBinding({ channel: 2, controller: 6, kind: 'nrpn', parameter: 140 })).toBe(
      'NRPN 140 · Ch 3',
    );
  });
});
