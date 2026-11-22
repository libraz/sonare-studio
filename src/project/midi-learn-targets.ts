/**
 * MIDI-learn target model: the binding shape a learned controller is stored
 * as, the string grammar of every target id family a binding can point at
 * (encoders and decoders), the persistence-scope helpers that make bindings
 * portable across a document load, and sanitization of a persisted binding
 * list. Pure data and logic, shared by the project store, commands and
 * serializer and by the MIDI-learn UI.
 */

import { MIDI_CC_MAX } from './midi-cc';

/** The mixer parameter a CC binding drives. */
export type MidiLearnParam = 'gain' | 'pan';

/** A mixer strip a binding targets: a track id, or the master strip. */
export type MidiLearnScope = number | 'master';

/** A decoded learn target: which parameter on which strip. */
export interface MidiLearnTarget {
  /** Driven parameter. */
  param: MidiLearnParam;
  /** Driven strip (track id or 'master'). */
  scope: MidiLearnScope;
}

/** A stored binding: the channel + controller a target listens to. */
export interface MidiCcBinding {
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
  /** Binding family. Omitted means a legacy CC binding. */
  kind?: 'cc' | 'rpn' | 'nrpn';
  /** RPN/NRPN parameter number (0-16383), when `kind` is not `cc`. */
  parameter?: number;
}

/**
 * Builds a stable signature of a CC-binding map's contents. Bindings live in a
 * map that is mutated in place (`set`/`delete`/`clear`), so its reference never
 * changes; a watcher that wants to react to binding edits (to mark the project
 * dirty or schedule an autosave) must observe this signature, which iterates the
 * map and therefore tracks those mutations. The order-independent sort keeps the
 * signature identical regardless of insertion order.
 *
 * @param bindings Live MIDI-learn binding map keyed by target id.
 * @returns A deterministic string that changes whenever any binding is added,
 *   removed or remapped.
 */
export function midiCcBindingsKey(bindings: ReadonlyMap<string, MidiCcBinding>): string {
  const parts: string[] = [];
  for (const [id, binding] of bindings) {
    parts.push(
      `${id}=${binding.kind ?? 'cc'}:${binding.channel}:${binding.controller}:${binding.parameter ?? ''}`,
    );
  }
  return parts.sort().join('|');
}

/** Lowest / highest 7-bit MIDI value. */
export const MIDI_VALUE_MAX = MIDI_CC_MAX;

/** Encodes a learn target into a stable string id (e.g. `gain:master`, `pan:7`). */
export function midiLearnTargetId(param: MidiLearnParam, scope: MidiLearnScope): string {
  return `${param}:${scope}`;
}

/** Decodes a target id, or null when it is malformed. */
export function parseMidiLearnTargetId(id: string): MidiLearnTarget | null {
  const sep = id.indexOf(':');
  if (sep < 0) return null;
  const param = id.slice(0, sep);
  if (param !== 'gain' && param !== 'pan') return null;
  const rest = id.slice(sep + 1);
  if (rest === 'master') return { param, scope: 'master' };
  const trackId = Number(rest);
  if (!Number.isInteger(trackId)) return null;
  return { param, scope: trackId };
}

/** Prefix marking an insert-parameter learn target id. */
const INSERT_TARGET_PREFIX = 'insert:';
const INSERT_ID_TARGET_PREFIX = 'insert-id:';

/** A decoded insert-parameter learn target. */
export interface MidiLearnInsertTarget {
  /** Strip the insert lives on (track id or 'master'). */
  scope: MidiLearnScope;
  /** Legacy insert slot index, present only for old target ids. */
  index?: number;
  /** Stable processor identity, present for current target ids. */
  processorId?: string;
  /** Processor parameter name (a quick-control id). */
  paramId: string;
}

/**
 * Encodes an insert-parameter learn target, e.g. `insert:7:2:thresholdDb`
 * (track 7, slot 2) or `insert:master:0:gainDb`. The param id is the last
 * segment, so it may itself contain colons without ambiguity.
 *
 * @param scope Strip the insert lives on (track id or 'master').
 * @param index Insert slot index.
 * @param paramId Processor parameter name.
 * @returns The encoded target id.
 */
