/**
 * Control-surface protocol codecs.
 *
 * Both supported surfaces are reduced to one vocabulary — {@link SurfaceEvent}
 * inbound, {@link SurfaceFeedback} outbound — so the app never branches on the
 * protocol beyond this module. Continuous values are normalized to 0..1 rather
 * than a protocol's own resolution, because a surface sends 14-bit faders while
 * the mixer bindings that consume them are 7-bit.
 *
 * Confidence differs between the two tables below and the difference matters
 * when something misbehaves. Mackie Control's note and pitch-bend assignments
 * are widely implemented and consistent across devices. The HUI zone/port table
 * is transcribed from the published protocol description and has *not* been
 * checked against hardware; it is deliberately kept in one place
 * ({@link HUI_ZONES}) so a wrong row can be corrected without touching the
 * decoding logic. Anything unmapped is ignored rather than guessed at.
 */

import type { ControlSurfaceProtocol } from '@/project/control-surface';

/** A control on the surface that behaves as a button. */
export type SurfaceButton =
  | 'arm'
  | 'solo'
  | 'mute'
  | 'select'
  | 'vpotPress'
  | 'bankPrev'
  | 'bankNext'
  | 'channelPrev'
  | 'channelNext'
  | 'play'
  | 'stop'
  | 'record'
  | 'rewind'
  | 'forward'
  | 'loop';

/** Buttons that belong to one strip rather than the transport. */
const STRIP_BUTTONS: ReadonlySet<SurfaceButton> = new Set<SurfaceButton>([
  'arm',
  'solo',
  'mute',
  'select',
  'vpotPress',
]);

/** True when a button belongs to a strip and therefore carries a slot. */
export function isStripButton(button: SurfaceButton): boolean {
  return STRIP_BUTTONS.has(button);
}

/** A decoded surface gesture. */
export type SurfaceEvent =
  /** Channel fader moved; `value` is normalized 0..1. */
  | { kind: 'fader'; slot: number; value: number }
  /** Master fader moved; `value` is normalized 0..1. */
  | { kind: 'masterFader'; value: number }
  /** Rotary encoder turned by a signed number of detents. */
  | { kind: 'vpot'; slot: number; delta: number }
  /** Button pressed or released. `slot` is present for strip buttons. */
  | { kind: 'button'; button: SurfaceButton; slot?: number; pressed: boolean }
  /** Keep-alive received; the host is expected to answer. */
  | { kind: 'ping' };

/** A state change to mirror back onto the surface. */
export type SurfaceFeedback =
  /** Motor fader position, normalized 0..1. */
  | { kind: 'fader'; slot: number; value: number }
  /** Master motor fader position, normalized 0..1. */
  | { kind: 'masterFader'; value: number }
  /** Button lamp state. */
  | { kind: 'led'; button: SurfaceButton; slot?: number; on: boolean }
  /** Strip meter level, normalized 0..1. */
  | { kind: 'meter'; slot: number; level: number }
  /** Encoder ring position, normalized 0..1. */
  | { kind: 'vpotRing'; slot: number; position: number };

/** One outbound MIDI message as raw bytes. */
export type SurfaceMessage = number[];

/** Strips a surface addresses in one bank under either protocol. */
export const SURFACE_STRIP_COUNT = 8;

const STATUS_NOTE_ON = 0x90;
const STATUS_CONTROL_CHANGE = 0xb0;
const STATUS_CHANNEL_PRESSURE = 0xd0;
const STATUS_PITCH_BEND = 0xe0;
const STATUS_SYSEX = 0xf0;

const MAX_14BIT = 16383;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function to14Bit(value: number): number {
  return Math.round(clamp01(value) * MAX_14BIT);
}

/* -------------------------------------------------------------------------- */
/* Mackie Control                                                             */
/* -------------------------------------------------------------------------- */

/** First note of each contiguous Mackie strip-button block. */
const MCU_STRIP_BLOCKS: ReadonlyArray<{ base: number; button: SurfaceButton }> = [
  { base: 0, button: 'arm' },
  { base: 8, button: 'solo' },
  { base: 16, button: 'mute' },
  { base: 24, button: 'select' },
  { base: 32, button: 'vpotPress' },
];

/** Mackie notes for the global buttons this app acts on. */
const MCU_GLOBAL_NOTES: ReadonlyMap<number, SurfaceButton> = new Map<number, SurfaceButton>([
  [46, 'bankPrev'],
  [47, 'bankNext'],
  [48, 'channelPrev'],
  [49, 'channelNext'],
  [86, 'loop'],
  [91, 'rewind'],
  [92, 'forward'],
  [93, 'stop'],
  [94, 'play'],
  [95, 'record'],
]);

