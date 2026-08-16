import { describe, expect, it } from 'vitest';
import { DEFAULT_DRUM_KIT, gmDrumName, pitchName } from '@/ui/step-sequencer/drum-map';
import {
  clearedRow,
  createDrumPattern,
  createPitchPattern,
  DEFAULT_STEP_GATE,
  DEFAULT_STEP_VELOCITY,
  shiftedRow,
  toggledStep,
  withRowFill,
  withRowMuted,
  withStep,
  withStepCount,
  withSwing,
} from '@/ui/step-sequencer/pattern';

describe('drum map', () => {
  it('names the standard GM kit pitches', () => {
    expect(gmDrumName(35)).toBe('Acoustic Bass Drum');
    expect(gmDrumName(36)).toBe('Bass Drum 1');
    expect(gmDrumName(38)).toBe('Acoustic Snare');
    expect(gmDrumName(42)).toBe('Closed Hi-Hat');
    expect(gmDrumName(81)).toBe('Open Triangle');
  });

  it('names the GM2 pitches outside the GM1 key range', () => {
    expect(gmDrumName(27)).toBe('High Q');
    expect(gmDrumName(34)).toBe('Metronome Bell');
    expect(gmDrumName(82)).toBe('Shaker');
    expect(gmDrumName(87)).toBe('Open Surdo');
  });

  it('returns null outside the GM percussion range', () => {
    expect(gmDrumName(26)).toBeNull();
    expect(gmDrumName(88)).toBeNull();
  });

  it('names pitches with middle C as C4', () => {
    expect(pitchName(60)).toBe('C4');
    expect(pitchName(61)).toBe('C#4');
    expect(pitchName(48)).toBe('C3');
    expect(pitchName(0)).toBe('C-1');
  });
});

describe('createDrumPattern', () => {
  it('builds the default kit with inactive default steps', () => {
    const pattern = createDrumPattern();
    expect(pattern.mode).toBe('drum');
    expect(pattern.stepCount).toBe(16);
    expect(pattern.resolution).toBe('1/16');
    expect(pattern.swing).toBe(0);
    expect(pattern.rows).toHaveLength(DEFAULT_DRUM_KIT.length);
    expect(pattern.rows.at(-1)?.pitch).toBe(36);
    expect(pattern.rows.at(-1)?.name).toBe('Bass Drum 1');
    for (const row of pattern.rows) {
      expect(row.muted).toBe(false);
      expect(row.steps).toHaveLength(16);
      for (const step of row.steps) {
        expect(step).toEqual({
          active: false,
          velocity: DEFAULT_STEP_VELOCITY,
          gate: DEFAULT_STEP_GATE,
          offset: 0,
        });
      }
    }
  });
});

describe('createPitchPattern', () => {
  it('builds one chromatic octave, highest pitch first', () => {
    const pattern = createPitchPattern(48);
    expect(pattern.mode).toBe('pitch');
    expect(pattern.rows).toHaveLength(12);
    expect(pattern.rows[0]).toMatchObject({ pitch: 59, name: 'B3' });
    expect(pattern.rows[11]).toMatchObject({ pitch: 48, name: 'C3' });
  });

  it('clamps the root so the octave stays in MIDI range', () => {
    expect(createPitchPattern(125).rows[0].pitch).toBe(127);
    expect(createPitchPattern(-5).rows[11].pitch).toBe(0);
  });
});