export function midiLearnInsertTargetId(
  scope: MidiLearnScope,
  identity: number | string,
  paramId: string,
): string {
  return typeof identity === 'number'
    ? `${INSERT_TARGET_PREFIX}${scope}:${identity}:${paramId}`
    : `${INSERT_ID_TARGET_PREFIX}${scope}:${encodeURIComponent(identity)}:${encodeURIComponent(paramId)}`;
}

/** Decodes an insert-parameter target id, or null when it is malformed. */
export function parseMidiLearnInsertTargetId(id: string): MidiLearnInsertTarget | null {
  const stable = id.startsWith(INSERT_ID_TARGET_PREFIX);
  if (!stable && !id.startsWith(INSERT_TARGET_PREFIX)) return null;
  const rest = id.slice(stable ? INSERT_ID_TARGET_PREFIX.length : INSERT_TARGET_PREFIX.length);
  const firstSep = rest.indexOf(':');
  if (firstSep <= 0) return null;
  const scopeText = rest.slice(0, firstSep);
  const afterScope = rest.slice(firstSep + 1);
  const secondSep = afterScope.indexOf(':');
  if (secondSep < 0) return null;
  const identityText = afterScope.slice(0, secondSep);
  const paramText = afterScope.slice(secondSep + 1);
  if (paramText.length === 0) return null;
  const trackId = Number(scopeText);
  const scope: MidiLearnScope =
    scopeText === 'master' ? 'master' : Number.isInteger(trackId) ? trackId : Number.NaN;
  if (scope !== 'master' && !Number.isInteger(scope)) return null;
  if (stable) {
    try {
      const processorId = decodeURIComponent(identityText);
      const paramId = decodeURIComponent(paramText);
      return processorId.length > 0 && paramId.length > 0 ? { scope, processorId, paramId } : null;
    } catch {
      return null;
    }
  }
  const index = Number(identityText);
  if (!Number.isInteger(index) || index < 0) return null;
  return { scope, index, paramId: paramText };
}

/** Prefix marking an instrument-parameter learn target id. */
const INSTRUMENT_TARGET_PREFIX = 'instrument:';

/** A decoded instrument-parameter learn target. */
export interface MidiLearnInstrumentTarget {
  /** Track whose instrument is driven. */
  trackId: number;
  /** Instrument parameter name (a quick-control id). */
  paramId: string;
}

/**
 * Encodes an instrument-parameter learn target, e.g. `instrument:7:cutoffHz`.
 * The param id is the last segment, so it may itself contain colons.
 *
 * @param trackId Track whose instrument is driven.
 * @param paramId Instrument parameter name.
 * @returns The encoded target id.
 */
export function midiLearnInstrumentTargetId(trackId: number, paramId: string): string {
  return `${INSTRUMENT_TARGET_PREFIX}${trackId}:${paramId}`;
}

