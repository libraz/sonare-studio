import { describe, expect, it } from 'vitest';
import {
  createSurfaceDecoder,
  encodeSurfaceFeedback,
  isStripButton,
  surfaceKeepAlive,
  surfaceRequiresSysEx,
} from '@/ui/midi/surface-protocol';

/** Splits a 14-bit value into the (lsb, msb) pair a pitch-bend carries. */
function bend(value14: number): [number, number] {
  return [value14 & 0x7f, (value14 >> 7) & 0x7f];
}

describe('Mackie Control decoding', () => {
  it('reads channel faders from pitch bend and normalizes them', () => {
    const decoder = createSurfaceDecoder('mcu');
    expect(decoder.decode([0xe3, ...bend(16383)])).toEqual([{ kind: 'fader', slot: 3, value: 1 }]);
    expect(decoder.decode([0xe0, ...bend(0)])).toEqual([{ kind: 'fader', slot: 0, value: 0 }]);
    // Channel 8 is the master fader, not a ninth strip.
    expect(decoder.decode([0xe8, ...bend(16383)])).toEqual([{ kind: 'masterFader', value: 1 }]);
  });

  it('reads strip buttons from their note blocks', () => {
    const decoder = createSurfaceDecoder('mcu');
    expect(decoder.decode([0x90, 0, 127])).toEqual([
      { kind: 'button', button: 'arm', slot: 0, pressed: true },
    ]);
    expect(decoder.decode([0x90, 19, 127])).toEqual([
      { kind: 'button', button: 'mute', slot: 3, pressed: true },
    ]);
    expect(decoder.decode([0x90, 31, 0])).toEqual([
      { kind: 'button', button: 'select', slot: 7, pressed: false },
    ]);
  });

  it('reads transport and bank buttons', () => {
    const decoder = createSurfaceDecoder('mcu');
    expect(decoder.decode([0x90, 94, 127])).toEqual([
      { kind: 'button', button: 'play', pressed: true },
    ]);
    expect(decoder.decode([0x90, 47, 127])).toEqual([
      { kind: 'button', button: 'bankNext', pressed: true },
    ]);
    // An unmapped note does nothing rather than firing the nearest action.
    expect(decoder.decode([0x90, 120, 127])).toEqual([]);
  });

  it('reads V-Pot turns as signed detents', () => {
    const decoder = createSurfaceDecoder('mcu');
    expect(decoder.decode([0xb0, 16, 3])).toEqual([{ kind: 'vpot', slot: 0, delta: 3 }]);
    // Bit 6 marks a counter-clockwise turn.
    expect(decoder.decode([0xb0, 23, 0x41])).toEqual([{ kind: 'vpot', slot: 7, delta: -1 }]);
    expect(decoder.decode([0xb0, 16, 0])).toEqual([]);
  });
});

describe('Mackie Control encoding', () => {
  it('drives motor faders with pitch bend', () => {
    expect(encodeSurfaceFeedback('mcu', { kind: 'fader', slot: 2, value: 1 })).toEqual([
      [0xe2, 0x7f, 0x7f],
    ]);
    expect(encodeSurfaceFeedback('mcu', { kind: 'masterFader', value: 0 })).toEqual([[0xe8, 0, 0]]);
  });

  it('lights button lamps on the note the button reports on', () => {
    expect(
      encodeSurfaceFeedback('mcu', { kind: 'led', button: 'mute', slot: 3, on: true }),
    ).toEqual([[0x90, 19, 127]]);
    expect(encodeSurfaceFeedback('mcu', { kind: 'led', button: 'play', on: false })).toEqual([
      [0x90, 94, 0],
    ]);
    // A strip lamp without a strip has no address.
    expect(encodeSurfaceFeedback('mcu', { kind: 'led', button: 'mute', on: true })).toEqual([]);
  });

  it('sends meters as channel pressure and rings as controllers', () => {
    expect(encodeSurfaceFeedback('mcu', { kind: 'meter', slot: 1, level: 1 })).toEqual([
      [0xd0, 0x1c],
    ]);
    expect(encodeSurfaceFeedback('mcu', { kind: 'meter', slot: 0, level: 0 })).toEqual([[0xd0, 0]]);
    expect(encodeSurfaceFeedback('mcu', { kind: 'vpotRing', slot: 0, position: 0.5 })).toEqual([
      [0xb0, 48, 6],
    ]);
  });

  it('needs no keep-alive and no SysEx permission', () => {
    expect(surfaceKeepAlive('mcu')).toEqual([]);
    expect(surfaceRequiresSysEx('mcu')).toBe(false);
  });
});

