import { describe, expect, it } from 'vitest';
import {
  type SurfaceSnapshot,
  type SurfaceStripSnapshot,
  surfaceFeedbackDiff,
  surfaceResetFeedback,
} from '@/ui/midi/surface-feedback';

function strip(overrides: Partial<SurfaceStripSnapshot> = {}): SurfaceStripSnapshot {
  return {
    fader: 0.5,
    pan: 0.5,
    mute: false,
    solo: false,
    armed: false,
    selected: false,
    meter: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return {
    strips: [strip(), strip()],
    master: 0.75,
    play: false,
    record: false,
    loop: false,
    ...overrides,
  };
}

describe('surface feedback diff', () => {
  it('refreshes every control when the surface state is unknown', () => {
    const items = surfaceFeedbackDiff(null, snapshot());
    // Two strips × (fader, ring, mute, solo, arm, select, meter) + master + 3 transport lamps.
    expect(items).toHaveLength(2 * 7 + 4);
    expect(items[0]).toEqual({ kind: 'fader', slot: 0, value: 0.5 });
    expect(items.at(-1)).toEqual({ kind: 'led', button: 'loop', on: false });
  });

  it('emits nothing when nothing changed', () => {
    const state = snapshot();
    expect(surfaceFeedbackDiff(state, snapshot())).toEqual([]);
  });

  it('emits only the controls that moved', () => {
    const before = snapshot();
    const after = snapshot({ strips: [strip(), strip({ mute: true, fader: 0.25 })], play: true });

    expect(surfaceFeedbackDiff(before, after)).toEqual([
      { kind: 'fader', slot: 1, value: 0.25 },
      { kind: 'led', button: 'mute', slot: 1, on: true },
      { kind: 'led', button: 'play', on: true },
    ]);
  });

  it('ignores changes finer than the surface can show', () => {
    const before = snapshot();
    // Well under one step of a 14-bit fader: re-driving the motor here would
    // fight the user's hand for no visible gain.
    const after = snapshot({ strips: [strip({ fader: 0.5 + 1e-6 }), strip()] });
    expect(surfaceFeedbackDiff(before, after)).toEqual([]);
  });

  it('darkens a slot the bank window no longer covers', () => {
    const before = snapshot({ strips: [strip({ fader: 1, mute: true }), strip()] });
    const after = snapshot({ strips: [null, strip()] });

    expect(surfaceFeedbackDiff(before, after)).toEqual([
      { kind: 'fader', slot: 0, value: 0 },
      { kind: 'led', button: 'mute', slot: 0, on: false },
    ]);
  });

  it('resets a surface that is being released', () => {
    const items = surfaceResetFeedback(2);
    expect(items.filter((item) => item.kind === 'fader')).toEqual([
      { kind: 'fader', slot: 0, value: 0 },
      { kind: 'fader', slot: 1, value: 0 },
    ]);
    expect(items).toContainEqual({ kind: 'masterFader', value: 0 });
    expect(items.every((item) => item.kind !== 'led' || item.on === false)).toBe(true);
  });
});
