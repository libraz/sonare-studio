import { defineConfig } from 'vite';

// Build a self-contained single-module bundle for the AudioWorklet and serve it
// from public/ at a fixed path. The entry registers the realtime engine processor.
// Note: dynamic import is not available in the worklet scope (index.js init() cannot run there).
export default defineConfig({
  build: {
    target: 'esnext',
    emptyOutDir: false,
    lib: {
      entry: new URL('./src/engine/worklet-entry.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: () => 'sonare-engine-worklet.js',
    },
    outDir: 'public',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
