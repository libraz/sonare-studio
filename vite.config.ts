// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

// Enable Cross-Origin Isolation in dev for SharedArrayBuffer support.
// CORP is sent alongside COOP and COEP so same-origin subresources load under isolation.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function productionWorkletUrl(): string {
  const manifestPath = resolve('.worklet-build/manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Missing AudioWorklet manifest. Run yarn build:worklet before the app build.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { moduleUrl?: unknown };
  if (typeof manifest.moduleUrl !== 'string' || !manifest.moduleUrl.startsWith('/assets/')) {
    throw new Error('AudioWorklet manifest contains an invalid module URL.');
  }
  return manifest.moduleUrl;
}

function hashBuildValue(hash: number, value: string | Uint8Array): number {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let next = hash;
  for (const byte of bytes) {
    next ^= byte;
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  return next;
}

/** Emits a complete content-addressed precache manifest and stamps the SW cache name. */
function pwaPrecacheManifest(): Plugin {
  let generatedServiceWorker = '';
  return {
    name: 'pwa-precache-manifest',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const workletUrl = productionWorkletUrl();
      const assets = new Set([
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/icon.svg',
        '/worklet-manifest.json',
        workletUrl,
        '/precache-manifest.json',
      ]);
      let hash = 0x811c9dc5;
      for (const [fileName, output] of Object.entries(bundle).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (fileName === 'sw.js' || fileName === 'precache-manifest.json') continue;
        assets.add(`/${fileName}`);
        hash = hashBuildValue(hash, fileName);
        hash = hashBuildValue(hash, output.type === 'chunk' ? output.code : output.source);
      }
      for (const path of ['manifest.webmanifest', 'icon.svg', 'worklet-manifest.json']) {
        hash = hashBuildValue(hash, readFileSync(resolve('public', path)));
      }
      hash = hashBuildValue(hash, workletUrl);
      const release = hash.toString(16).padStart(8, '0');
      const cacheVersion = `sonare-studio-${release}`;
      const manifest = {
        cacheVersion,
        assets: [...assets].sort(),
      };
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
      const template = readFileSync(resolve('public/sw.js'), 'utf8');
      if (!template.includes('__SONARE_CACHE_VERSION__')) {
        throw new Error('Service Worker template is missing its cache-version placeholder.');
      }
      generatedServiceWorker = template.replaceAll('__SONARE_CACHE_VERSION__', cacheVersion);
    },
    writeBundle(options) {
      if (!generatedServiceWorker) throw new Error('Service Worker was not generated.');
      writeFileSync(resolve(options.dir ?? 'dist', 'sw.js'), generatedServiceWorker);
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [vue(), pwaPrecacheManifest()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  define: {
    __SONARE_WORKLET_MODULE_URL__: JSON.stringify(
      command === 'build' ? productionWorkletUrl() : '/sonare-engine-worklet.js',
    ),
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  worker: { format: 'es' },
  // sonare.wasm is imported from src/wasm; exclude from optimization and serve as-is.
  optimizeDeps: { exclude: ['@/wasm/index.js'] },
  build: { target: 'esnext' },
}));