/** Mackie note number a button lamp lives on, or null when unmapped. */
function mcuNoteFor(button: SurfaceButton, slot: number | undefined): number | null {
  const block = MCU_STRIP_BLOCKS.find((entry) => entry.button === button);
  if (block) {
    if (slot === undefined || slot < 0 || slot >= SURFACE_STRIP_COUNT) return null;
    return block.base + slot;
  }
  for (const [note, mapped] of MCU_GLOBAL_NOTES) {
    if (mapped === button) return note;
  }
  return null;
}

/** Channel carrying the Mackie master fader (strips occupy 0..7). */
const MCU_MASTER_FADER_CHANNEL = 8;

/** First controller of the Mackie V-Pot rotation block. */
const MCU_VPOT_CC = 16;
/** First controller of the Mackie V-Pot LED-ring block. */
const MCU_VPOT_RING_CC = 48;

/** Highest meter segment a Mackie strip meter displays (0x0C = top). */
const MCU_METER_MAX = 0x0c;

function decodeMackie(bytes: readonly number[]): SurfaceEvent[] {
  if (bytes.length < 2) return [];
  const status = bytes[0] & 0xf0;
  const channel = bytes[0] & 0x0f;
  const data1 = bytes[1] & 0x7f;
  const data2 = (bytes[2] ?? 0) & 0x7f;

  if (status === STATUS_PITCH_BEND) {
    const value = (data1 | (data2 << 7)) / MAX_14BIT;
    if (channel === MCU_MASTER_FADER_CHANNEL) return [{ kind: 'masterFader', value }];
    if (channel < SURFACE_STRIP_COUNT) return [{ kind: 'fader', slot: channel, value }];
    return [];
  }
  if (status === STATUS_NOTE_ON) {
    // Mackie surfaces send velocity 127 on press and 0 on release; a few send a
    // note-off instead, which arrives here as a 0-velocity press.
    const pressed = data2 >= 64;
    for (const block of MCU_STRIP_BLOCKS) {
      if (data1 >= block.base && data1 < block.base + SURFACE_STRIP_COUNT) {
        return [{ kind: 'button', button: block.button, slot: data1 - block.base, pressed }];
      }
    }
    const global = MCU_GLOBAL_NOTES.get(data1);
    return global ? [{ kind: 'button', button: global, pressed }] : [];
  }
  if (status === STATUS_CONTROL_CHANGE) {
    const slot = data1 - MCU_VPOT_CC;
    if (slot >= 0 && slot < SURFACE_STRIP_COUNT) {
      // Sign-magnitude relative encoding: bit 6 marks a counter-clockwise turn.
      const magnitude = data2 & 0x3f;
      if (magnitude === 0) return [];
      return [{ kind: 'vpot', slot, delta: (data2 & 0x40) === 0 ? magnitude : -magnitude }];
    }
  }
  return [];
}

function encodeMackie(feedback: SurfaceFeedback): SurfaceMessage[] {
  switch (feedback.kind) {
    case 'fader':
    case 'masterFader': {
      const channel =
        feedback.kind === 'masterFader'
          ? MCU_MASTER_FADER_CHANNEL
          : Math.min(SURFACE_STRIP_COUNT - 1, Math.max(0, feedback.slot));
      const value = to14Bit(feedback.value);
      return [[STATUS_PITCH_BEND | channel, value & 0x7f, (value >> 7) & 0x7f]];
    }
    case 'led': {
      const note = mcuNoteFor(feedback.button, feedback.slot);
      return note === null ? [] : [[STATUS_NOTE_ON, note, feedback.on ? 127 : 0]];
    }
    case 'meter': {
      if (feedback.slot < 0 || feedback.slot >= SURFACE_STRIP_COUNT) return [];
      const segment = Math.round(clamp01(feedback.level) * MCU_METER_MAX);
      return [[STATUS_CHANNEL_PRESSURE, (feedback.slot << 4) | segment]];
    }
    default: {
      if (feedback.slot < 0 || feedback.slot >= SURFACE_STRIP_COUNT) return [];
      // Ring position 0 turns every LED off, so an active pot starts at 1.
      const position = 1 + Math.round(clamp01(feedback.position) * 10);
      return [[STATUS_CONTROL_CHANGE, MCU_VPOT_RING_CC + feedback.slot, position]];
    }
  }
}

