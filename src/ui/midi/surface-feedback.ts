/**
 * Outbound control-surface feedback: what the surface should be showing, and
 * the minimal set of messages that gets it there.
 *
 * The snapshot is deliberately a plain value with no store types in it, so the
 * diff can be exercised without a session. Only changes are emitted: a surface
 * fights the user's hand if a motor fader is re-driven on every mixer touch,
 * and re-lighting an already-lit lamp wastes the port's bandwidth.
 */

import type { SurfaceButton, SurfaceFeedback } from './surface-protocol';

/** What one bank slot should be showing. */
export interface SurfaceStripSnapshot {
  /** Fader position, normalized 0..1. */
  fader: number;
  /** Encoder ring position, normalized 0..1. */
  pan: number;
  /** Mute lamp. */
  mute: boolean;
  /** Solo lamp. */
  solo: boolean;
  /** Record-arm lamp. */
  armed: boolean;
  /** Select lamp (the focused track). */
  selected: boolean;
  /** Meter level, normalized 0..1. */
  meter: number;
}

/** What the whole surface should be showing. */
export interface SurfaceSnapshot {
  /** One entry per slot; null where the bank window is past the last track. */
  strips: ReadonlyArray<SurfaceStripSnapshot | null>;
  /** Master fader position, normalized 0..1. */
  master: number;
  /** Transport lamps. */
  play: boolean;
  /** Record lamp. */
  record: boolean;
  /** Cycle lamp. */
  loop: boolean;
}

/** A slot with no track behind it: everything dark and the fader at the bottom. */
const EMPTY_STRIP: SurfaceStripSnapshot = {
  fader: 0,
  pan: 0.5,
  mute: false,
  solo: false,
  armed: false,
  selected: false,
  meter: 0,
};

/** Resolution a surface fader actually reaches; finer changes are invisible. */
const FADER_STEPS = 16383;

function sameFader(a: number, b: number): boolean {
  return Math.round(a * FADER_STEPS) === Math.round(b * FADER_STEPS);
}

/** Meter segments a surface displays; below this a change cannot be shown. */
const METER_STEPS = 12;

function sameMeter(a: number, b: number): boolean {
  return Math.round(a * METER_STEPS) === Math.round(b * METER_STEPS);
}

/** Encoder ring positions a surface displays. */
const RING_STEPS = 10;

function sameRing(a: number, b: number): boolean {
  return Math.round(a * RING_STEPS) === Math.round(b * RING_STEPS);
}

function lamp(
  button: SurfaceButton,
  slot: number | undefined,
  on: boolean,
): SurfaceFeedback & { kind: 'led' } {
  return slot === undefined ? { kind: 'led', button, on } : { kind: 'led', button, slot, on };
}

/**
 * Computes the feedback needed to move the surface from one snapshot to another.
 *
 * @param previous What the surface is currently showing, or null when its state
 *   is unknown (first connection, bank change, protocol switch) — then every
 *   control is refreshed.
 * @param next What the surface should be showing.
 * @returns Feedback items in strip order, transport last.
 */
export function surfaceFeedbackDiff(
  previous: SurfaceSnapshot | null,
  next: SurfaceSnapshot,
): SurfaceFeedback[] {
  const out: SurfaceFeedback[] = [];
  next.strips.forEach((strip, slot) => {
    const target = strip ?? EMPTY_STRIP;
    const before = previous ? (previous.strips[slot] ?? EMPTY_STRIP) : null;
    if (!before || !sameFader(before.fader, target.fader)) {
      out.push({ kind: 'fader', slot, value: target.fader });
    }
    if (!before || !sameRing(before.pan, target.pan)) {
      out.push({ kind: 'vpotRing', slot, position: target.pan });
    }
    if (!before || before.mute !== target.mute) out.push(lamp('mute', slot, target.mute));
    if (!before || before.solo !== target.solo) out.push(lamp('solo', slot, target.solo));
    if (!before || before.armed !== target.armed) out.push(lamp('arm', slot, target.armed));
    if (!before || before.selected !== target.selected) {
      out.push(lamp('select', slot, target.selected));
    }
    if (!before || !sameMeter(before.meter, target.meter)) {
      out.push({ kind: 'meter', slot, level: target.meter });
    }
  });
  if (!previous || !sameFader(previous.master, next.master)) {
    out.push({ kind: 'masterFader', value: next.master });
  }
  if (!previous || previous.play !== next.play) out.push(lamp('play', undefined, next.play));
  if (!previous || previous.record !== next.record)
    out.push(lamp('record', undefined, next.record));
  if (!previous || previous.loop !== next.loop) out.push(lamp('loop', undefined, next.loop));
  return out;
}

/**
 * Feedback that returns the surface to a dark, centred state. Sent when a
 * surface is disconnected or the protocol is switched off, so its faders and
 * lamps do not stay frozen showing a session that is no longer driving them.
 *
 * @param slots Number of strips to clear.
 */
export function surfaceResetFeedback(slots: number): SurfaceFeedback[] {
  return surfaceFeedbackDiff(null, {
    strips: Array.from({ length: Math.max(0, slots) }, () => null),
    master: 0,
    play: false,
    record: false,
    loop: false,
  });
}