describe('step edits', () => {
  it('toggledStep flips only the active flag', () => {
    const base = createDrumPattern();
    const on = toggledStep(base, 0, 3);
    expect(on.rows[0].steps[3].active).toBe(true);
    expect(on.rows[0].steps[3].velocity).toBe(DEFAULT_STEP_VELOCITY);
    expect(base.rows[0].steps[3].active).toBe(false);
    const off = toggledStep(on, 0, 3);
    expect(off.rows[0].steps[3].active).toBe(false);
  });

  it('withStep clamps velocity, gate and offset', () => {
    const base = createDrumPattern();
    const edited = withStep(base, 1, 0, { velocity: 500, gate: 9, offset: -3 });
    expect(edited.rows[1].steps[0]).toMatchObject({ velocity: 127, gate: 1, offset: -0.5 });
    const low = withStep(base, 1, 0, { velocity: 0, gate: 0 });
    expect(low.rows[1].steps[0].velocity).toBe(1);
    expect(low.rows[1].steps[0].gate).toBeCloseTo(0.05, 12);
  });

  it('rejects out-of-range row or step indices', () => {
    const base = createDrumPattern();
    expect(() => withStep(base, 99, 0, { active: true })).toThrow(RangeError);
    expect(() => withStep(base, 0, 99, { active: true })).toThrow(RangeError);
    expect(() => toggledStep(base, -1, 0)).toThrow(RangeError);
  });
});

describe('withStepCount', () => {
  it('truncates extra steps and keeps the rest intact', () => {
    let pattern = createDrumPattern(16);
    pattern = withStep(pattern, 0, 2, { active: true, velocity: 70 });
    const shorter = withStepCount(pattern, 8);
    expect(shorter.stepCount).toBe(8);
    expect(shorter.rows[0].steps).toHaveLength(8);
    expect(shorter.rows[0].steps[2]).toMatchObject({ active: true, velocity: 70 });
  });

  it('pads missing steps with defaults', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 7, { active: true });
    const longer = withStepCount(pattern, 32);
    expect(longer.rows[0].steps).toHaveLength(32);
    expect(longer.rows[0].steps[7].active).toBe(true);
    expect(longer.rows[0].steps[8].active).toBe(false);
  });
});

describe('withSwing', () => {
  it('clamps to the percent range', () => {
    const base = createDrumPattern();
    expect(withSwing(base, 150).swing).toBe(100);
    expect(withSwing(base, -20).swing).toBe(0);
    expect(withSwing(base, 55).swing).toBe(55);
  });
});

describe('row operations', () => {
  it('withRowMuted sets the flag without touching steps', () => {
    let pattern = createDrumPattern();
    pattern = withStep(pattern, 2, 0, { active: true });
    const muted = withRowMuted(pattern, 2, true);
    expect(muted.rows[2].muted).toBe(true);
    expect(muted.rows[2].steps[0].active).toBe(true);
  });

  it('clearedRow resets every step of one row only', () => {
    let pattern = createDrumPattern();
    pattern = withStep(pattern, 0, 1, { active: true, velocity: 50 });
    pattern = withStep(pattern, 1, 1, { active: true });
    const cleared = clearedRow(pattern, 0);
    expect(cleared.rows[0].steps[1]).toMatchObject({
      active: false,
      velocity: DEFAULT_STEP_VELOCITY,
    });
    expect(cleared.rows[1].steps[1].active).toBe(true);
  });

  it('shiftedRow rotates with wrap-around in both directions', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 0, { active: true, velocity: 64 });
    pattern = withStep(pattern, 0, 7, { active: true, velocity: 72 });

    const right = shiftedRow(pattern, 0, 1);
    expect(right.rows[0].steps[1]).toMatchObject({ active: true, velocity: 64 });
    expect(right.rows[0].steps[0]).toMatchObject({ active: true, velocity: 72 });

    const left = shiftedRow(pattern, 0, -1);
    expect(left.rows[0].steps[7]).toMatchObject({ active: true, velocity: 64 });
    expect(left.rows[0].steps[6]).toMatchObject({ active: true, velocity: 72 });
  });

  it('shiftedRow treats full rotations as identity', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 3, { active: true });
    expect(shiftedRow(pattern, 0, 8).rows[0]).toEqual(pattern.rows[0]);
    expect(shiftedRow(pattern, 0, -16).rows[0]).toEqual(pattern.rows[0]);
  });

  it('withRowFill replaces active flags but keeps stored values', () => {
    let pattern = createDrumPattern(8);
    pattern = withStep(pattern, 0, 1, { active: true, velocity: 40 });
    const filled = withRowFill(pattern, 0, [true, false, true]);
    expect(filled.rows[0].steps.map((step) => step.active)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(filled.rows[0].steps[1].velocity).toBe(40);
  });
});