/* -------------------------------------------------------------------------- */
/* HUI                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * HUI switch map: zone id to the button each port carries.
 *
 * Transcribed from the published protocol description and unverified against
 * hardware. Ports left out of a row are ignored rather than guessed at, so an
 * unmapped switch does nothing instead of triggering the wrong action.
 */
const HUI_ZONES: ReadonlyMap<number, ReadonlyMap<number, SurfaceButton>> = new Map([
  // Zones 0x00..0x07 are the eight channel strips; the port layout repeats.
  ...Array.from({ length: SURFACE_STRIP_COUNT }, (_, strip) => {
    const ports = new Map<number, SurfaceButton>([
      [1, 'select'],
      [2, 'mute'],
      [3, 'solo'],
      [5, 'vpotPress'],
      [7, 'arm'],
    ]);
    return [strip, ports as ReadonlyMap<number, SurfaceButton>] as const;
  }),
  [
    0x0a,
    new Map<number, SurfaceButton>([
      [0, 'channelPrev'],
      [1, 'channelNext'],
      [2, 'bankPrev'],
      [3, 'bankNext'],
    ]) as ReadonlyMap<number, SurfaceButton>,
  ],
  [
    0x0e,
    new Map<number, SurfaceButton>([
      [0, 'rewind'],
      [1, 'forward'],
      [2, 'stop'],
      [3, 'play'],
      [4, 'record'],
      [5, 'loop'],
    ]) as ReadonlyMap<number, SurfaceButton>,
  ],
]);

/** Zone id of a channel strip's switches, or null for global zones. */
function huiZoneStrip(zone: number): number | null {
  return zone < SURFACE_STRIP_COUNT ? zone : null;
}

/** Zone / port pair a button is reported and lit on. */
function huiAddressFor(
  button: SurfaceButton,
  slot: number | undefined,
): { zone: number; port: number } | null {
  for (const [zone, ports] of HUI_ZONES) {
    const strip = huiZoneStrip(zone);
    // A strip button is only addressable on its own strip's zone.
    if (strip !== null && strip !== slot) continue;
    if (strip === null && isStripButton(button)) continue;
    for (const [port, mapped] of ports) {
      if (mapped === button) return { zone, port };
    }
  }
  return null;
}

const HUI_ZONE_SELECT_CC = 0x0f;
const HUI_PORT_STATE_CC = 0x2f;
const HUI_FADER_MSB_CC = 0x00;
const HUI_FADER_LSB_CC = 0x20;
const HUI_VPOT_CC = 0x40;

/** HUI keep-alive, sent by the host and echoed by the device. */
const HUI_PING: SurfaceMessage = [STATUS_SYSEX, 0x00, 0x00, 0x66, 0x05, 0x00, 0x00, 0xf7];

/** True when the bytes are a HUI keep-alive. */
function isHuiPing(bytes: readonly number[]): boolean {
  if (bytes.length < HUI_PING.length) return false;
  return HUI_PING.every((byte, index) => bytes[index] === byte);
}

