import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useWebMidi } from '@/composables/useWebMidi';

class FakeMidiInput {
  readonly listeners = new Set<(event: { data: Uint8Array; timeStamp: number }) => void>();
  onmidimessage: ((event: { data: Uint8Array; timeStamp: number }) => void) | null = null;

  addEventListener(
    type: string,
    listener: (event: { data: Uint8Array; timeStamp: number }) => void,
  ): void {
    if (type === 'midimessage') this.listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: { data: Uint8Array; timeStamp: number }) => void,
  ): void {
    if (type === 'midimessage') this.listeners.delete(listener);
  }

  send(data: number[], timeStamp = 100): void {
    const event = { data: Uint8Array.from(data), timeStamp };
    this.onmidimessage?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

class FakeLegacyMidiInput {
  onmidimessage: ((event: { data: Uint8Array; timeStamp: number }) => void) | null = null;

  send(data: number[], timeStamp = 100): void {
    this.onmidimessage?.({ data: Uint8Array.from(data), timeStamp });
  }
}

const wasmMock = vi.hoisted(() => ({
  input: null as FakeMidiInput | FakeLegacyMidiInput | null,
  close: vi.fn(),
  bindWebMidi: vi.fn(),
  isWebMidiAvailable: vi.fn(() => true),
}));

vi.mock('@/lib/wasm', () => ({
  ensureWasm: async () => ({
    isWebMidiAvailable: wasmMock.isWebMidiAvailable,
    bindWebMidi: wasmMock.bindWebMidi,
  }),
}));

function makeBinding(input: FakeMidiInput | FakeLegacyMidiInput) {
  return {
    access: { inputs: new Map([['input-1', input]]) },
    inputs: () => [{ id: 'input-1', name: 'Controller' }],
    close: wasmMock.close,
  };
}

beforeEach(() => {
  wasmMock.input = new FakeMidiInput();
  wasmMock.close.mockClear();
  wasmMock.isWebMidiAvailable.mockReturnValue(true);
  wasmMock.bindWebMidi.mockReset();
  wasmMock.bindWebMidi.mockImplementation(async () => makeBinding(wasmMock.input as FakeMidiInput));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWebMidi', () => {
  it('decodes 14-bit CC pairs before routing control-change callbacks', async () => {
    const onControlChange = vi.fn();
    const scope = effectScope();
    let webMidi!: ReturnType<typeof useWebMidi>;
    scope.run(() => {
      webMidi = useWebMidi({ onControlChange });
    });

    await webMidi.connect({} as never);
    wasmMock.input?.send([0xb0, 1, 64], 10);
    wasmMock.input?.send([0xb0, 33, 5], 11);

    expect(onControlChange).toHaveBeenNthCalledWith(1, {
      channel: 0,
      controller: 1,
      value: 64,
      value14: 8192,
      timeStampMs: 10,
    });
    expect(onControlChange).toHaveBeenNthCalledWith(2, {
      channel: 0,
      controller: 1,
      value: 64,
      value14: 8197,
      timeStampMs: 11,
    });

    scope.stop();
    expect(wasmMock.close).toHaveBeenCalledTimes(1);
  });

  it('decodes RPN data entry with parameter and high-resolution value', async () => {
    const onControlChange = vi.fn();
    const webMidi = useWebMidi({ onControlChange });

    await webMidi.connect({} as never);
    wasmMock.input?.send([0xb2, 101, 0], 20);
    wasmMock.input?.send([0xb2, 100, 2], 21);
    wasmMock.input?.send([0xb2, 6, 64], 22);
    wasmMock.input?.send([0xb2, 38, 5], 23);

    expect(onControlChange).toHaveBeenNthCalledWith(3, {
      channel: 2,
      controller: 6,
      value: 64,
      value14: 8192,
      kind: 'rpn',
      parameter: 2,
      timeStampMs: 22,
    });
    expect(onControlChange).toHaveBeenNthCalledWith(4, {
      channel: 2,
      controller: 6,
      value: 64,
      value14: 8197,
      kind: 'rpn',
      parameter: 2,
      timeStampMs: 23,
    });

    webMidi.disconnect();
  });

  it('removes EventTarget midimessage listeners on disconnect', async () => {
    const onNoteOn = vi.fn();
    const webMidi = useWebMidi({ onNoteOn });

    await webMidi.connect({} as never);
    expect((wasmMock.input as FakeMidiInput).listeners.size).toBe(1);

    webMidi.disconnect();
    expect((wasmMock.input as FakeMidiInput).listeners.size).toBe(0);

    wasmMock.input?.send([0x90, 60, 100], 30);
    expect(onNoteOn).not.toHaveBeenCalled();
  });

  it('chains and restores legacy onmidimessage handlers', async () => {
    const previous = vi.fn();
    const legacy = new FakeLegacyMidiInput();
    legacy.onmidimessage = previous;
    wasmMock.input = legacy;
    const onNoteOn = vi.fn();
    const webMidi = useWebMidi({ onNoteOn });

    await webMidi.connect({} as never);
    legacy.send([0x90, 64, 90], 40);

    expect(previous).toHaveBeenCalledWith({
      data: Uint8Array.from([0x90, 64, 90]),
      timeStamp: 40,
    });
    expect(onNoteOn).toHaveBeenCalledWith({ pitch: 64, velocity: 90, channel: 0, timeStampMs: 40 });

    webMidi.disconnect();
    expect(legacy.onmidimessage).toBe(previous);
  });

  it('returns unavailable without binding when Web MIDI is absent', async () => {
    wasmMock.isWebMidiAvailable.mockReturnValue(false);
    const webMidi = useWebMidi();

    await expect(webMidi.connect({} as never)).resolves.toBe(false);

    expect(webMidi.available.value).toBe(false);
    expect(webMidi.connected.value).toBe(false);
    expect(wasmMock.bindWebMidi).not.toHaveBeenCalled();
  });
});
