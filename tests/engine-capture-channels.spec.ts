import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_ABI_VERSION,
  init,
  SonareRealtimeEngineWorkletProcessor,
} from '@/wasm/worklet.js';

/**
 * Capture-width spike: determines how many channels the bundled engine's input
 * capture can actually carry. The host merge path can only serve as many
 * distinct devices as the engine ingests input channels.
 *
 * The realtime worklet processor copies at most `channelCount` input channels
 * into the engine's per-channel scratch before rendering, and the input-capture
 * source reads those same scratch buffers. So requesting a wider capture buffer
 * (channels: 4) allocates the extra planar channels but they never receive
 * signal — capture is capped at the engine node channel width (2 by default).
 */

/**
 * Minimal stand-in for the native RealtimeEngine exposing only the methods the
 * worklet processor touches on the render path. It models input capture the way
 * the real engine does: capture reads the per-channel scratch the processor
 * fills, so channels the processor never writes stay silent.
 */
class FakeNativeEngine {
  static instances: FakeNativeEngine[] = [];
  channelBuffers: Float32Array[] = [];
  preparedChannels = 0;
  captureChannels = 0;
  captureAccum: number[][] = [];
  capturing = false;

  constructor() {
    FakeNativeEngine.instances.push(this);
  }

  prepareChannels(numChannels: number, maxFrames: number): void {
    this.preparedChannels = numChannels;
    this.channelBuffers = Array.from({ length: numChannels }, () => new Float32Array(maxFrames));
  }

  getChannelBuffer(channel: number): Float32Array {
    return this.channelBuffers[channel];
  }

  processPrepared(frames: number): void {
    if (!this.capturing) return;
    for (let ch = 0; ch < this.captureChannels; ch++) {
      const buffer = this.channelBuffers[ch];
      this.captureAccum[ch] ??= [];
      const accum = this.captureAccum[ch];
      for (let i = 0; i < frames; i++) accum.push(buffer ? buffer[i] : 0);
    }
  }

  setCaptureBuffer(numChannels: number): void {
    this.captureChannels = numChannels;
    this.captureAccum = Array.from({ length: numChannels }, () => []);
  }

  setCaptureSource(): void {}
  setRecordOffsetSamples(): void {}
  setInputMonitor(): void {}
  armCapture(armed: boolean): void {
    this.capturing = armed;
  }

  capturedAudio(): Float32Array[] {
    return this.captureAccum.map((channel) => new Float32Array(channel));
  }

  drainTelemetry(): unknown[] {
    return [];
  }
}

/** Peak absolute sample of a channel buffer. */
function peak(channel: Float32Array): number {
  let max = 0;
  for (const sample of channel) max = Math.max(max, Math.abs(sample));
  return max;
}

afterEach(() => {
  FakeNativeEngine.instances = [];
});

describe('engine input-capture channel width', () => {
  it('ingests only channelCount input channels regardless of the requested capture width', async () => {
    await init({
      moduleFactory: () => ({
        abiVersion: () => EXPECTED_ABI_VERSION,
        RealtimeEngine: FakeNativeEngine,
        engineAbiVersion: () => 3,
      }),
    });

    const FRAMES = 4;
    const processor = new SonareRealtimeEngineWorkletProcessor({
      sampleRate: 48000,
      blockSize: FRAMES,
      channelCount: 2,
    });
    const engine = FakeNativeEngine.instances[0];
    expect(engine).toBeDefined();
    expect(engine.preparedChannels).toBe(2);

    // Request a 4-channel capture buffer (what a 4-device host merge would ask
    // for) through the same syncCapture path the recorder uses.
    processor.receiveSync({
      type: 'syncCapture',
      channels: 4,
      bufferFrames: FRAMES,
      source: 'input',
      recordOffsetSamples: 0,
      inputMonitor: { enabled: false, gain: 1 },
    });
    engine.capturing = true;

    // Feed four distinct constant input channels.
    const inputs = [
      [
        new Float32Array(FRAMES).fill(0.1),
        new Float32Array(FRAMES).fill(0.2),
        new Float32Array(FRAMES).fill(0.3),
        new Float32Array(FRAMES).fill(0.4),
      ],
    ];
    const outputs = [[new Float32Array(FRAMES), new Float32Array(FRAMES)]];
    processor.process(inputs, outputs);

    const captured = engine.capturedAudio();
    // The capture buffer is allocated for all four requested channels...
    expect(captured).toHaveLength(4);
    // ...but only the first two carry real input; the rest stay silent because
    // the processor never copies input channels beyond the engine width.
    expect(peak(captured[0])).toBeCloseTo(0.1, 6);
    expect(peak(captured[1])).toBeCloseTo(0.2, 6);
    expect(peak(captured[2])).toBe(0);
    expect(peak(captured[3])).toBe(0);
  });
});
