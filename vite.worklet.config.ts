import { defineConfig, type Plugin } from 'vite';

// Build a self-contained single-module bundle for the AudioWorklet and serve it
// from public/ at a fixed path. The entry registers the realtime engine processor.
// Note: dynamic import is not available in the worklet scope (index.js init() cannot run there).
//
// Library mode is avoided on purpose: it force-inlines the wasm referenced by the
// Emscripten factory as base64 (~3.8 MB of dead weight — the main thread always
// passes the bytes via processorOptions.wasmBinary instead). A plain build with a
// fixed entry name keeps the bundle small; the emitted wasm asset is dropped since
// the worklet never fetches it.
function dropWasmAssets(): Plugin {
  return {
    name: 'drop-wasm-assets',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'asset' && fileName.endsWith('.wasm')) {
          delete bundle[fileName];
        }
      }
    },
  };
}

export default defineConfig({
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  plugins: [dropWasmAssets()],
  build: {
    target: 'esnext',
    emptyOutDir: false,
    outDir: 'public',
    copyPublicDir: false,
    rollupOptions: {
      input: new URL('./src/engine/worklet-entry.ts', import.meta.url).pathname,
      output: {
        format: 'es',
        entryFileNames: 'sonare-engine-worklet.js',
        inlineDynamicImports: true,
      },
    },
  },
});
