import * as wasm from '@libraz/libsonare';
import { beforeAll, describe, expect, it } from 'vitest';
import { coreWasmBinary } from './core-package';

beforeAll(async () => {
  await wasm.init({
    wasmBinary: coreWasmBinary(),
  } as Parameters<typeof wasm.init>[0]);
});

describe('vendored engine integration contracts', () => {
  it.each([true, false])('adds source and clip in one native undo entry (MIDI=%s)', (isMidi) => {
    const project = new wasm.Project();
    try {
      const trackId = project.addTrack({ name: 'Existing track', kind: isMidi ? 'midi' : 'audio' });
      const before = project.toJson();
      project.addClip({
        trackId,
        isMidi,
        startPpq: 0,
        lengthPpq: 4,
        ...(isMidi ? {} : { channels: [new Float32Array(8)], sampleRate: 48_000 }),
      });
      const after = project.toJson();
      expect(after).not.toBe(before);
      project.undo();
      expect(project.toJson()).toBe(before);
      project.redo();
      expect(project.toJson()).toBe(after);
    } finally {
      project.destroy();
    }
  });

  it('filters frequencies above the detector Nyquist limit when reducing sample rate', () => {
    const energy = (frequency: number): number => {
      const input = Float32Array.from({ length: 96_000 }, (_, frame) =>
        Math.sin((2 * Math.PI * frequency * frame) / 96_000),
      );
      const output = wasm.resample(input, 96_000, 48_000);
      expect(output).toHaveLength(48_000);
      const interior = output.subarray(100, output.length - 100);
      return Math.sqrt(
        interior.reduce((sum, sample) => sum + sample * sample, 0) / interior.length,
      );
    };
    const audible = energy(1_000);
    const ultrasonic = energy(30_000);
    expect(audible).toBeGreaterThan(0.6);
    expect(ultrasonic / audible).toBeLessThan(0.001);
  });
});
