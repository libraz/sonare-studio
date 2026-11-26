import type { SoloProcessor } from '@libraz/libsonare';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addInsert,
  addMasteringProcessor,
  clearHistory,
  replaceInsert,
  setInsertParam,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { normalizeProjectInsertParams } from '@/project/strip-insert-params';
import { createFakeWasmModule } from './fake-wasm';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('every command that places a processor refuses an unknown one', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('replaceInsert, like addInsert', () => {
    const trackId = useProjectStore().tracks[0].id;
    expect(() => addInsert(trackId, 'eq.nonexistent')).toThrow(/Unknown insert processor/);
    const index = addInsert(trackId, 'eq.tilt');
    expect(() =>
      // @ts-expect-error an id outside the registry, as untyped callers can pass
      replaceInsert(trackId, index, { processor: 'eq.nonexistent', params: {}, enabled: true }),
    ).toThrow(/Unknown insert processor/);
  });

  it('addMasteringProcessor', () => {
    expect(() => addMasteringProcessor('eq.nonexistent' as SoloProcessor)).toThrow(
      /Unknown insert processor/,
    );
  });

  it('surfaces the library refusal for an unread insert parameter', () => {
    const trackId = useProjectStore().tracks[0].id;
    expect(() => addInsert(trackId, 'saturation.tape', { driveDb: 0.4, mystery: 0.2 })).toThrow(
      /unknown key params\.mystery/,
    );
  });

  it('validates mastering-chain slots at the document sample rate', () => {
    const wasm = createFakeWasmModule();
    const timing = vi.spyOn(wasm, 'masteringInsertTiming');

    normalizeProjectInsertParams(
      {
        mixer: {
          masteringChain: {
            processors: [
              {
                processor: 'dynamics.limiter',
                enabled: true,
                params: { lookaheadMs: 12 },
              },
            ],
          },
        },
      },
      wasm,
      { sampleRate: 44_100 },
    );

    expect(timing).toHaveBeenCalledWith({
      insert: 'dynamics.limiter',
      params: { lookaheadMs: 12 },
      sampleRate: 44_100,
    });
  });

  it('refuses unknown insert IDs in both metadata queries', () => {
    const wasm = createFakeWasmModule();
    expect(() =>
      // @ts-expect-error an id outside the registry, as untyped callers can pass
      wasm.masteringInsertParamNames('eq.nonexistent'),
    ).toThrow(RangeError);
    expect(() =>
      // @ts-expect-error an id outside the registry, as untyped callers can pass
      wasm.masteringInsertParamInfo({ insert: 'eq.nonexistent' }),
    ).toThrow(RangeError);
    expect(wasm.masteringInsertParamNames('eq.tilt')).toContain('tiltDb');
    expect(wasm.masteringInsertParamInfo({ insert: 'eq.tilt' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'tiltDb' })]),
    );
  });

  it('refuses unread insert parameters before changing the interactive strip', () => {
    const store = useProjectStore();
    const trackId = store.tracks[0].id;
    const index = addInsert(trackId, 'eq.tilt', { tiltDb: 2 });
    const unknownParam = { unknownParam: 0 };
    const attempts = [
      () => addInsert(trackId, 'eq.tilt', unknownParam),
      () =>
        replaceInsert(trackId, index, {
          processor: 'eq.tilt',
          params: unknownParam,
          enabled: true,
        }),
      () => setInsertParam(trackId, index, 'unknownParam', 0),
    ];
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const insertIndex = attemptIndex === 0 ? 1 : 0;
      expect(attempt).toThrow(TypeError);
      expect(attempt).toThrow(
        `strip ${trackId}.inserts[${insertIndex}]: masteringInsertTiming: unknown key params.unknownParam`,
      );
    }
    expect(store.tracks[0].mixer?.inserts).toMatchObject([
      { processor: 'eq.tilt', params: { tiltDb: 2 } },
    ]);
  });
});
