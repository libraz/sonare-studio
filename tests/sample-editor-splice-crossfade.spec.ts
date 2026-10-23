import { describe, expect, it } from 'vitest';
import { cutCrossfadeFrames, spliceRange } from '../src/ui/sample-editor/ops';
import { pitchShiftRange, type SampleEditorWasmOps } from '../src/ui/sample-editor/wasm-ops';

const SAMPLE_RATE = 48000;

function tone(frames: number, hz: number, amp = 0.5): Float32Array {
  return Float32Array.from(
    { length: frames },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE),
  );
}

function maxStep(data: Float32Array, from: number, to: number): number {
  let step = 0;
  for (let i = from + 1; i < to; i += 1) step = Math.max(step, Math.abs(data[i] - data[i - 1]));
  return step;
}

describe('range splice crossfade', () => {
  const fade = cutCrossfadeFrames(SAMPLE_RATE);
  const range = { startFrame: 4800, endFrame: 9600 };

  it('keeps the length and leaves the outer audio untouched', () => {
    const input = [tone(14400, 440)];
    const replacement = [new Float32Array(2400).fill(0.5)];
    const out = spliceRange(input, range, replacement, fade);
    expect(out[0].length).toBe(14400 - 4800 + 2400);
    expect(Array.from(out[0].subarray(0, 4800))).toEqual(Array.from(input[0].subarray(0, 4800)));
    expect(Array.from(out[0].subarray(4800 + 2400))).toEqual(Array.from(input[0].subarray(9600)));
  });

  it('removes the step at both boundaries of a processed selection', () => {
    const input = [tone(14400, 440)];
    // A constant offset stands in for processed audio that does not meet the edges.
    const processed = [new Float32Array(4800).fill(0.4)];
    const hard = spliceRange(input, range, processed);
    const soft = spliceRange(input, range, processed, fade);
    const slope = maxStep(input[0], 0, 4800);
    for (const [from, to] of [
      [4800 - 2, 4800 + 2],
      [9600 - 2, 9600 + 2],
    ]) {
      expect(maxStep(hard[0], from, to)).toBeGreaterThan(slope * 5);
      expect(maxStep(soft[0], from, to)).toBeLessThan(slope * 1.5);
    }
  });

  it('leaves a whole-file replacement unchanged', () => {
    const input = [tone(2400, 440)];
    const processed = [tone(2400, 220)];
    const out = spliceRange(input, { startFrame: 0, endFrame: 2400 }, processed, fade);
    expect(Array.from(out[0])).toEqual(Array.from(processed[0]));
  });

  it('crossfades a ranged pitch shift through the wasm ops', () => {
    const input = [tone(14400, 440)];
    const mod: SampleEditorWasmOps = {
      pitchShift: (samples) => samples.map((v) => v + 0.4) as Float32Array,
    };
    const out = pitchShiftRange(mod, input, SAMPLE_RATE, 3, range);
    const slope = maxStep(input[0], 0, 4800);
    expect(maxStep(out[0], 4798, 4802)).toBeLessThan(slope * 1.5);
    expect(maxStep(out[0], 9598, 9602)).toBeLessThan(slope * 1.5);
  });
});
