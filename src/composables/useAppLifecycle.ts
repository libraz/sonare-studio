import { onBeforeUnmount, onMounted, type Ref, type ShallowRef } from 'vue';
import type { AnalyserBridge } from '@/engine/analyser';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import type { ScopeBridge } from '@/engine/scope';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';
import { requestPersistentStorage } from '@/persistence/opfs';

export interface AppLifecycleOptions {
  bridge: ShallowRef<MeterBridge | null>;
  analyser: ShallowRef<AnalyserBridge | null>;
  scope: ShallowRef<ScopeBridge | null>;
  errorMessage: Ref<string>;
  handle: ShallowRef<EngineHandle | null>;
  version: Ref<string>;
  bootProject: () => Promise<void>;
  disposeEngineLifecycle?: () => void | Promise<void>;
  disposeEngineProjectSync: () => void;
  disposeLayout: () => void;
  disposeProjectPersistence: () => void;
  onGlobalKeyDown: (event: KeyboardEvent) => void;
  onWindowPointerDown: (event: PointerEvent) => void;
  setBootPromise: (promise: Promise<void> | null) => void;
  shouldBlockUnload?: () => boolean;
  /** Best-effort autosave flush used when the page is backgrounded or closed. */
  flushAutosave?: () => Promise<unknown>;
}

export function useAppLifecycle(options: AppLifecycleOptions) {
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!options.shouldBlockUnload?.()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  const flushAutosave = (): void => {
    void options.flushAutosave?.();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') flushAutosave();
  };

  onMounted(async () => {
    window.addEventListener('keydown', options.onGlobalKeyDown);
    window.addEventListener('pointerdown', options.onWindowPointerDown);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', flushAutosave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Best-effort: keep the browser from evicting the project store. Never
    // blocks boot — a denied or unsupported grant just leaves storage default.
    void requestPersistentStorage();
    try {
      // Boot does not wait for the module here: it lists saved projects first,
      // so the launcher shows its rows while the wasm is still loading.
      const bootPromise = options.bootProject();
      options.setBootPromise(bootPromise);
      const versionReady = ensureWasm().then((wasm) => {
        options.version.value = wasm.version();
      });
      await Promise.all([versionReady, bootPromise]);
    } catch (err) {
      options.errorMessage.value = describeError(err);
    }
  });

  onBeforeUnmount(async () => {
    window.removeEventListener('keydown', options.onGlobalKeyDown);
    window.removeEventListener('pointerdown', options.onWindowPointerDown);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', flushAutosave);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    options.disposeProjectPersistence();
    options.disposeLayout();
    await options.disposeEngineLifecycle?.();
    options.disposeEngineProjectSync();
    options.bridge.value?.dispose();
    options.bridge.value = null;
    options.analyser.value?.dispose();
    options.analyser.value = null;
    options.scope.value?.dispose();
    options.scope.value = null;
    await options.handle.value?.dispose();
    options.handle.value = null;
    options.setBootPromise(null);
  });
}
