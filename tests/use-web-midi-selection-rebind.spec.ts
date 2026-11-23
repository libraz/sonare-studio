import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { useWebMidi } from '@/composables/useWebMidi';
import { webMidiInputInfo } from './fakes/analysis';

const wasmMock = vi.hoisted(() => ({ bindWebMidi: vi.fn() }));

vi.mock('@/lib/wasm', () => ({
  ensureWasm: async () => ({ isWebMidiAvailable: () => true, bindWebMidi: wasmMock.bindWebMidi }),
}));

function binding() {
  return {
    access: { inputs: new Map() },
    inputs: () => [webMidiInputInfo()],
    destroy: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let scope = effectScope();

beforeEach(() => {
  wasmMock.bindWebMidi.mockReset();
  wasmMock.bindWebMidi.mockImplementation(async () => binding());
  scope = effectScope();
});

afterEach(() => {
  scope.stop();
});

function create(): ReturnType<typeof useWebMidi> {
  return scope.run(() => useWebMidi())!;
}

describe('useWebMidi selection rebind', () => {
  it('binds a newly selected input after a surface took the previously selected one', async () => {
    const webMidi = create();
    webMidi.selectedInputId.value = 'keys-a';
    await expect(webMidi.connect({} as never)).resolves.toBe(true);

    webMidi.excludedInputIds.value = ['keys-a'];
    await vi.waitFor(() => expect(webMidi.connected.value).toBe(false));

    webMidi.selectedInputId.value = 'keys-b';
    await vi.waitFor(() => expect(webMidi.connected.value).toBe(true));
    expect(wasmMock.bindWebMidi.mock.lastCall?.[1]).toMatchObject({ inputIds: ['keys-b'] });
  });

  it('binds the new selection when it changes while a connect is still in flight', async () => {
    const pending = deferred<ReturnType<typeof binding>>();
    wasmMock.bindWebMidi.mockReturnValueOnce(pending.promise);
    const webMidi = create();
    webMidi.selectedInputId.value = 'keys-a';
    const first = webMidi.connect({} as never);
    await vi.waitFor(() => expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(1));

    webMidi.selectedInputId.value = 'keys-b';
    await nextTick();
    pending.resolve(binding());
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(webMidi.connected.value).toBe(true));
    expect(wasmMock.bindWebMidi.mock.lastCall?.[1]).toMatchObject({ inputIds: ['keys-b'] });
  });

  it('stays disconnected after a user disconnect when the selection changes', async () => {
    const webMidi = create();
    await webMidi.connect({} as never);
    webMidi.disconnect();
    webMidi.selectedInputId.value = 'keys-b';
    await nextTick();
    await Promise.resolve();
    expect(wasmMock.bindWebMidi).toHaveBeenCalledTimes(1);
    expect(webMidi.connected.value).toBe(false);
  });
});
