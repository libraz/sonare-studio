/**
 * Control-surface configuration and bank-window arithmetic.
 *
 * A control surface has a fixed number of physical strips (usually eight) and
 * pages them over the session's tracks. Bindings therefore address a *slot*
 * rather than a track (`bank:0:gain`), and the slot is resolved through the
 * window defined here at the moment a message arrives. Everything in this
 * module is pure so live input, outbound feedback and persistence all agree on
 * which track a slot points at.
 */

import { SURFACE_STRIP_COUNT } from '@/ui/midi/surface-protocol';
import { MAX_CONTROL_SURFACE_SLOTS } from './midi-learn-targets';

/**
 * Native protocol spoken by the surface. `none` leaves the surface to the
 * generic MIDI-learn path (a controller sending plain CC), which needs no
 * protocol decoding at all.
 */
export type ControlSurfaceProtocol = 'none' | 'mcu' | 'hui';

/** All selectable protocols, in menu order. */
export const CONTROL_SURFACE_PROTOCOLS: ReadonlyArray<ControlSurfaceProtocol> = [
  'none',
  'mcu',
  'hui',
];

/** Default number of physical strips assumed for a surface. */
export const DEFAULT_CONTROL_SURFACE_BANK_SIZE = 8;

/** Persisted control-surface configuration. */
export interface ControlSurfaceSettings {
  /** Native protocol to decode, or `none` for plain learned CC. */
  protocol: ControlSurfaceProtocol;
  /** Physical strips on the surface (1..{@link MAX_CONTROL_SURFACE_SLOTS}). */
  bankSize: number;
  /** Index of the track shown on slot 0. */
  bankOffset: number;
  /** Web MIDI input port id the surface talks on, or null. */
  inputPortId: string | null;
  /** Web MIDI output port id feedback is sent to, or null. */
  outputPortId: string | null;
  /** Whether to mirror mixer state back to the surface. */
  feedback: boolean;
}

/** Configuration a project starts with: no surface, generic learn only. */
export function defaultControlSurfaceSettings(): ControlSurfaceSettings {
  return {
    protocol: 'none',
    bankSize: DEFAULT_CONTROL_SURFACE_BANK_SIZE,
    bankOffset: 0,
    inputPortId: null,
    outputPortId: null,
    feedback: false,
  };
}

/** True when the settings differ from the defaults and are worth persisting. */
export function controlSurfaceSettingsAreDefault(settings: ControlSurfaceSettings): boolean {
  const defaults = defaultControlSurfaceSettings();
  return (
    settings.protocol === defaults.protocol &&
    settings.bankSize === defaults.bankSize &&
    settings.bankOffset === defaults.bankOffset &&
    settings.inputPortId === null &&
    settings.outputPortId === null &&
    settings.feedback === defaults.feedback
  );
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function portId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalizes untrusted persisted settings, falling back to the defaults field
 * by field so one bad value cannot discard a whole configuration.
 *
 * @param value Candidate settings object from a loaded document.
 * @returns Well-formed settings.
 */
export function sanitizeControlSurfaceSettings(value: unknown): ControlSurfaceSettings {
  const defaults = defaultControlSurfaceSettings();
  if (typeof value !== 'object' || value === null) return defaults;
  const record = value as Record<string, unknown>;
  return {
    protocol: CONTROL_SURFACE_PROTOCOLS.includes(record.protocol as ControlSurfaceProtocol)
      ? (record.protocol as ControlSurfaceProtocol)
      : defaults.protocol,
    bankSize: clampInteger(record.bankSize, 1, MAX_CONTROL_SURFACE_SLOTS, defaults.bankSize),
    bankOffset: clampInteger(record.bankOffset, 0, Number.MAX_SAFE_INTEGER, defaults.bankOffset),
    inputPortId: portId(record.inputPortId),
    outputPortId: portId(record.outputPortId),
    feedback: record.feedback === true,
  };
}

/**
 * Clamps a bank offset so the window stays inside the track list, preferring a
 * full bank at the end rather than a window that runs off it.
 *
 * @param offset Requested index of the track on slot 0.
 * @param trackCount Number of tracks in the session.
 * @param bankSize Physical strips on the surface.
 * @returns The largest valid offset not greater than `offset`.
 */
export function clampBankOffset(offset: number, trackCount: number, bankSize: number): number {
  if (!Number.isFinite(offset)) return 0;
  const size = Math.max(1, Math.floor(bankSize));
  const highest = Math.max(0, trackCount - size);
  return Math.min(highest, Math.max(0, Math.floor(offset)));
}

/**
 * Tracks one bank step moves over: the full bank size without a protocol, but
 * never more than the strips an MCU/HUI surface physically addresses.
 */
export function bankPagingSize(
  surface: Pick<ControlSurfaceSettings, 'protocol' | 'bankSize'>,
): number {
  return surface.protocol === 'none'
    ? surface.bankSize
    : Math.min(SURFACE_STRIP_COUNT, surface.bankSize);
}

/** Offset after paging one bank towards the end of the track list. */
export function nextBankOffset(offset: number, trackCount: number, bankSize: number): number {
  const size = Math.max(1, Math.floor(bankSize));
  return clampBankOffset(clampBankOffset(offset, trackCount, size) + size, trackCount, size);
}

/** Offset after paging one bank towards the start of the track list. */
export function previousBankOffset(offset: number, trackCount: number, bankSize: number): number {
  const size = Math.max(1, Math.floor(bankSize));
  return clampBankOffset(clampBankOffset(offset, trackCount, size) - size, trackCount, size);
}

/**
 * Resolves the bank window onto concrete tracks.
 *
 * @param trackIds Session track ids in display order.
 * @param offset Index of the track on slot 0.
 * @param bankSize Physical strips on the surface.
 * @returns One entry per slot; null where the window runs past the last track,
 *   so a surface wider than the session leaves its extra strips inert rather
 *   than wrapping onto a track the user is not looking at.
 */
export function bankWindow(
  trackIds: readonly number[],
  offset: number,
  bankSize: number,
): Array<number | null> {
  const size = Math.max(1, Math.min(MAX_CONTROL_SURFACE_SLOTS, Math.floor(bankSize)));
  const start = clampBankOffset(offset, trackIds.length, size);
  const window: Array<number | null> = [];
  for (let slot = 0; slot < size; slot += 1) {
    window.push(trackIds[start + slot] ?? null);
  }
  return window;
}

/** Track a slot currently addresses, or null when the slot is past the end. */
export function bankSlotTrackId(
  trackIds: readonly number[],
  offset: number,
  bankSize: number,
  slot: number,
): number | null {
  if (!Number.isInteger(slot) || slot < 0) return null;
  return bankWindow(trackIds, offset, bankSize)[slot] ?? null;
}
