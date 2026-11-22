import { describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('@libraz/libsonare', () => wasm);

describe('ensureWasm', () => {
  it('retries module initialization after a failed attempt', async () => {
    const firstError = new Error('initialization failed');
    wasm.init.mockRejectedValueOnce(firstError).mockResolvedValue(undefined);

    const { ensureWasm } = await import('@/lib/wasm');

    await expect(ensureWasm()).rejects.toBe(firstError);
    await expect(ensureWasm()).resolves.toMatchObject({ init: wasm.init });
    expect(wasm.init).toHaveBeenCalledTimes(2);
  });
});
