import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useWebMidiOutputs } from '@/composables/useWebMidiOutputs';

interface FakeMidiAccess {
  outputs: Map<string, { id: string; name?: string | null }>;
  onstatechange: ((event: unknown) => void) | null;
  addEventListener?: (type: 'statechange', listener: (event: unknown) => void) => void;
  removeEventListener?: (type: 'statechange', listener: (event: unknown) => void) => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useWebMidiOutputs', () => {
  it('returns unavailable without throwing when Web MIDI is absent', async () => {
    vi.stubGlobal('navigator', {});
    const outputs = useWebMidiOutputs();

    await expect(outputs.refresh()).resolves.toBe(false);

    expect(outputs.available.value).toBe(false);
    expect(outputs.outputs.value).toEqual([]);
    expect(outputs.error.value).toBeNull();
  });

  it('chains and restores legacy onstatechange handlers', async () => {
    const previous = vi.fn();
    const access: FakeMidiAccess = {
      outputs: new Map([['out-1', { id: 'out-1', name: 'Main Out' }]]),
      onstatechange: previous,
    };
    const requestMIDIAccess = vi.fn(async () => access);
    vi.stubGlobal('navigator', { requestMIDIAccess });
    const scope = effectScope();
    let outputs!: ReturnType<typeof useWebMidiOutputs>;
    scope.run(() => {
      outputs = useWebMidiOutputs();
    });

    await expect(outputs.refresh()).resolves.toBe(true);

    expect(outputs.available.value).toBe(true);
    expect(outputs.outputs.value).toEqual([{ id: 'out-1', name: 'Main Out' }]);
    access.outputs.set('out-2', { id: 'out-2', name: null });
    access.onstatechange?.({ type: 'statechange' });

    expect(previous).toHaveBeenCalledWith({ type: 'statechange' });
    expect(outputs.outputs.value).toEqual([
      { id: 'out-1', name: 'Main Out' },
      { id: 'out-2', name: 'out-2' },
    ]);

    scope.stop();
    expect(access.onstatechange).toBe(previous);
  });

  it('removes EventTarget statechange handlers on scope dispose', async () => {
    let listener = null as ((event: unknown) => void) | null;
    const access: FakeMidiAccess = {
      outputs: new Map([['out-1', { id: 'out-1', name: 'Main Out' }]]),
      onstatechange: null,
      addEventListener: vi.fn((_type: 'statechange', next: (event: unknown) => void) => {
        listener = next;
      }),
      removeEventListener: vi.fn((_type: 'statechange', next: (event: unknown) => void) => {
        if (listener === next) listener = null;
      }),
    };
    const requestMIDIAccess = vi.fn(async () => access);
    vi.stubGlobal('navigator', { requestMIDIAccess });
    const scope = effectScope();
    let outputs!: ReturnType<typeof useWebMidiOutputs>;
    scope.run(() => {
      outputs = useWebMidiOutputs();
    });

    await expect(outputs.refresh()).resolves.toBe(true);
    expect(access.addEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));

    access.outputs.set('out-2', { id: 'out-2', name: null });
    listener?.({ type: 'statechange' });
    expect(outputs.outputs.value).toEqual([
      { id: 'out-1', name: 'Main Out' },
      { id: 'out-2', name: 'out-2' },
    ]);

    scope.stop();
    expect(access.removeEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));
    expect(listener).toBeNull();
  });

  it('ignores MIDI access that resolves after the owning scope is disposed', async () => {
    const pending = deferred<FakeMidiAccess>();
    const requestMIDIAccess = vi.fn(() => pending.promise);
    vi.stubGlobal('navigator', { requestMIDIAccess });
    const scope = effectScope();
    let outputs!: ReturnType<typeof useWebMidiOutputs>;
    scope.run(() => {
      outputs = useWebMidiOutputs();
    });
    const refreshing = outputs.refresh();
    scope.stop();
    const access: FakeMidiAccess = {
      outputs: new Map([['out-1', { id: 'out-1', name: 'Late' }]]),
      onstatechange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    pending.resolve(access);

    await expect(refreshing).resolves.toBe(false);
    expect(outputs.outputs.value).toEqual([]);
    expect(outputs.available.value).toBeNull();
    expect(access.addEventListener).not.toHaveBeenCalled();
    await expect(outputs.refresh()).resolves.toBe(false);
    expect(requestMIDIAccess).toHaveBeenCalledTimes(1);
  });
});
