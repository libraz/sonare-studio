let mod: typeof import('@/wasm/index.js') | null = null;
let p: Promise<typeof import('@/wasm/index.js')> | null = null;

/** Initializes the libsonare WASM module once and returns it. */
export async function ensureWasm(): Promise<typeof import('@/wasm/index.js')> {
  if (mod) return mod;
  if (!p) {
    const attempt = (async () => {
      const m = await import('@/wasm/index.js');
      await m.init();
      mod = m;
      return m;
    })();
    const retryable = attempt.catch((error) => {
      // A rejected init must not poison all later callers. Keep a successful
      // module cached, but let the next call start a fresh init attempt.
      if (p === retryable) p = null;
      throw error;
    });
    p = retryable;
  }
  return p;
}
