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

/**
 * Fails the build when the processor graph emits anything beside its entry.
 * An AudioWorkletGlobalScope cannot start workers, so an emitted worker script
 * means the graph reached the core's main-thread entry instead of its worklet one.
 */
function workletEntryOnly(): Plugin {
  return {
    name: 'worklet-entry-only',
    generateBundle(_options, bundle) {
      const extra = Object.values(bundle).filter(
        (output) => !(output.type === 'chunk' && output.isEntry),
      );
      if (extra.length > 0) {
        this.error(
          `AudioWorklet build emitted more than its entry: ${extra.map((o) => o.fileName).join(', ')}`,
        );
      }
    },
  };
}

const WORKLET_ASSET_PREFIX = 'sonare-engine-worklet-';
// Worker scripts an earlier processor graph emitted beside the entry; removed so
// they do not linger in public/assets and ship with the app build.
const STALE_ASSET_PREFIXES = [WORKLET_ASSET_PREFIX, 'worker-', 'vocal_edit_worker-'];
const workletManifestPath = resolve('.worklet-build/manifest.json');

/** Removes obsolete worklet assets and records the new URL for the app build. */
function workletManifest(): Plugin {
  return {
    name: 'worklet-manifest',
    buildStart() {
      const assetsDir = resolve('public/assets');
      try {
        for (const fileName of readdirSync(assetsDir)) {
          if (
            STALE_ASSET_PREFIXES.some((prefix) => fileName.startsWith(prefix)) &&
            fileName.endsWith('.js')
          ) {
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
  plugins: [dropWasmAssets(), workletEntryOnly(), workletManifest()],
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
