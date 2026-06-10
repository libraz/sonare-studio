import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Enable Cross-Origin Isolation in dev for SharedArrayBuffer support.
// CORP is sent alongside COOP and COEP so same-origin subresources load under isolation.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  worker: { format: 'es' },
  // sonare.wasm is imported from src/wasm; exclude from optimization and serve as-is.
  optimizeDeps: { exclude: ['@/wasm/index.js'] },
  build: { target: 'esnext' },
});
