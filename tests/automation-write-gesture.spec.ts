import { describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@/project/automation';
import { busAutomationTarget } from '@/project/automation';
import {
  AUTOMATION_WRITE_REPLACE_WINDOW_PPQ,
  AUTOMATION_WRITE_THROTTLE_PPQ,
  type AutomationWriteMode,
  automationStripMode,
  createAutomationWriteGesture,
  disengageAutomationWriteModes,
  isAutomationWriteMode,
  resetAutomationStripModes,
  setAutomationStripMode,
  toggleAutomationStripMode,
} from '@/ui/mixer/automation-mode';

/**
 * Builds a gesture with a controllable playhead and transport flag, capturing
 * the single committed point list.
 */
function harness(mode: AutomationWriteMode, existingPoints: AutomationPoint[], playing = false) {
  let position = 0;
  const commits: AutomationPoint[][] = [];
  const gesture = createAutomationWriteGesture({
    mode,
    existingPoints,
    positionPpq: () => position,
    isPlaying: () => playing,
    commit: (points) => commits.push(points),
  });
  return {
    gesture,
    commits,
    seek(ppq: number) {
      position = ppq;
    },
  };
}

describe('isAutomationWriteMode', () => {
  it('is true only for the write-class modes', () => {
    expect(isAutomationWriteMode('touch')).toBe(true);
    expect(isAutomationWriteMode('latch')).toBe(true);
    expect(isAutomationWriteMode('read')).toBe(false);
    expect(isAutomationWriteMode('off')).toBe(false);
  });
});

describe('automation strip modes', () => {
  it('toggles read, touch and latch as mutually exclusive strip modes', () => {
    resetAutomationStripModes();

    toggleAutomationStripMode(1, 'read');
    expect(automationStripMode(1)).toBe('read');

    toggleAutomationStripMode(1, 'touch');
    expect(automationStripMode(1)).toBe('touch');

    toggleAutomationStripMode(1, 'latch');
    expect(automationStripMode(1)).toBe('latch');

    toggleAutomationStripMode(1, 'latch');
    expect(automationStripMode(1)).toBe('off');
  });

  it('drops bus write modes back to read on transport stop', () => {
    const target = busAutomationTarget('fx');
    resetAutomationStripModes();

    setAutomationStripMode(target, 'touch');
    disengageAutomationWriteModes();

    expect(automationStripMode(target)).toBe('read');
  });
});

describe('createAutomationWriteGesture', () => {
  it('commits nothing when ended without an update', () => {
    const { gesture, commits } = harness('touch', [{ ppq: 4, value: 1 }]);
    gesture.end();
    expect(commits).toEqual([]);
  });

  it('touch keeps existing points on both sides of a stationary breakpoint', () => {
    const existing: AutomationPoint[] = [
      { ppq: 0, value: -6 },
      { ppq: 4, value: 0 },
      { ppq: 8, value: 6 },
    ];
    const h = harness('touch', existing);
    h.seek(4);
    h.gesture.update(3);
    h.gesture.end();
    // The ±window around ppq 4 drops the point at 4; 0 and 8 are read back.
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]).toEqual([
      { ppq: 0, value: -6 },
      { ppq: 8, value: 6 },
      { ppq: 4, value: 3 },
    ]);
  });

  it('latch keeps points before the touched span but drops everything after', () => {
    const existing: AutomationPoint[] = [
      { ppq: 0, value: -6 },
      { ppq: 4, value: 0 },
      { ppq: 8, value: 6 },
    ];
    const h = harness('latch', existing);
    h.seek(4);
    h.gesture.update(3);
    h.gesture.end();
    // ppq 8 is dropped, so the latched value at ppq 4 holds to the lane end.
    expect(h.commits[0]).toEqual([
      { ppq: 0, value: -6 },
      { ppq: 4, value: 3 },
    ]);
  });

  it('touch replaces only the recorded span while playing', () => {
    const existing: AutomationPoint[] = [
      { ppq: 0, value: 0 },
      { ppq: 1, value: 0 },
      { ppq: 5, value: 9 },
    ];
    const h = harness('touch', existing, true);
    h.seek(2);
    h.gesture.update(1);
    h.seek(2 + AUTOMATION_WRITE_THROTTLE_PPQ);
    h.gesture.update(2);
    h.gesture.end();
    // Recorded span [2, 2.0625]: the existing 0 and 5 points survive (5 > hi).
    expect(h.commits[0]).toEqual([
      { ppq: 0, value: 0 },
      { ppq: 1, value: 0 },
      { ppq: 5, value: 9 },
      { ppq: 2, value: 1 },
      { ppq: 2 + AUTOMATION_WRITE_THROTTLE_PPQ, value: 2 },
    ]);
  });

  it('emits every playing update to the realtime schedule hook with sample positions', () => {
    let ppq = 0;
    let sample = 0;
    const scheduled: Array<{ ppq: number; samplePos?: number; value: number }> = [];
    const commits: AutomationPoint[][] = [];
    const gesture = createAutomationWriteGesture({
      mode: 'touch',
      existingPoints: [],
      positionPpq: () => ppq,
      positionSample: () => sample,
      isPlaying: () => true,
      schedule: (event) => scheduled.push(event),
      commit: (points) => commits.push(points),
    });

    gesture.update(1);
    ppq += AUTOMATION_WRITE_THROTTLE_PPQ / 2;
    sample += 32;
    gesture.update(2);
    ppq += AUTOMATION_WRITE_THROTTLE_PPQ / 2;
    sample += 32;
    gesture.update(3);
    gesture.end();

    expect(scheduled).toEqual([
      { ppq: 0, samplePos: 0, value: 1 },
      { ppq: AUTOMATION_WRITE_THROTTLE_PPQ / 2, samplePos: 32, value: 2 },
      { ppq: AUTOMATION_WRITE_THROTTLE_PPQ, samplePos: 64, value: 3 },
    ]);
    // Lane commits stay PPQ-throttled even though realtime scheduling sees
    // every drag update.
    expect(commits[0]).toEqual([
      { ppq: 0, value: 1 },
      { ppq: AUTOMATION_WRITE_THROTTLE_PPQ, value: 3 },
    ]);
  });

  it('latch drops every existing point from the recorded span onward while playing', () => {
    const existing: AutomationPoint[] = [
      { ppq: 0, value: 0 },
      { ppq: 1, value: 0 },
      { ppq: 5, value: 9 },
    ];
    const h = harness('latch', existing, true);
    h.seek(2);
    h.gesture.update(1);
    h.seek(2 + AUTOMATION_WRITE_THROTTLE_PPQ);
    h.gesture.update(2);
    h.gesture.end();
    // ppq 5 is dropped; only points before lo (2) survive.
    expect(h.commits[0]).toEqual([
      { ppq: 0, value: 0 },
      { ppq: 1, value: 0 },
      { ppq: 2, value: 1 },
      { ppq: 2 + AUTOMATION_WRITE_THROTTLE_PPQ, value: 2 },
    ]);
  });

  it('touch keeps only the latest loop pass when the playhead wraps backward', () => {
    const h = harness('touch', [], true);
    h.seek(3);
    h.gesture.update(1);
    h.seek(3 + AUTOMATION_WRITE_THROTTLE_PPQ);
    h.gesture.update(2);
    h.seek(1);
    h.gesture.update(9);
    h.seek(1 + AUTOMATION_WRITE_THROTTLE_PPQ);
    h.gesture.update(10);
    h.gesture.end();

    expect(h.commits[0]).toEqual([
      { ppq: 1, value: 9 },
      { ppq: 1 + AUTOMATION_WRITE_THROTTLE_PPQ, value: 10 },
    ]);
  });

  it('latch keeps only the latest loop pass before merging with existing points', () => {
    const h = harness(
      'latch',
      [
        { ppq: 0.5, value: -12 },
        { ppq: 4, value: -3 },
      ],
      true,
    );
    h.seek(3);
    h.gesture.update(1);
    h.seek(3 + AUTOMATION_WRITE_THROTTLE_PPQ);
    h.gesture.update(2);
    h.seek(1);
    h.gesture.update(9);
    h.gesture.end();

    expect(h.commits[0]).toEqual([
      { ppq: 0.5, value: -12 },
      { ppq: 1, value: 9 },
    ]);
  });

  it('latch single-breakpoint window matches the touch lower bound', () => {
    // A point just before the ±window lower bound is kept; one inside is dropped.
    const existing: AutomationPoint[] = [
      { ppq: 4 - AUTOMATION_WRITE_REPLACE_WINDOW_PPQ - 0.01, value: -3 },
      { ppq: 4 - AUTOMATION_WRITE_REPLACE_WINDOW_PPQ + 0.001, value: 2 },
    ];
    const h = harness('latch', existing);
    h.seek(4);
    h.gesture.update(0);
    h.gesture.end();
    expect(h.commits[0]).toEqual([
      { ppq: 4 - AUTOMATION_WRITE_REPLACE_WINDOW_PPQ - 0.01, value: -3 },
      { ppq: 4, value: 0 },
    ]);
  });
});
