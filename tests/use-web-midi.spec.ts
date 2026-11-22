import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useWebMidi } from '@/composables/useWebMidi';
import type { WebMidiBinding, WebMidiEngine } from '@/wasm/index.js';
import * as core from '@/wasm/index.js';
import { webMidiInputInfo } from './fakes/analysis';

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
  destroy: vi.fn(),
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
    inputs: () => [webMidiInputInfo()],
    destroy: wasmMock.destroy,
  } satisfies Partial<Omit<WebMidiBinding, 'access'>> & { access: unknown };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  wasmMock.input = new FakeMidiInput();
  wasmMock.destroy.mockClear();
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
    expect(wasmMock.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps 14-bit CC and RPN state isolated per MIDI input and resets it on reconnect', async () => {
    const first = new FakeMidiInput();
    const second = new FakeMidiInput();
    const onControlChange = vi.fn();
    wasmMock.bindWebMidi.mockResolvedValue({
      access: {
        inputs: new Map([
          ['first', first],
          ['second', second],
        ]),
      },
      inputs: () => [
        webMidiInputInfo({ id: 'first', name: 'First' }),
        webMidiInputInfo({ id: 'second', name: 'Second' }),
      ],
      destroy: wasmMock.destroy,
    });
    const webMidi = useWebMidi({ onControlChange });

    await webMidi.connect({} as never);
    first.send([0xb0, 1, 64], 10);
    second.send([0xb0, 33, 5], 11);
    expect(onControlChange).toHaveBeenLastCalledWith({
      channel: 0,
      controller: 33,
      value: 5,
      timeStampMs: 11,
    });
    first.send([0xb0, 101, 0], 12);
    first.send([0xb0, 100, 2], 13);
    second.send([0xb0, 6, 64], 14);
    expect(onControlChange).toHaveBeenLastCalledWith({
      channel: 0,
      controller: 6,
      value: 64,
      timeStampMs: 14,
    });

    webMidi.disconnect();
    await webMidi.connect({} as never);
    first.send([0xb0, 33, 5], 15);
    expect(onControlChange).toHaveBeenLastCalledWith({
      channel: 0,
      controller: 33,
      value: 5,
      timeStampMs: 15,
    });
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

  it('closes a binding that resolves after disconnect without publishing stale listeners', async () => {
    const pending = deferred<ReturnType<typeof makeBinding>>();
    wasmMock.bindWebMidi.mockReturnValue(pending.promise);
    const input = wasmMock.input as FakeMidiInput;
    const webMidi = useWebMidi();

    const connecting = webMidi.connect({} as never);
    await vi.waitFor(() => expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(1));
    webMidi.disconnect();
    pending.resolve(makeBinding(input));

    await expect(connecting).resolves.toBe(false);
    expect(wasmMock.destroy).toHaveBeenCalledTimes(1);
    expect(input.listeners.size).toBe(0);
    expect(webMidi.connected.value).toBe(false);
  });

  it('keeps only the newest binding when rapid connects resolve out of order', async () => {
    const first = deferred<ReturnType<typeof makeBinding>>();
    const second = deferred<ReturnType<typeof makeBinding>>();
    const firstInput = new FakeMidiInput();
    const secondInput = new FakeMidiInput();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const engineA = {} as never;
    const engineB = {} as never;
    wasmMock.bindWebMidi.mockImplementation((engine) =>
      engine === engineA ? first.promise : second.promise,
    );
    const webMidi = useWebMidi();

    const connectingA = webMidi.connect(engineA);
    await vi.waitFor(() => expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(1));
    const connectingB = webMidi.connect(engineB);
    second.resolve({ ...makeBinding(secondInput), destroy: secondClose });
    await expect(connectingB).resolves.toBe(true);
    first.resolve({ ...makeBinding(firstInput), destroy: firstClose });
    await expect(connectingA).resolves.toBe(false);

    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(firstInput.listeners.size).toBe(0);
    expect(secondInput.listeners.size).toBe(1);
    expect(webMidi.connected.value).toBe(true);
    webMidi.disconnect();
  });

  it('finishes listener cleanup even when the MIDI binding close throws', async () => {
    const input = wasmMock.input as FakeMidiInput;
    wasmMock.bindWebMidi.mockResolvedValue({
      ...makeBinding(input),
      destroy: () => {
        throw new Error('close failed');
      },
    });
    const webMidi = useWebMidi();
    await webMidi.connect({} as never);

    expect(() => webMidi.disconnect()).not.toThrow();
    expect(input.listeners.size).toBe(0);
    expect(webMidi.connected.value).toBe(false);
    expect(webMidi.error.value).toBe('close failed');
  });

  it('keeps a control-surface port out of the engine binding and the callbacks', async () => {
    const surface = new FakeMidiInput();
    const keyboard = wasmMock.input as FakeMidiInput;
    wasmMock.bindWebMidi.mockImplementation(async () => ({
      access: {
        inputs: new Map([
          ['input-1', keyboard],
          ['surface-1', surface],
        ]),
      },
      inputs: () => [webMidiInputInfo(), webMidiInputInfo({ id: 'surface-1', name: 'MCU' })],
      destroy: wasmMock.destroy,
    }));
    (navigator as unknown as Record<string, unknown>).requestMIDIAccess = async () => ({
      inputs: new Map([
        ['input-1', keyboard],
        ['surface-1', surface],
      ]),
    });
    const onNoteOn = vi.fn();
    const webMidi = useWebMidi({ onNoteOn });
    webMidi.excludedInputIds.value = ['surface-1'];
    await webMidi.connect({} as never);

    // The engine only sees the musical port, so a surface button never reaches
    // the instrument.
    expect(wasmMock.bindWebMidi.mock.calls[0][1]).toMatchObject({ inputIds: ['input-1'] });
    // ...and its note-ons never reach preview / step input / recording either.
    surface.send([0x90, 60, 100]);
    expect(onNoteOn).not.toHaveBeenCalled();
    keyboard.send([0x90, 60, 100]);
    expect(onNoteOn).toHaveBeenCalledTimes(1);
  });

  it('stays disconnected after the user disconnects when the exclusion set changes', async () => {
    (navigator as unknown as Record<string, unknown>).requestMIDIAccess = async () => ({
      inputs: new Map([['input-1', wasmMock.input as FakeMidiInput]]),
    });
    const webMidi = useWebMidi();
    await webMidi.connect({} as never);
    webMidi.excludedInputIds.value = ['surface-1'];
    await vi.waitFor(() => expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(2));

    webMidi.disconnect();
    webMidi.excludedInputIds.value = ['surface-2'];
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(2);
    expect(webMidi.connected.value).toBe(false);
  });

  it('binds nothing rather than everything when the surface owns the only port', async () => {
    (navigator as unknown as Record<string, unknown>).requestMIDIAccess = async () => ({
      inputs: new Map([['input-1', wasmMock.input as FakeMidiInput]]),
    });
    const webMidi = useWebMidi();
    webMidi.excludedInputIds.value = ['input-1'];

    // An empty id list means "bind every input" to the library, so the binding
    // has to be skipped instead.
    await expect(webMidi.connect({} as never)).resolves.toBe(false);
    expect(wasmMock.bindWebMidi).not.toHaveBeenCalled();
    expect(webMidi.error.value).toBeNull();
  });

  it('never publishes a permission result that resolves after scope disposal', async () => {
    const pending = deferred<ReturnType<typeof makeBinding>>();
    wasmMock.bindWebMidi.mockReturnValue(pending.promise);
    const scope = effectScope();
    let webMidi!: ReturnType<typeof useWebMidi>;
    scope.run(() => {
      webMidi = useWebMidi();
    });
    const connecting = webMidi.connect({} as never);
    await vi.waitFor(() => expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(1));

    scope.stop();
    pending.resolve(makeBinding(wasmMock.input as FakeMidiInput));

    await expect(connecting).resolves.toBe(false);
    expect(wasmMock.destroy).toHaveBeenCalledTimes(1);
    expect(webMidi.connected.value).toBe(false);
    await expect(webMidi.connect({} as never)).resolves.toBe(false);
  });
});

