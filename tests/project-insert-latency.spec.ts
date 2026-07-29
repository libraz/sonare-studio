import { describe, expect, it } from 'vitest';
import {
  createInsertPdcPlan,
  insertChainLatencySamples,
  insertLatencyResolverFromCatalog,
  maxTrackInsertLatencySamples,
  trackPdcDelaySamples,
} from '@/project/insert-latency';
import { createDefaultStrip } from '@/project/mixer';

describe('insert latency helpers', () => {
  it('sums enabled insert latencies from catalog metadata', () => {
    const resolve = insertLatencyResolverFromCatalog([
      { id: 'linear.eq', latencySamples: 128.4 },
      { id: 'lookahead.limiter', latencySamples: 64 },
      { id: 'bad', latencySamples: -1 },
    ]);

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

  it('falls back to explicit slot latency and lookahead params when catalog metadata is missing', () => {
    const resolve = insertLatencyResolverFromCatalog(
      [{ id: 'catalog.wins', latencySamples: 256 }, { id: 'param.fallback' }],
      { sampleRate: 48000 },
    );

    expect(resolve({ processor: 'catalog.wins', params: { lookaheadMs: 10 } })).toBe(256);
    expect(resolve({ processor: 'param.fallback', params: { lookaheadMs: 2.5 } })).toBe(120);
    expect(resolve({ processor: 'unknown.samples', params: { latencySamples: 33.4 } })).toBe(33);
    expect(resolve({ processor: 'unknown.delay', params: { delaySamples: 12 } })).toBe(12);
    expect(resolve({ processor: 'unknown.none', params: { lookaheadMs: 2.5 } })).toBe(120);
  });

  it('ignores lookaheadMs fallback without a sample rate', () => {
    const resolve = insertLatencyResolverFromCatalog(undefined);

    expect(resolve({ processor: 'lookahead', params: { lookaheadMs: 10 } })).toBe(0);
    expect(resolve({ processor: 'samples', params: { lookaheadSamples: 512 } })).toBe(512);
  });

  it('computes per-track PDC delays while preserving manual channel delay', () => {
    const resolve = insertLatencyResolverFromCatalog([
      { id: 'linear.eq', latencySamples: 128 },
      { id: 'lookahead.limiter', latencySamples: 64 },
    ]);
    const tracks = [
      {
        kind: 'audio',
        mixer: {
          ...createDefaultStrip(),
          inserts: [{ processor: 'linear.eq', params: {}, enabled: true }],
        },
      },
      {
        kind: 'audio',
        mixer: {
          ...createDefaultStrip(),
          channelDelaySamples: 8,
          inserts: [{ processor: 'lookahead.limiter', params: {}, enabled: true }],
        },
      },
      { kind: 'audio', frozen: { assetId: 'frozen' }, mixer: createDefaultStrip() },
      { kind: 'group', mixer: createDefaultStrip() },
    ];

    const maxLatency = maxTrackInsertLatencySamples(tracks, resolve);
    expect(maxLatency).toBe(128);
    expect(trackPdcDelaySamples(tracks[0], maxLatency, resolve)).toBe(0);
    expect(trackPdcDelaySamples(tracks[1], maxLatency, resolve)).toBe(72);
    expect(trackPdcDelaySamples(tracks[2], maxLatency, resolve)).toBe(128);
    expect(trackPdcDelaySamples(tracks[3], maxLatency, resolve)).toBe(128);
  });

  it('includes return and group-bus insert latency in the routed signal path', () => {
    const resolve = insertLatencyResolverFromCatalog([
      { id: 'track.linear', latencySamples: 32 },
      { id: 'return.linear', latencySamples: 96 },
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
      ],
      resolve,
    );

    expect(pdc.maxLatencySamples).toBe(96);
    expect(pdc.delayFor(tracks[0])).toBe(0);
    expect(pdc.delayFor(tracks[1])).toBe(64);
    expect(pdc.delayFor(tracks[2])).toBe(32);
  });
});
