import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createInsertPdcPlan,
  type InsertPdcTrack,
  type InsertTimingQuery,
  insertChainLatencySamples,
  insertLatencyResolverFromCatalog,
} from '@/project/insert-latency';
import { createDefaultStrip } from '@/project/mixer';
import * as core from '@/wasm/index.js';

describe('insert latency helpers', () => {
  it('sums enabled insert latencies from catalog metadata', () => {
    const resolve = insertLatencyResolverFromCatalog(
      [
        { id: 'eq.linearPhase', latencySamples: 128.4 },
        { id: 'dynamics.brickwallLimiter', latencySamples: 64 },
        { id: 'dynamics.gate', latencySamples: -1 },
      ],
      48000,
    );

    expect(
      insertChainLatencySamples(
        [
          { processor: 'eq.linearPhase', params: {}, enabled: true },
          { processor: 'dynamics.brickwallLimiter', params: {}, enabled: false },
          { processor: 'dynamics.gate', params: {}, enabled: true },
          { processor: 'effects.reverb.room', params: {}, enabled: true },
        ],
        resolve,
      ),
    ).toBe(128);
  });

  it('asks the engine with only the keys read while the insert is built', () => {
    const timing = vi.fn<InsertTimingQuery>((request) => {
      const params: Record<string, unknown> = request.params ?? {};
      return {
        latencySamples: typeof params.lookaheadMs === 'number' ? params.lookaheadMs * 48 : 48,
      };
    });
    const resolve = insertLatencyResolverFromCatalog(
      [
        {
          id: 'dynamics.limiter',
          latencySamples: 48,
          params: [{ name: 'releaseMs', id: 1 }, { name: 'lookaheadMs' }],
        },
      ],
      48000,
      timing,
    );

    expect(
      resolve({ processor: 'dynamics.limiter', params: { lookaheadMs: 5, releaseMs: 80 } }),
    ).toBe(240);
    expect(timing).toHaveBeenLastCalledWith({
      insert: 'dynamics.limiter',
      params: { lookaheadMs: 5 },
      sampleRate: 48000,
    });
    // A live-patched key cannot move the latency, so the answer is reused.
    expect(
      resolve({ processor: 'dynamics.limiter', params: { lookaheadMs: 5, releaseMs: 200 } }),
    ).toBe(240);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(resolve({ processor: 'effects.reverb.room', params: { lookaheadMs: 5 } })).toBe(0);
  });

  it('falls back to the catalog latency when the engine refuses a configuration', () => {
    const resolve = insertLatencyResolverFromCatalog(
      [{ id: 'eq.linearPhase', latencySamples: 256, params: [{ name: 'kernelSize' }] }],
      48000,
      () => {
        throw new Error('refused');
      },
    );

    expect(resolve({ processor: 'eq.linearPhase', params: { kernelSize: 2 } })).toBe(256);
  });

  it('includes routed return/group latency while excluding an unused return bus', () => {
    const resolve = insertLatencyResolverFromCatalog(
      [
        { id: 'eq.minimumPhase', latencySamples: 32 },
        { id: 'dynamics.limiter', latencySamples: 96 },
        { id: 'dynamics.expander', latencySamples: 4096 },
        { id: 'eq.graphic', latencySamples: 64 },
      ],
      48000,
    );
    const tracks: InsertPdcTrack[] = [
      {
        id: 1,
        kind: 'audio',
        mixer: { ...createDefaultStrip(), outputBusId: 'return-fx' },
      },
      {
        id: 2,
        kind: 'audio',
        mixer: {
          ...createDefaultStrip(),
          inserts: [{ processor: 'eq.minimumPhase', params: {}, enabled: true }],
        },
      },
      {
        id: 3,
        kind: 'audio',
        groupId: 4,
        mixer: createDefaultStrip(),
      },
      {
        id: 4,
        kind: 'group',
        mixer: {
          ...createDefaultStrip(),
          inserts: [{ processor: 'eq.graphic', params: {}, enabled: true }],
        },
      },
    ];
    const pdc = createInsertPdcPlan(
      tracks,
      [
        {
          id: 'return-fx',
          strip: {
            ...createDefaultStrip(),
            inserts: [{ processor: 'dynamics.limiter', params: {}, enabled: true }],
          },
        },
        {
          id: 'unused-latent-return',
          strip: {
            ...createDefaultStrip(),
            inserts: [{ processor: 'dynamics.expander', params: {}, enabled: true }],
          },
        },
      ],
      resolve,
    );

    expect(pdc.maxLatencySamples).toBe(96);
    expect(pdc.delayFor(tracks[0])).toBe(0);
    expect(pdc.delayFor(tracks[1])).toBe(64);
    expect(pdc.delayFor(tracks[2])).toBe(32);
  });
});

describe('insert latency against the real core catalog', () => {
  beforeAll(async () => {
    await core.init({ wasmBinary: readFileSync(`${process.cwd()}/src/wasm/sonare.wasm`) });
  });

  it('reports the latency of a linear-phase EQ and none for a zero-latency insert', () => {
    const resolve = insertLatencyResolverFromCatalog(
      core.masteringProcessorCatalog(),
      48000,
      core.masteringInsertTiming,
    );

    expect(resolve({ processor: 'eq.linearPhase', params: {} })).toBeGreaterThan(0);
    expect(resolve({ processor: 'utility.gain', params: {} })).toBe(0);
  });
});
