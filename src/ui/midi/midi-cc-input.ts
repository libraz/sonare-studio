/**
 * Web MIDI CC input helpers. MIDI learn stores bindings by the MSB controller
 * number, so 14-bit CC pairs are normalized back to that controller while
 * carrying the combined high-resolution value.
 */

export interface DecodedMidiCcInput {
  channel: number;
  controller: number;
  value: number;
  value14?: number;
  kind?: 'cc' | 'rpn' | 'nrpn';
  parameter?: number;
}

const MIDI_14BIT_MSB_MIN = 0;
const MIDI_14BIT_MSB_MAX = 31;
const MIDI_14BIT_LSB_MIN = 32;
const MIDI_14BIT_LSB_MAX = 63;
const CC_DATA_ENTRY_MSB = 6;
const CC_DATA_ENTRY_LSB = 38;
const CC_NRPN_LSB = 98;
const CC_NRPN_MSB = 99;
const CC_RPN_LSB = 100;
const CC_RPN_MSB = 101;

function key(channel: number, controller: number): string {
  return `${channel}:${controller}`;
}

interface ParameterSelector {
  kind: 'rpn' | 'nrpn';
  msb?: number;
  lsb?: number;
  dataMsb?: number;
}

export class MidiCc14BitTracker {
  private readonly msbByChannelController = new Map<string, number>();
  private readonly parameterByChannel = new Map<number, ParameterSelector>();

  private selector(channel: number, kind: 'rpn' | 'nrpn'): ParameterSelector {
    const existing = this.parameterByChannel.get(channel);
    if (existing?.kind === kind) return existing;
    const next: ParameterSelector = { kind };
    this.parameterByChannel.set(channel, next);
    return next;
  }

  private decodeParameterData(
    channel: number,
    value: number,
    lsb?: number,
  ): DecodedMidiCcInput | null {
    const selector = this.parameterByChannel.get(channel);
    if (!selector || selector.msb === undefined || selector.lsb === undefined) return null;
    const parameter = (selector.msb << 7) | selector.lsb;
    const value14 =
      lsb === undefined ? value << 7 : ((selector.dataMsb ?? value) << 7) | (lsb & 0x7f);
    return {
      channel,
      controller: CC_DATA_ENTRY_MSB,
      value,
      value14,
      kind: selector.kind,
      parameter,
    };
  }

  decode(channel: number, controller: number, value: number): DecodedMidiCcInput {
    const cc = controller & 0x7f;
    const v = value & 0x7f;
    if (cc === CC_NRPN_MSB) {
      this.selector(channel, 'nrpn').msb = v;
      return { channel, controller: cc, value: v };
    }
    if (cc === CC_NRPN_LSB) {
      this.selector(channel, 'nrpn').lsb = v;
      return { channel, controller: cc, value: v };
    }
    if (cc === CC_RPN_MSB) {
      this.selector(channel, 'rpn').msb = v;
      return { channel, controller: cc, value: v };
    }
    if (cc === CC_RPN_LSB) {
      this.selector(channel, 'rpn').lsb = v;
      return { channel, controller: cc, value: v };
    }
    if (cc === CC_DATA_ENTRY_MSB) {
      const selector = this.parameterByChannel.get(channel);
      if (selector) selector.dataMsb = v;
      return this.decodeParameterData(channel, v) ?? { channel, controller: cc, value: v };
    }
    if (cc === CC_DATA_ENTRY_LSB) {
      const selector = this.parameterByChannel.get(channel);
      if (selector?.dataMsb !== undefined) {
        return (
          this.decodeParameterData(channel, selector.dataMsb, v) ?? {
            channel,
            controller: cc,
            value: v,
          }
        );
      }
    }
    if (cc >= MIDI_14BIT_MSB_MIN && cc <= MIDI_14BIT_MSB_MAX) {
      this.msbByChannelController.set(key(channel, cc), v);
      return { channel, controller: cc, value: v, value14: v << 7 };
    }
    if (cc >= MIDI_14BIT_LSB_MIN && cc <= MIDI_14BIT_LSB_MAX) {
      const msbController = cc - MIDI_14BIT_LSB_MIN;
      const msb = this.msbByChannelController.get(key(channel, msbController));
      if (msb !== undefined) {
        return {
          channel,
          controller: msbController,
          value: msb,
          value14: (msb << 7) | v,
        };
      }
    }
    return { channel, controller: cc, value: v };
  }
}
