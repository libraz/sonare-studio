// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

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

export default defineConfig(({ command }) => ({
  plugins: [vue()],
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
