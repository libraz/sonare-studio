import { describe, expect, it, vi } from 'vitest';
import {
  createInsertPdcPlan,
  type InsertTimingQuery,
  insertChainLatencySamples,
  insertLatencyResolverFromCatalog,
} from '@/project/insert-latency';
import { createDefaultStrip } from '@/project/mixer';

describe('insert latency helpers', () => {
  it('sums enabled insert latencies from catalog metadata', () => {
    const resolve = insertLatencyResolverFromCatalog(
      [
        { id: 'linear.eq', latencySamples: 128.4 },
        { id: 'lookahead.limiter', latencySamples: 64 },
        { id: 'bad', latencySamples: -1 },
      ],
      48000,
    );

    expect(
      insertChainLatencySamples(
        [
          { processor: 'linear.eq', params: {}, enabled: true },
          { processor: 'lookahead.limiter', params: {}, enabled: false },
          { processor: 'bad', params: {}, enabled: true },
          { processor: 'unknown', params: {}, enabled: true },
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
    expect(resolve({ processor: 'unknown', params: { lookaheadMs: 5 } })).toBe(0);
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
    const resolve = insertLatencyResolverFromCatalog([
      { id: 'track.linear', latencySamples: 32 },
      { id: 'return.linear', latencySamples: 96 },
      { id: 'unused.linear', latencySamples: 4096 },
      { id: 'group.linear', latencySamples: 64 },
    ]);
    const tracks = [
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
          inserts: [{ processor: 'track.linear', params: {}, enabled: true }],
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
          inserts: [{ processor: 'group.linear', params: {}, enabled: true }],
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
            inserts: [{ processor: 'return.linear', params: {}, enabled: true }],
          },
        },
        {
          id: 'unused-latent-return',
          strip: {
            ...createDefaultStrip(),
            inserts: [{ processor: 'unused.linear', params: {}, enabled: true }],
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
