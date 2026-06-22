import { onBeforeUnmount, onMounted, type Ref, type ShallowRef } from 'vue';
import type { AnalyserBridge } from '@/engine/analyser';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import type { ScopeBridge } from '@/engine/scope';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';

export interface AppLifecycleOptions {
  bridge: ShallowRef<MeterBridge | null>;
  analyser: ShallowRef<AnalyserBridge | null>;
  scope: ShallowRef<ScopeBridge | null>;
  errorMessage: Ref<string>;
  handle: ShallowRef<EngineHandle | null>;
  version: Ref<string>;
  bootProject: () => Promise<void>;
  disposeEngineProjectSync: () => void;
  disposeLayout: () => void;
  disposeProjectPersistence: () => void;
  onGlobalKeyDown: (event: KeyboardEvent) => void;
  onWindowPointerDown: (event: PointerEvent) => void;
  setBootPromise: (promise: Promise<void> | null) => void;
}

export function useAppLifecycle(options: AppLifecycleOptions) {
  onMounted(async () => {
    window.addEventListener('keydown', options.onGlobalKeyDown);
    window.addEventListener('pointerdown', options.onWindowPointerDown);
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
    options.disposeProjectPersistence();
    options.disposeLayout();
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