describe('HUI decoding', () => {
  it('pairs a zone select with the port state that follows it', () => {
    const decoder = createSurfaceDecoder('hui');
    expect(decoder.decode([0xb0, 0x0f, 0x02])).toEqual([]);
    expect(decoder.decode([0xb0, 0x2f, 0x42])).toEqual([
      { kind: 'button', button: 'mute', slot: 2, pressed: true },
    ]);
  });

  it('drops a port state that arrives without its zone', () => {
    const decoder = createSurfaceDecoder('hui');
    // Attributing an unaddressed port to whatever zone came before would fire
    // the wrong strip's button.
    expect(decoder.decode([0xb0, 0x2f, 0x42])).toEqual([]);
    decoder.decode([0xb0, 0x0f, 0x00]);
    decoder.decode([0xb0, 0x2f, 0x42]);
    expect(decoder.decode([0xb0, 0x2f, 0x42])).toEqual([]);
  });

  it('reads transport switches from the transport zone', () => {
    const decoder = createSurfaceDecoder('hui');
    decoder.decode([0xb0, 0x0f, 0x0e]);
    expect(decoder.decode([0xb0, 0x2f, 0x43])).toEqual([
      { kind: 'button', button: 'play', pressed: true },
    ]);
    decoder.decode([0xb0, 0x0f, 0x0e]);
    expect(decoder.decode([0xb0, 0x2f, 0x03])).toEqual([
      { kind: 'button', button: 'play', pressed: false },
    ]);
  });

  it('assembles a fader from its MSB/LSB pair only', () => {
    const decoder = createSurfaceDecoder('hui');
    // A lone LSB means the stream started mid-gesture: the position is unknown.
    expect(decoder.decode([0xb0, 0x21, 0x7f])).toEqual([]);
    expect(decoder.decode([0xb0, 0x01, 0x7f])).toEqual([]);
    expect(decoder.decode([0xb0, 0x21, 0x7f])).toEqual([{ kind: 'fader', slot: 1, value: 1 }]);
  });

  it('answers the keep-alive it is pinged with', () => {
    const decoder = createSurfaceDecoder('hui');
    expect(decoder.decode([0xf0, 0x00, 0x00, 0x66, 0x05, 0x00, 0x00, 0xf7])).toEqual([
      { kind: 'ping' },
    ]);
    expect(surfaceKeepAlive('hui')).toEqual([[0xf0, 0x00, 0x00, 0x66, 0x05, 0x00, 0x00, 0xf7]]);
    expect(surfaceRequiresSysEx('hui')).toBe(true);
  });
});

describe('HUI encoding', () => {
  it('lights a lamp with the zone/port pair the switch reports on', () => {
    expect(
      encodeSurfaceFeedback('hui', { kind: 'led', button: 'solo', slot: 5, on: true }),
    ).toEqual([
      [0xb0, 0x0f, 0x05],
      [0xb0, 0x2f, 0x43],
    ]);
    expect(encodeSurfaceFeedback('hui', { kind: 'led', button: 'play', on: false })).toEqual([
      [0xb0, 0x0f, 0x0e],
      [0xb0, 0x2f, 0x03],
    ]);
  });

  it('sends faders as a controller pair', () => {
    expect(encodeSurfaceFeedback('hui', { kind: 'fader', slot: 0, value: 1 })).toEqual([
      [0xb0, 0x00, 0x7f],
      [0xb0, 0x20, 0x7f],
    ]);
  });

  it('emits nothing for controls the mapped subset does not cover', () => {
    expect(encodeSurfaceFeedback('hui', { kind: 'meter', slot: 0, level: 1 })).toEqual([]);
    expect(encodeSurfaceFeedback('hui', { kind: 'masterFader', value: 1 })).toEqual([]);
  });
});

describe('surface protocol vocabulary', () => {
  it('separates strip buttons from session buttons', () => {
    expect(isStripButton('mute')).toBe(true);
    expect(isStripButton('play')).toBe(false);
  });

  it('ignores everything while no protocol is selected', () => {
    const decoder = createSurfaceDecoder('none');
    expect(decoder.decode([0x90, 94, 127])).toEqual([]);
    expect(encodeSurfaceFeedback('none', { kind: 'fader', slot: 0, value: 1 })).toEqual([]);
    expect(surfaceKeepAlive('none')).toEqual([]);
  });
});