/** Decodes an instrument-parameter target id, or null when it is malformed. */
export function parseMidiLearnInstrumentTargetId(id: string): MidiLearnInstrumentTarget | null {
  if (!id.startsWith(INSTRUMENT_TARGET_PREFIX)) return null;
  const rest = id.slice(INSTRUMENT_TARGET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const paramId = rest.slice(sep + 1);
  if (paramId.length === 0) return null;
  const trackId = Number(rest.slice(0, sep));
  if (!Number.isInteger(trackId)) return null;
  return { trackId, paramId };
}

/** Prefix marking a mixer-send level learn target id. */
const SEND_TARGET_PREFIX = 'send:';

/** Mixer-send controls exposed to MIDI Learn. */
export type MidiLearnSendParam = 'level' | 'enabled' | 'timing';

/** A decoded mixer-send level learn target. */
export interface MidiLearnSendTarget {
  /** Source strip that owns the send (track id only; master sends are not audible). */
  scope: number;
  /** Destination mixer bus id. */
  busId: string;
  /** Send control. Legacy ids without a param decode as `level`. */
  param: MidiLearnSendParam;
}

/**
 * Encodes a mixer-send level learn target, e.g. `send:7:bus-1`.
 *
 * @param scope Source track id.
 * @param busId Destination mixer bus id.
 * @returns The encoded target id.
 */
export function midiLearnSendTargetId(
  scope: number,
  busId: string,
  param: MidiLearnSendParam = 'level',
): string {
  const base = `${SEND_TARGET_PREFIX}${scope}:${encodeURIComponent(busId)}`;
  return param === 'level' ? base : `${base}:${param}`;
}

/** Decodes a mixer-send target id, or null when it is malformed. */
export function parseMidiLearnSendTargetId(id: string): MidiLearnSendTarget | null {
  if (!id.startsWith(SEND_TARGET_PREFIX)) return null;
  const rest = id.slice(SEND_TARGET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const scope = Number(rest.slice(0, sep));
  if (!Number.isInteger(scope)) return null;
  const tail = rest.slice(sep + 1);
  const paramSep = tail.lastIndexOf(':');
  const maybeParam = paramSep >= 0 ? tail.slice(paramSep + 1) : '';
  const hasParam = maybeParam === 'level' || maybeParam === 'enabled' || maybeParam === 'timing';
  const busText = hasParam ? tail.slice(0, paramSep) : tail;
  if (busText.length === 0) return null;
  try {
    const busId = decodeURIComponent(busText);
    return busId.length > 0 ? { scope, busId, param: hasParam ? maybeParam : 'level' } : null;
  } catch {
    return null;
  }
}

/** Track-state controls exposed to MIDI Learn. */
export type MidiLearnTrackStateParam = 'mute' | 'solo';

/** Prefix marking a track-state learn target id. */
const TRACK_STATE_TARGET_PREFIX = 'track:';

/** A decoded track-state target. */
export interface MidiLearnTrackStateTarget {
  /** Track whose state is driven. */
  trackId: number;
  /** Track-state control id. */
  param: MidiLearnTrackStateParam;
}

/**
 * Encodes a track-state learn target, e.g. `track:7:mute`.
 *
 * @param trackId Track id.
 * @param param Track-state control id.
 * @returns The encoded target id.
 */
export function midiLearnTrackStateTargetId(
  trackId: number,
  param: MidiLearnTrackStateParam,
): string {
  return `${TRACK_STATE_TARGET_PREFIX}${trackId}:${param}`;
}

/** Decodes a track-state target id, or null when it is malformed. */
export function parseMidiLearnTrackStateTargetId(id: string): MidiLearnTrackStateTarget | null {
  if (!id.startsWith(TRACK_STATE_TARGET_PREFIX)) return null;
  const rest = id.slice(TRACK_STATE_TARGET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const trackId = Number(rest.slice(0, sep));
  if (!Number.isInteger(trackId)) return null;
  const param = rest.slice(sep + 1);
  if (param !== 'mute' && param !== 'solo') return null;
  return { trackId, param };
}

/**
 * Transport actions a control surface can drive. These are momentary buttons:
 * the action fires on press (value >= 64) and ignores the release, matching
 * how transport buttons on a surface behave.
 */
export type MidiLearnTransportAction = 'play' | 'stop' | 'record' | 'loop';

/** All learnable transport actions, in transport-bar order. */
export const MIDI_LEARN_TRANSPORT_ACTIONS: ReadonlyArray<MidiLearnTransportAction> = [
  'play',
  'stop',
  'record',
  'loop',
];

/** Prefix marking a transport learn target id. */
const TRANSPORT_TARGET_PREFIX = 'transport:';

/**
 * Encodes a transport learn target, e.g. `transport:play`.
 *
 * @param action Transport action driven by the binding.
 */
export function midiLearnTransportTargetId(action: MidiLearnTransportAction): string {
  return `${TRANSPORT_TARGET_PREFIX}${action}`;
}

/** Decodes a transport target id, or null when it is malformed. */
export function parseMidiLearnTransportTargetId(id: string): MidiLearnTransportAction | null {
  if (!id.startsWith(TRANSPORT_TARGET_PREFIX)) return null;
  const action = id.slice(TRANSPORT_TARGET_PREFIX.length);
  return MIDI_LEARN_TRANSPORT_ACTIONS.includes(action as MidiLearnTransportAction)
    ? (action as MidiLearnTransportAction)
    : null;
}

/**
 * Controls one bank slot exposes. A bank slot is a physical strip on a control
 * surface rather than a track: the binding is learned once and follows whichever
 * track the bank window currently points at, so eight faders can drive any
 * number of tracks.
 */
export type MidiLearnBankParam = 'gain' | 'pan' | 'mute' | 'solo' | 'arm' | 'select';

/** All bank-slot controls, in strip order. */
export const MIDI_LEARN_BANK_PARAMS: ReadonlyArray<MidiLearnBankParam> = [
  'gain',
  'pan',
  'mute',
  'solo',
  'arm',
  'select',
];

/**
 * Bank navigation actions. Like transport buttons these are momentary: the
 * action fires on press and ignores the release.
 */
export type MidiLearnBankAction = 'prev' | 'next' | 'home';

/** All bank navigation actions. */
export const MIDI_LEARN_BANK_ACTIONS: ReadonlyArray<MidiLearnBankAction> = ['prev', 'next', 'home'];

/**
 * Highest addressable bank slot. Eight is the usual surface width; extenders
 * chain up to this many strips.
 */
export const MAX_CONTROL_SURFACE_SLOTS = 32;

/** Prefix marking a bank-slot or bank-navigation learn target id. */
const BANK_TARGET_PREFIX = 'bank:';

/** A decoded bank-slot target. */
export interface MidiLearnBankTarget {
  /** Zero-based slot index on the surface. */
  slot: number;
  /** Slot control id. */
  param: MidiLearnBankParam;
}

/**
 * Encodes a bank-slot learn target, e.g. `bank:0:gain`.
 *
 * @param slot Zero-based slot index on the surface.
 * @param param Slot control id.
 * @returns The encoded target id.
 */
export function midiLearnBankTargetId(slot: number, param: MidiLearnBankParam): string {
  return `${BANK_TARGET_PREFIX}${slot}:${param}`;
}

/** Decodes a bank-slot target id, or null when it is malformed. */
export function parseMidiLearnBankTargetId(id: string): MidiLearnBankTarget | null {
  if (!id.startsWith(BANK_TARGET_PREFIX)) return null;
  const rest = id.slice(BANK_TARGET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const slot = Number(rest.slice(0, sep));
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_CONTROL_SURFACE_SLOTS) return null;
  const param = rest.slice(sep + 1);
  return MIDI_LEARN_BANK_PARAMS.includes(param as MidiLearnBankParam)
    ? { slot, param: param as MidiLearnBankParam }
    : null;
}

/**
 * Encodes a bank navigation target, e.g. `bank:next`. Navigation ids carry no
 * slot segment, which is what distinguishes them from slot ids.
 *
 * @param action Navigation action driven by the binding.
 */
export function midiLearnBankActionTargetId(action: MidiLearnBankAction): string {
  return `${BANK_TARGET_PREFIX}${action}`;
}

/** Decodes a bank navigation target id, or null when it is malformed. */
export function parseMidiLearnBankActionTargetId(id: string): MidiLearnBankAction | null {
  if (!id.startsWith(BANK_TARGET_PREFIX)) return null;
  const action = id.slice(BANK_TARGET_PREFIX.length);
  return MIDI_LEARN_BANK_ACTIONS.includes(action as MidiLearnBankAction)
    ? (action as MidiLearnBankAction)
    : null;
}

/** VCA group controls exposed to MIDI Learn. */
export type MidiLearnVcaParam = 'gain' | 'mute' | 'solo';

/** Prefix marking a VCA-group learn target id. */
const VCA_TARGET_PREFIX = 'vca:';

/** A decoded VCA-group target. */
export interface MidiLearnVcaTarget {
  /** Stable VCA group id. */
  groupId: string;
  /** VCA control id. */
  param: MidiLearnVcaParam;
}

/**
 * Encodes a VCA-group learn target, e.g. `vca:drums:gain`.
 *
 * @param groupId Stable VCA group id.
 * @param param VCA control id.
 * @returns The encoded target id.
 */
export function midiLearnVcaTargetId(groupId: string, param: MidiLearnVcaParam): string {
  return `${VCA_TARGET_PREFIX}${encodeURIComponent(groupId)}:${param}`;
}

/** Decodes a VCA-group target id, or null when it is malformed. */
export function parseMidiLearnVcaTargetId(id: string): MidiLearnVcaTarget | null {
  if (!id.startsWith(VCA_TARGET_PREFIX)) return null;
  const rest = id.slice(VCA_TARGET_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const param = rest.slice(sep + 1);
  if (param !== 'gain' && param !== 'mute' && param !== 'solo') return null;
  try {
    const groupId = decodeURIComponent(rest.slice(0, sep));
    return groupId.length > 0 ? { groupId, param } : null;
  } catch {
    return null;
  }
}

/** EQ band controls exposed to MIDI Learn. */
export type MidiLearnEqParam = 'frequencyHz' | 'gainDb' | 'q';

/** Prefix marking an EQ-band learn target id. */
const EQ_TARGET_PREFIX = 'eq:';

/** A decoded EQ-band target. */
export interface MidiLearnEqTarget {
  /** Strip whose EQ band is driven. */
  scope: MidiLearnScope;
  /** Zero-based EQ band index. */
  bandIndex: number;
  /** EQ band field. */
  param: MidiLearnEqParam;
}

/**
 * Encodes an EQ-band learn target, e.g. `eq:7:0:frequencyHz`.
 *
 * @param scope Strip scope.
 * @param bandIndex Zero-based EQ band index.
 * @param param EQ band field.
 * @returns The encoded target id.
 */
export function midiLearnEqTargetId(
  scope: MidiLearnScope,
  bandIndex: number,
  param: MidiLearnEqParam,
): string {
  return `${EQ_TARGET_PREFIX}${scope}:${bandIndex}:${param}`;
}

/** Decodes an EQ-band target id, or null when it is malformed. */
export function parseMidiLearnEqTargetId(id: string): MidiLearnEqTarget | null {
  if (!id.startsWith(EQ_TARGET_PREFIX)) return null;
  const rest = id.slice(EQ_TARGET_PREFIX.length);
  const firstSep = rest.indexOf(':');
  if (firstSep <= 0) return null;
  const scopeText = rest.slice(0, firstSep);
  const afterScope = rest.slice(firstSep + 1);
  const secondSep = afterScope.indexOf(':');
  if (secondSep <= 0) return null;
  const bandIndex = Number(afterScope.slice(0, secondSep));
  if (!Number.isInteger(bandIndex) || bandIndex < 0) return null;
  const param = afterScope.slice(secondSep + 1);
  if (param !== 'frequencyHz' && param !== 'gainDb' && param !== 'q') return null;
  if (scopeText === 'master') return { scope: 'master', bandIndex, param };
  const trackId = Number(scopeText);
  if (!Number.isInteger(trackId)) return null;
  return { scope: trackId, bandIndex, param };
}

/** Prefix marking a mastering processor parameter learn target id. */
const MASTERING_TARGET_PREFIX = 'mastering:';
const MASTERING_ID_TARGET_PREFIX = 'mastering-id:';

/** A decoded mastering processor parameter target. */
export interface MidiLearnMasteringTarget {
  /** Legacy zero-based processor index. */
  index?: number;
  /** Stable processor identity used by current target ids. */
  processorId?: string;
  /** Processor parameter id. */
  paramId: string;
}

/**
 * Encodes a mastering processor learn target, e.g. `mastering:0:thresholdDb`.
 *
 * @param index Zero-based mastering processor index.
 * @param paramId Processor parameter id.
 * @returns The encoded target id.
 */
export function midiLearnMasteringTargetId(identity: number | string, paramId: string): string {
  return typeof identity === 'number'
    ? `${MASTERING_TARGET_PREFIX}${identity}:${encodeURIComponent(paramId)}`
    : `${MASTERING_ID_TARGET_PREFIX}${encodeURIComponent(identity)}:${encodeURIComponent(paramId)}`;
}

/** Decodes a mastering processor target id, or null when it is malformed. */
export function parseMidiLearnMasteringTargetId(id: string): MidiLearnMasteringTarget | null {
  const stable = id.startsWith(MASTERING_ID_TARGET_PREFIX);
  if (!stable && !id.startsWith(MASTERING_TARGET_PREFIX)) return null;
  const rest = id.slice(
    stable ? MASTERING_ID_TARGET_PREFIX.length : MASTERING_TARGET_PREFIX.length,
  );
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  try {
    const paramId = decodeURIComponent(rest.slice(sep + 1));
    if (paramId.length === 0) return null;
    if (stable) {
      const processorId = decodeURIComponent(rest.slice(0, sep));
      return processorId.length > 0 ? { processorId, paramId } : null;
    }
    const index = Number(rest.slice(0, sep));
    return Number.isInteger(index) && index >= 0 ? { index, paramId } : null;
  } catch {
    return null;
  }
}

/** Continuous strip-local DSP controls exposed to MIDI Learn. */
export type MidiLearnStripControlParam =
  | 'inputTrimDb'
  | 'width'
  | 'polarityLeft'
  | 'polarityRight'
  | 'channelDelaySamples'
  | 'panLaw'
  | 'panMode'
  | 'dualPanLeft'
  | 'dualPanRight';

/** Strip-local controls that a send/return bus exposes. */
export type MidiLearnBusStripControlParam =
  | 'inputTrimDb'
  | 'width'
  | 'polarityLeft'
  | 'polarityRight';

/** Prefix marking a strip-local control learn target id. */
const STRIP_CONTROL_TARGET_PREFIX = 'strip:';
const BUS_STRIP_CONTROL_TARGET_PREFIX = 'bus-strip:';

/** A decoded strip-local control target. */
export interface MidiLearnStripControlTarget {
  /** Strip whose local control is driven. */
  scope: MidiLearnScope;
  /** Strip-local continuous control id. */
  param: MidiLearnStripControlParam;
}

/** A decoded send/return-bus strip-control target. */
export interface MidiLearnBusStripControlTarget {
  busId: string;
  param: MidiLearnBusStripControlParam;
}

/**
 * Encodes a strip-local control target, e.g. `strip:7:inputTrimDb`.
 *
 * @param scope Strip scope.
 * @param param Strip-local control id.
 * @returns The encoded target id.
 */
export function midiLearnStripControlTargetId(
  scope: MidiLearnScope,
  param: MidiLearnStripControlParam,
): string {
  return `${STRIP_CONTROL_TARGET_PREFIX}${scope}:${param}`;
}

/** Encodes one MIDI-learnable send/return-bus strip control. */
export function midiLearnBusStripControlTargetId(
  busId: string,
  param: MidiLearnBusStripControlParam,
): string {
  return `${BUS_STRIP_CONTROL_TARGET_PREFIX}${encodeURIComponent(busId)}:${param}`;
}

/** Decodes a send/return-bus strip-control target. */
export function parseMidiLearnBusStripControlTargetId(
  id: string,
): MidiLearnBusStripControlTarget | null {
  if (!id.startsWith(BUS_STRIP_CONTROL_TARGET_PREFIX)) return null;
  const rest = id.slice(BUS_STRIP_CONTROL_TARGET_PREFIX.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const param = rest.slice(sep + 1);
  if (
    param !== 'inputTrimDb' &&
    param !== 'width' &&
    param !== 'polarityLeft' &&
    param !== 'polarityRight'
  ) {
    return null;
  }
  try {
    const busId = decodeURIComponent(rest.slice(0, sep));
    return busId.length > 0 ? { busId, param } : null;
  } catch {
    return null;
  }
}

/** Decodes a strip-local control target id, or null when it is malformed. */
export function parseMidiLearnStripControlTargetId(id: string): MidiLearnStripControlTarget | null {
  if (!id.startsWith(STRIP_CONTROL_TARGET_PREFIX)) return null;
  const rest = id.slice(STRIP_CONTROL_TARGET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const scopeText = rest.slice(0, sep);
  const param = rest.slice(sep + 1);
  if (
    param !== 'inputTrimDb' &&
    param !== 'width' &&
    param !== 'polarityLeft' &&
    param !== 'polarityRight' &&
    param !== 'channelDelaySamples' &&
    param !== 'panLaw' &&
    param !== 'panMode' &&
    param !== 'dualPanLeft' &&
    param !== 'dualPanRight'
  ) {
    return null;
  }
  if (scopeText === 'master') {
    if (
      param === 'channelDelaySamples' ||
      param === 'panLaw' ||
      param === 'panMode' ||
      param === 'dualPanLeft' ||
      param === 'dualPanRight'
    ) {
      return null;
    }
    return { scope: 'master', param };
  }
  const trackId = Number(scopeText);
  if (!Number.isInteger(trackId)) return null;
  return { scope: trackId, param };
}

/**
 * True when an id decodes to any known learn target. Every family a binding can
 * point at must be listed here: persistence sanitizes a loaded document against
 * this predicate, so a family missing from it round-trips to nothing.
 */
export function isMidiLearnTargetId(id: string): boolean {
  return (
    parseMidiLearnTargetId(id) !== null ||
    parseMidiLearnInsertTargetId(id) !== null ||
    parseMidiLearnInstrumentTargetId(id) !== null ||
    parseMidiLearnSendTargetId(id) !== null ||
    parseMidiLearnTrackStateTargetId(id) !== null ||
    parseMidiLearnVcaTargetId(id) !== null ||
    parseMidiLearnEqTargetId(id) !== null ||
    parseMidiLearnMasteringTargetId(id) !== null ||
    parseMidiLearnStripControlTargetId(id) !== null ||
    parseMidiLearnBusStripControlTargetId(id) !== null ||
    parseMidiLearnTransportTargetId(id) !== null ||
    parseMidiLearnBankTargetId(id) !== null ||
    parseMidiLearnBankActionTargetId(id) !== null
  );
}

/** Persistence scope extracted from a target id. */
export type MidiLearnTargetScope = MidiLearnScope | 'global';

/**
 * Extracts the track scope a target id is bound to: a track id, 'master', or
 * null when the id does not decode. Track-scoped ids embed a session track id
 * (gain/pan/insert/instrument); 'master' ids are stable across reloads.
 */
export function midiLearnTargetScope(id: string): MidiLearnTargetScope | null {
  const strip = parseMidiLearnTargetId(id);
  if (strip) return strip.scope;
  const insert = parseMidiLearnInsertTargetId(id);
  if (insert) return insert.scope;
  const instrument = parseMidiLearnInstrumentTargetId(id);
  if (instrument) return instrument.trackId;
  const send = parseMidiLearnSendTargetId(id);
  if (send) return send.scope;
  const trackState = parseMidiLearnTrackStateTargetId(id);
  if (trackState) return trackState.trackId;
  const vca = parseMidiLearnVcaTargetId(id);
  if (vca) return 'global';
  // Transport bindings drive the session, not a strip.
  if (parseMidiLearnTransportTargetId(id) !== null) return 'global';
  // Bank bindings address a surface slot; the track they reach is resolved
  // through the bank window at dispatch time, so nothing here is track-scoped.
  if (parseMidiLearnBankTargetId(id) !== null) return 'global';
  if (parseMidiLearnBankActionTargetId(id) !== null) return 'global';
  const eq = parseMidiLearnEqTargetId(id);
  if (eq) return eq.scope;
  const mastering = parseMidiLearnMasteringTargetId(id);
  if (mastering) return 'global';
  const stripControl = parseMidiLearnStripControlTargetId(id);
  if (stripControl) return stripControl.scope;
  // Bus ids are document-stable identifiers, unlike session-assigned track
  // ids. Keep their bindings verbatim across a save/load cycle.
  if (parseMidiLearnBusStripControlTargetId(id)) return 'global';
  return null;
}

/**
 * Rewrites a target id's track scope to a new value, keeping the rest of the
 * target intact. Returns null when the id does not decode, or when a numeric
 * scope is replaced by 'master' on an instrument target (which is track-only).
 *
 * This makes a binding portable across a document load: serialize replaces the
 * session track id with the track's positional index, and load replaces that
 * index with the freshly assigned track id.
 */
export function withMidiLearnTargetScope(id: string, scope: MidiLearnScope): string | null {
  const strip = parseMidiLearnTargetId(id);
  if (strip) return midiLearnTargetId(strip.param, scope);
  const insert = parseMidiLearnInsertTargetId(id);
  if (insert) {
    const identity = insert.processorId ?? insert.index;
    return identity !== undefined ? midiLearnInsertTargetId(scope, identity, insert.paramId) : null;
  }
  const instrument = parseMidiLearnInstrumentTargetId(id);
  if (instrument) {
    if (scope === 'master') return null;
    return midiLearnInstrumentTargetId(scope, instrument.paramId);
  }
  const send = parseMidiLearnSendTargetId(id);
  if (send) {
    if (scope === 'master') return null;
    return midiLearnSendTargetId(scope, send.busId, send.param);
  }
  const trackState = parseMidiLearnTrackStateTargetId(id);
  if (trackState) {
    if (scope === 'master') return null;
    return midiLearnTrackStateTargetId(scope, trackState.param);
  }
  const eq = parseMidiLearnEqTargetId(id);
  if (eq) return midiLearnEqTargetId(scope, eq.bandIndex, eq.param);
  const stripControl = parseMidiLearnStripControlTargetId(id);
  if (stripControl) {
    if (
      scope === 'master' &&
      (stripControl.param === 'channelDelaySamples' ||
        stripControl.param === 'panLaw' ||
        stripControl.param === 'panMode' ||
        stripControl.param === 'dualPanLeft' ||
        stripControl.param === 'dualPanRight')
    ) {
      return null;
    }
    return midiLearnStripControlTargetId(scope, stripControl.param);
  }
  return null;
}

/** Resolvers used to migrate legacy positional processor targets after load. */
export interface MidiLearnProcessorIdResolvers {
  insert(scope: MidiLearnScope, index: number): string | undefined;
  mastering(index: number): string | undefined;
}

/** Migrates one legacy insert/mastering target to its document-stable processor id. */
export function migrateMidiLearnTargetToProcessorId(
  id: string,
  resolvers: MidiLearnProcessorIdResolvers,
): string | null {
  const insert = parseMidiLearnInsertTargetId(id);
  if (insert) {
    if (insert.processorId !== undefined) return id;
    if (insert.index === undefined) return null;
    const processorId = resolvers.insert(insert.scope, insert.index);
    return processorId ? midiLearnInsertTargetId(insert.scope, processorId, insert.paramId) : null;
  }
  const mastering = parseMidiLearnMasteringTargetId(id);
  if (mastering) {
    if (mastering.processorId !== undefined) return id;
    if (mastering.index === undefined) return null;
    const processorId = resolvers.mastering(mastering.index);
    return processorId ? midiLearnMasteringTargetId(processorId, mastering.paramId) : null;
  }
  return id;
}

/** One persisted CC binding: the target id it drives plus the channel + controller. */
export interface PersistedMidiCcBinding {
  /**
   * Target id (see {@link midiLearnTargetId} and the insert/instrument
   * encoders). When {@link trackScoped} is true, the id's scope segment holds a
   * positional track index rather than a session track id.
   */
  target: string;
  /** MIDI channel (0-15). */
  channel: number;
  /** Controller number (0-127). */
  controller: number;
  /** Binding family. Omitted means a legacy CC binding. */
  kind?: 'cc' | 'rpn' | 'nrpn';
  /** RPN/NRPN parameter number (0-16383), when `kind` is not `cc`. */
  parameter?: number;
  /** True when `target`'s scope is a track index awaiting load-time rebinding. */
  trackScoped?: boolean;
}

/**
 * Sanitizes an untrusted persisted binding list (a document's `midiCcBindings`)
 * into well-formed entries. Drops entries whose target id does not decode to a
 * known target, whose channel/controller is out of range, or that repeat a
 * target already seen (first occurrence wins).
 *
 * @param value Candidate entry list; non-arrays yield [].
 * @returns A new array of well-formed bindings.
 */
export function sanitizeMidiCcBindings(value: unknown): PersistedMidiCcBinding[] {
  if (!Array.isArray(value)) return [];
  const out: PersistedMidiCcBinding[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as {
      target?: unknown;
      channel?: unknown;
      controller?: unknown;
      kind?: unknown;
      parameter?: unknown;
      trackScoped?: unknown;
    };
    if (typeof candidate.target !== 'string' || !isMidiLearnTargetId(candidate.target)) continue;
    if (seen.has(candidate.target)) continue;
    const channel = Number(candidate.channel);
    const controller = Number(candidate.controller);
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) continue;
    if (!Number.isInteger(controller) || controller < 0 || controller > MIDI_VALUE_MAX) continue;
    const kind =
      candidate.kind === 'rpn' || candidate.kind === 'nrpn' || candidate.kind === 'cc'
        ? candidate.kind
        : 'cc';
    let parameter: number | undefined;
    if (kind === 'rpn' || kind === 'nrpn') {
      const rawParameter = Number(candidate.parameter);
      if (!Number.isInteger(rawParameter) || rawParameter < 0 || rawParameter > 16383) continue;
      parameter = rawParameter;
    }
    seen.add(candidate.target);
    const binding: PersistedMidiCcBinding = { target: candidate.target, channel, controller };
    if (kind !== 'cc') {
      binding.kind = kind;
      binding.parameter = parameter;
    }
    if (candidate.trackScoped === true) binding.trackScoped = true;
    out.push(binding);
  }
  return out;
}
