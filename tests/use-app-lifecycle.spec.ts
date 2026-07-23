import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, ref, shallowRef } from 'vue';
import { useAppLifecycle } from '@/composables/useAppLifecycle';

const mocks = vi.hoisted(() => ({
  ensureWasm: vi.fn(async () => ({ version: () => 'test-wasm' })),
  requestPersistentStorage: vi.fn(async () => true),
}));

vi.mock('@/lib/wasm', () => ({ ensureWasm: mocks.ensureWasm }));
vi.mock('@/persistence/opfs', () => ({ requestPersistentStorage: mocks.requestPersistentStorage }));

describe('useAppLifecycle', () => {
  function mountLifecycle(
    options: { shouldBlockUnload?: () => boolean; bootProject?: () => Promise<void> } = {},
  ) {
    const bootProject = options.bootProject ?? vi.fn(async () => undefined);
    const setBootPromise = vi.fn();
    const onGlobalKeyDown = vi.fn();
    const onWindowPointerDown = vi.fn();
    const flushAutosave = vi.fn(async () => true);
    const version = ref('');
    const disposeProjectPersistence = vi.fn();

    const wrapper = mount(
      defineComponent({
        setup() {
          useAppLifecycle({
            bridge: shallowRef(null),
            analyser: shallowRef(null),
            scope: shallowRef(null),
            errorMessage: ref(''),
            handle: shallowRef(null),
            version,
            bootProject,
            disposeEngineProjectSync: vi.fn(),
            disposeLayout: vi.fn(),
            disposeProjectPersistence,
            onGlobalKeyDown,
            onWindowPointerDown,
            setBootPromise,
            flushAutosave,
            shouldBlockUnload: options.shouldBlockUnload,
          });
          return () => null;
        },
      }),
    );

    return {
      bootProject,
      disposeProjectPersistence,
      onGlobalKeyDown,
      onWindowPointerDown,
      flushAutosave,
      setBootPromise,
      version,
      wrapper,
    };
  }

  it('requests persistent storage at startup without blocking boot', async () => {
    const { bootProject, setBootPromise, version, wrapper } = mountLifecycle();

    await flushPromises();

    expect(mocks.requestPersistentStorage).toHaveBeenCalledTimes(1);
    expect(mocks.ensureWasm).toHaveBeenCalledTimes(1);
    expect(bootProject).toHaveBeenCalledTimes(1);
    expect(version.value).toBe('test-wasm');
    expect(setBootPromise).toHaveBeenCalledWith(expect.any(Promise));

    wrapper.unmount();
  });

  it('blocks browser unload when unsaved or autosave work is pending', async () => {
    let dirty = false;
    const { wrapper } = mountLifecycle({ shouldBlockUnload: () => dirty });
    await flushPromises();

    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    dirty = true;
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    wrapper.unmount();
  });

  it('removes the unload guard on unmount', async () => {
    const { wrapper } = mountLifecycle({ shouldBlockUnload: () => true });
    await flushPromises();
    wrapper.unmount();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('flushes autosave when the page is hidden or placed in the back-forward cache', async () => {
    const { flushAutosave, wrapper } = mountLifecycle();
    await flushPromises();

    window.dispatchEvent(new Event('pagehide'));
    await flushPromises();
    expect(flushAutosave).toHaveBeenCalledTimes(1);

    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(flushAutosave).toHaveBeenCalledTimes(2);
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else delete (document as { visibilityState?: string }).visibilityState;
    wrapper.unmount();
  });
});
