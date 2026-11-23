import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWasm } from '@/lib/wasm';
import { clearHistory, setTempoSegments } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('tempo segment endBpm', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5])('rejects endBpm %s', (endBpm) => {
    expect(() =>
      setTempoSegments([
        { startPpq: 0, bpm: 100, endBpm },
        { startPpq: 4, bpm: 120 },
      ]),
    ).toThrow(RangeError);
  });

  it('accepts a missing endBpm, zero (no ramp) and a finite positive ramp', () => {
    expect(() => setTempoSegments([{ startPpq: 0, bpm: 100 }])).not.toThrow();
    expect(() => setTempoSegments([{ startPpq: 0, bpm: 100, endBpm: 0 }])).not.toThrow();
    expect(() =>
      setTempoSegments([
        { startPpq: 0, bpm: 100, endBpm: 120 },
        { startPpq: 4, bpm: 120 },
      ]),
    ).not.toThrow();
  });

  it('loads a document whose endBpm is not a usable ramp as a plain segment', async () => {
    const wasm = await ensureWasm();
    const spy = vi.spyOn(wasm.Project.prototype, 'setTempoSegments');
    const doc = createTemplate('band');
    doc.tempoSegments = [
      { startPpq: 0, bpm: 100, endBpm: Number.NaN },
      { startPpq: 4, bpm: 120, endBpm: -3 },
    ];
    try {
      await useProjectStore().loadDocument(doc);
      expect(spy.mock.lastCall?.[0]).toEqual([
        { startPpq: 0, bpm: 100, endBpm: 0 },
        { startPpq: 4, bpm: 120, endBpm: 0 },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
