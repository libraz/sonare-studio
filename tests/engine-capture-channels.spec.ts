import { init, SonareRealtimeEngineWorkletProcessor } from '@libraz/libsonare/worklet';
import { beforeAll, describe, expect, it } from 'vitest';
import { coreWasmBinary } from './core-package';

/** `SonareEngineCommandType.ArmRecord`; the enum is not exported from the worklet entry. */
const ARM_RECORD = 13;

beforeAll(async () => {
  await init({
    wasmBinary: coreWasmBinary(),
  } as Parameters<typeof init>[0]);
});

/** Peak absolute sample of a channel buffer. */
function peak(channel: Float32Array): number {
  let max = 0;
  for (const sample of channel) max = Math.max(max, Math.abs(sample));
  return max;
}

/**
 * Capture-width spike, run against the real engine: determines how many
 * channels the engine's input capture can actually carry. The host merge path
 * can only serve as many distinct devices as the engine ingests input channels.
 *
 * The realtime worklet processor copies at most `numChannels` input channels
 * into the engine's per-channel scratch before rendering, and the input-capture
 * source reads those same scratch buffers. So requesting a wider capture buffer
 * (channels: 4) allocates the extra planar channels but they never receive
 * signal: capture is capped at the engine node channel width (2 by default).
 */
describe('engine input-capture channel width', () => {
  it('ingests only numChannels input channels regardless of the requested capture width', () => {
    const FRAMES = 128;
    const replies: unknown[] = [];
    const processor = new SonareRealtimeEngineWorkletProcessor({
      sampleRate: 48000,
      maxBlockSize: FRAMES,
      numChannels: 2,
      transport: { postMessage: (message) => replies.push(message) },
    });
    try {
      // Request a 4-channel capture buffer (what a 4-device host merge would ask
      // for) through the same syncCapture path the recorder uses.
      processor.receiveMessage({
        type: 'syncCapture',
        channels: 4,
        bufferFrames: FRAMES * 4,
        source: 'input',
        recordOffsetSamples: 0,
      });
      processor.receiveMessage({ type: ARM_RECORD, targetId: 0, renderFrame: -1, argInt: 1 });

      // Feed four distinct constant input channels.
      const inputs = [[0.1, 0.2, 0.3, 0.4].map((level) => new Float32Array(FRAMES).fill(level))];
      const outputs = [[new Float32Array(FRAMES), new Float32Array(FRAMES)]];
      processor.process(inputs, outputs);

      processor.receiveMessage({ type: 'captureRequest', requestId: 2, op: 'status' });
      expect(replies).toContainEqual({
        type: 'captureResponse',
        requestId: 2,
        ok: true,
        status: {
          capturedFrames: FRAMES,
          droppedFrames: 0,
          armed: true,
          punchEnabled: false,
          source: 'input',
          recordOffsetSamples: 0,
        },
      });
      processor.receiveMessage({ type: 'captureRequest', requestId: 1, op: 'read' });
      const response = replies.find(
        (reply): reply is { ok: true; channels: Float32Array[] } =>
          (reply as { requestId?: number }).requestId === 1,
      );
      const captured = response?.channels ?? [];
      // The capture buffer is allocated for all four requested channels...
      expect(captured).toHaveLength(4);
      // ...but only the first two carry real input; the rest stay silent because
      // the processor never copies input channels beyond the engine width.
      expect(peak(captured[0])).toBeCloseTo(0.1, 6);
      expect(peak(captured[1])).toBeCloseTo(0.2, 6);
      expect(peak(captured[2])).toBe(0);
      expect(peak(captured[3])).toBe(0);
    } finally {
      processor.destroy();
    }
  });
});
