import { describe, expect, it, vi } from 'vitest';
import { createRecorder } from '@/engine/recorder';
import { fakeEngineHandle } from './fakes/engine';

vi.mock('@/lib/wasm', () => ({ ensureWasm: vi.fn(async () => ({})) }));

function setup() {
  const configureCapture = vi.fn();
  const handle = fakeEngineHandle({
    engine: {
      setInputMonitor: vi.fn(),
      node: { numberOfOutputs: 1 },
      configureCapture,
      armCapture: vi.fn(),
      resetCapture: vi.fn(async () => {}),
      captureStatus: vi.fn(async () => ({})),
      capturedAudio: vi.fn(async () => []),
      onMeter: vi.fn(() => () => {}),
    },
    ctx: { sampleRate: 100, baseLatency: 0 },
  });
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ channelCount: 2 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const recorder = createRecorder(handle, {
    getUserMedia: vi.fn(async () => stream),
    bindInput: vi.fn(async (_c, _n, opts: { stream: MediaStream }) => ({
      stream: opts.stream,
      source: {} as AudioNode,
      destroy: vi.fn(),
    })),
  });
  return { recorder, configureCapture };
}

describe('recorder punchOutPpq', () => {
  it('punches out at the requested PPQ when no max duration is given', async () => {
    const { recorder, configureCapture } = setup();
    await recorder.requestMicrophone();
    recorder.arm(1);
    await recorder.start({ startPpq: 0, tempoBpm: 120, punchOutPpq: 8 });
    // 8 PPQ at 120 BPM = 4 s; at 100 Hz the buffer is 400 frames.
    expect(configureCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({ capacityFrames: 400, punch: { startPpq: 0, endPpq: 8 } }),
    );
  });
});
