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
  disposeEngineLifecycle?: () => void;
  disposeEngineProjectSync: () => void;
  disposeLayout: () => void;
  disposeProjectPersistence: () => void;
  onGlobalKeyDown: (event: KeyboardEvent) => void;
  onWindowPointerDown: (event: PointerEvent) => void;
  setBootPromise: (promise: Promise<void> | null) => void;
  shouldBlockUnload?: () => boolean;
}

export function useAppLifecycle(options: AppLifecycleOptions) {
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!options.shouldBlockUnload?.()) return;
    event.preventDefault();
    event.returnValue = '';
  };

  onMounted(async () => {
    window.addEventListener('keydown', options.onGlobalKeyDown);
    window.addEventListener('pointerdown', options.onWindowPointerDown);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Best-effort: keep the browser from evicting the project store. Never
    // blocks boot — a denied or unsupported grant just leaves storage default.
    void requestPersistentStorage();
    try {
      const wasm = await ensureWasm();
      options.version.value = wasm.version();
      const bootPromise = options.bootProject();
      options.setBootPromise(bootPromise);
      await bootPromise;
    } catch (err) {
      options.errorMessage.value = describeError(err);
    }
  });

  onBeforeUnmount(async () => {
    window.removeEventListener('keydown', options.onGlobalKeyDown);
    window.removeEventListener('pointerdown', options.onWindowPointerDown);
    window.removeEventListener('beforeunload', onBeforeUnload);
    options.disposeProjectPersistence();
    options.disposeLayout();
    options.disposeEngineLifecycle?.();
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
