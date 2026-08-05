// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { execFileSync } from 'node:child_process';
// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { resolve } from 'node:path';
// @ts-expect-error Build config runs in Node; the browser app intentionally omits global Node types.
import { env } from 'node:process';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

// Enable Cross-Origin Isolation in dev for SharedArrayBuffer support.
// CORP is sent alongside COOP and COEP so same-origin subresources load under isolation.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function workletModuleUrl(): string {
  const manifestPath = resolve('.worklet-build/manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Missing AudioWorklet manifest. Run yarn build:worklet first.');
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
      const workletUrl = workletModuleUrl();
      const assets = new Set([
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/icon.svg',
        '/icon-192.png',
        '/icon-512.png',
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
      for (const path of [
        'manifest.webmanifest',
        'icon.svg',
        'icon-192.png',
        'icon-512.png',
        'worklet-manifest.json',
      ]) {
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

/** Application version, taken from the manifest that the deploy is built from. */
function appVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '';
}

/**
 * Short commit of the deployed build. Deployments are untagged, so the commit
 * plus the build time is the only identity a running deploy has. Cloudflare
 * Pages exposes the full SHA; a local build falls back to the git checkout, and
 * an unavailable commit degrades to an empty string rather than failing.
 */
function buildCommit(): string {
  const deployed = env.CF_PAGES_COMMIT_SHA;
  if (typeof deployed === 'string' && deployed.length > 0) return deployed.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// The worklet URL comes from the manifest in dev as well as in the app build:
// a fixed filename would let a stale worklet bundle survive an engine refresh
// and fail at wasm instantiation with a missing-import LinkError.
export default defineConfig({
  plugins: [vue(), pwaPrecacheManifest()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  define: {
    __SONARE_WORKLET_MODULE_URL__: JSON.stringify(workletModuleUrl()),
    __SONARE_APP_VERSION__: JSON.stringify(appVersion()),
    __SONARE_BUILD_COMMIT__: JSON.stringify(buildCommit()),
    __SONARE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  worker: { format: 'es' },
  // sonare.wasm is imported from src/wasm; exclude from optimization and serve as-is.
  optimizeDeps: { exclude: ['@/wasm/index.js'] },
  build: { target: 'esnext' },
});
