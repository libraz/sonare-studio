let mod: typeof import('@/wasm/index.js') | null = null;
let p: Promise<typeof import('@/wasm/index.js')> | null = null;

/** Initializes the libsonare WASM module once and returns it. */
export async function ensureWasm(): Promise<typeof import('@/wasm/index.js')> {
  if (mod) return mod;
  if (!p) {
    p = (async () => {
      const m = await import('@/wasm/index.js');
      await m.init();
      mod = m;
      return m;
    })();
  }
  return p;
}
