import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Build a self-contained, content-addressed module for the AudioWorklet. The
// entry registers the realtime engine processor.
// Note: dynamic import is not available in the worklet scope (index.js init() cannot run there).
//
// Library mode is avoided on purpose: it force-inlines the wasm referenced by the
// Emscripten factory as base64 (~3.8 MB of dead weight — the main thread always
// passes the bytes via processorOptions.wasmBinary instead). A plain build with a
// standalone entry keeps the bundle small; the emitted wasm asset is dropped since
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

const WORKLET_ASSET_PREFIX = 'sonare-engine-worklet-';
const workletManifestPath = resolve('.worklet-build/manifest.json');

/** Removes obsolete content-addressed worklets and records the new URL for the app build. */
function workletManifest(): Plugin {
  return {
    name: 'worklet-manifest',
    buildStart() {
      const assetsDir = resolve('public/assets');
      try {
        for (const fileName of readdirSync(assetsDir)) {
          if (fileName.startsWith(WORKLET_ASSET_PREFIX) && fileName.endsWith('.js')) {
            rmSync(resolve(assetsDir, fileName));
          }
        }
      } catch {
        // The first build has no public/assets directory yet.
      }
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.isEntry,
      );
      if (!entry) throw new Error('AudioWorklet build did not emit an entry chunk');
      mkdirSync(resolve('.worklet-build'), { recursive: true });
      writeFileSync(
        workletManifestPath,
        `${JSON.stringify({ moduleUrl: `/${entry.fileName}` }, null, 2)}\n`,
      );
      writeFileSync(
        resolve('public/worklet-manifest.json'),
        `${JSON.stringify({ moduleUrl: `/${entry.fileName}` }, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  plugins: [dropWasmAssets(), workletManifest()],
  build: {
    target: 'esnext',
    emptyOutDir: false,
    outDir: 'public',
    copyPublicDir: false,
    rollupOptions: {
      input: new URL('./src/engine/worklet-entry.ts', import.meta.url).pathname,
      output: {
        format: 'es',
        entryFileNames: `assets/${WORKLET_ASSET_PREFIX}[hash].js`,
        inlineDynamicImports: true,
      },
    },
  },
});