function encodeHui(feedback: SurfaceFeedback): SurfaceMessage[] {
  switch (feedback.kind) {
    case 'fader': {
      if (feedback.slot < 0 || feedback.slot >= SURFACE_STRIP_COUNT) return [];
      const value = to14Bit(feedback.value);
      return [
        [STATUS_CONTROL_CHANGE, HUI_FADER_MSB_CC + feedback.slot, (value >> 7) & 0x7f],
        [STATUS_CONTROL_CHANGE, HUI_FADER_LSB_CC + feedback.slot, value & 0x7f],
      ];
    }
    case 'led': {
      const address = huiAddressFor(feedback.button, feedback.slot);
      if (!address) return [];
      return [
        [STATUS_CONTROL_CHANGE, HUI_ZONE_SELECT_CC, address.zone],
        [
          STATUS_CONTROL_CHANGE,
          HUI_PORT_STATE_CC,
          (feedback.on ? 0x40 : 0x00) | (address.port & 0x0f),
        ],
      ];
    }
    default:
      // HUI has no master fader, meters or encoder rings in the mapped subset.
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Decoders                                                                   */
/* -------------------------------------------------------------------------- */

/** Stateful protocol decoder; HUI needs history to pair its two-byte switches. */
export interface SurfaceDecoder {
  /**
   * Decodes one raw MIDI message.
   *
   * @param bytes Raw message bytes, status byte first.
   * @returns Zero or more gestures; an unmapped message yields none.
   */
  decode(bytes: readonly number[]): SurfaceEvent[];
}

class MackieDecoder implements SurfaceDecoder {
  decode(bytes: readonly number[]): SurfaceEvent[] {
    return decodeMackie(bytes);
  }
}

class HuiDecoder implements SurfaceDecoder {
  /** Zone selected by the most recent 0x0F message. */
  private zone: number | null = null;
  /** Fader MSBs awaiting their LSB, keyed by strip. */
  private readonly faderMsb = new Map<number, number>();

  decode(bytes: readonly number[]): SurfaceEvent[] {
    if (isHuiPing(bytes)) return [{ kind: 'ping' }];
    if (bytes.length < 3) return [];
    if ((bytes[0] & 0xf0) !== STATUS_CONTROL_CHANGE) return [];
    const controller = bytes[1] & 0x7f;
    const value = bytes[2] & 0x7f;

    if (controller === HUI_ZONE_SELECT_CC) {
      this.zone = value;
      return [];
    }
    if (controller === HUI_PORT_STATE_CC) {
      const zone = this.zone;
      // A port state without a preceding zone select is unaddressed; dropping
      // it is safer than attributing it to whichever zone came before.
      this.zone = null;
      if (zone === null) return [];
      const button = HUI_ZONES.get(zone)?.get(value & 0x0f);
      if (!button) return [];
      const strip = huiZoneStrip(zone);
      const pressed = (value & 0x40) !== 0;
      return [
        strip === null
          ? { kind: 'button', button, pressed }
          : { kind: 'button', button, slot: strip, pressed },
      ];
    }
    const msbStrip = controller - HUI_FADER_MSB_CC;
    if (msbStrip >= 0 && msbStrip < SURFACE_STRIP_COUNT) {
      this.faderMsb.set(msbStrip, value);
      return [];
    }
    const lsbStrip = controller - HUI_FADER_LSB_CC;
    if (lsbStrip >= 0 && lsbStrip < SURFACE_STRIP_COUNT) {
      const msb = this.faderMsb.get(lsbStrip);
      // Without the MSB half the position is unknown; HUI always sends the
      // pair, so a lone LSB means the stream started mid-gesture.
      if (msb === undefined) return [];
      this.faderMsb.delete(lsbStrip);
      return [{ kind: 'fader', slot: lsbStrip, value: ((msb << 7) | value) / MAX_14BIT }];
    }
    const vpotStrip = controller - HUI_VPOT_CC;
    if (vpotStrip >= 0 && vpotStrip < SURFACE_STRIP_COUNT) {
      const magnitude = value & 0x3f;
      if (magnitude === 0) return [];
      return [
        { kind: 'vpot', slot: vpotStrip, delta: (value & 0x40) === 0 ? magnitude : -magnitude },
      ];
    }
    return [];
  }
}

class InertDecoder implements SurfaceDecoder {
  decode(): SurfaceEvent[] {
    return [];
  }
}

/**
 * Creates a decoder for a protocol.
 *
 * @param protocol Protocol the surface speaks; `none` yields a decoder that
 *   ignores everything, so a caller need not special-case it.
 */
export function createSurfaceDecoder(protocol: ControlSurfaceProtocol): SurfaceDecoder {
  if (protocol === 'mcu') return new MackieDecoder();
  if (protocol === 'hui') return new HuiDecoder();
  return new InertDecoder();
}

/**
 * Encodes one feedback item into raw MIDI messages.
 *
 * @param protocol Protocol the surface speaks.
 * @param feedback State to mirror onto the surface.
 * @returns Messages to send, empty when the protocol has no such control.
 */
export function encodeSurfaceFeedback(
  protocol: ControlSurfaceProtocol,
  feedback: SurfaceFeedback,
): SurfaceMessage[] {
  if (protocol === 'mcu') return encodeMackie(feedback);
  if (protocol === 'hui') return encodeHui(feedback);
  return [];
}

/**
 * Keep-alive a protocol expects from the host, if any. HUI drops out of remote
 * mode without it; Mackie needs none.
 *
 * @param protocol Protocol the surface speaks.
 */
export function surfaceKeepAlive(protocol: ControlSurfaceProtocol): SurfaceMessage[] {
  return protocol === 'hui' ? [[...HUI_PING]] : [];
}

/** Interval between keep-alives, in milliseconds. */
export const SURFACE_KEEP_ALIVE_INTERVAL_MS = 1000;

/** True when a protocol needs SysEx access to work at all. */
export function surfaceRequiresSysEx(protocol: ControlSurfaceProtocol): boolean {
  return protocol === 'hui';
}