describe('useWebMidi against the real core binding', () => {
  const requestMIDIAccess = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');

  afterEach(() => {
    if (requestMIDIAccess) Object.defineProperty(navigator, 'requestMIDIAccess', requestMIDIAccess);
    else Reflect.deleteProperty(navigator, 'requestMIDIAccess');
  });

  it('lists the ports the core reports and routes a note-on into the engine', async () => {
    const keyboard = new FakeMidiInput();
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => ({
        inputs: new Map([
          [
            'in-1',
            Object.assign(keyboard, {
              id: 'in-1',
              name: 'Keys',
              manufacturer: 'Acme',
              state: 'connected' as const,
            }),
          ],
        ]),
        onstatechange: null,
      }),
    });
    wasmMock.isWebMidiAvailable.mockImplementation(() => core.isWebMidiAvailable());
    wasmMock.bindWebMidi.mockImplementation((engine, options) => core.bindWebMidi(engine, options));
    const engine = {
      bindMidiCc: vi.fn(),
      setMidiInputSource: vi.fn(),
      clearMidiInputSource: vi.fn(),
      pushMidiInputNoteOn: vi.fn(),
      pushMidiInputNoteOff: vi.fn(),
      pushMidiInputCc: vi.fn(),
    } satisfies WebMidiEngine;
    const scope = effectScope();
    let webMidi!: ReturnType<typeof useWebMidi>;
    scope.run(() => {
      webMidi = useWebMidi();
    });

    // The composable takes the full realtime engine; the core only drives this slice.
    await expect(webMidi.connect(engine as never)).resolves.toBe(true);

    expect(webMidi.inputs.value).toEqual([
      webMidiInputInfo({ id: 'in-1', name: 'Keys', manufacturer: 'Acme' }),
    ]);
    keyboard.send([0x90, 60, 100]);
    expect(engine.pushMidiInputNoteOn).toHaveBeenCalled();
    expect(engine.pushMidiInputNoteOn.mock.calls[0].slice(0, 4)).toEqual([0, 0, 60, 100]);
    scope.stop();
  });
});
