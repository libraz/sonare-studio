import { onBeforeUnmount, onMounted, type Ref, type ShallowRef } from 'vue';
import type { EngineHandle } from '@/engine/engine';
import type { MeterBridge } from '@/engine/meters';
import { describeError } from '@/lib/errors';
import { ensureWasm } from '@/lib/wasm';

export interface AppLifecycleOptions {
  bridge: ShallowRef<MeterBridge | null>;
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
    await options.handle.value?.dispose();
    options.handle.value = null;
    options.setBootPromise(null);
  });
}
