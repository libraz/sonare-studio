import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimatedTailSeconds } from '@/export/audio-preflight';
import {
  addGroupTrack,
  addMixerBus,
  applyMixerSceneJson,
  applyTrackChannelPreset,
  clearHistory,
  setStripOutputBus,
  setTrackGroup,
} from '@/project/commands';
import { createInsertPdcPlan, insertLatencyResolverFromCatalog } from '@/project/insert-latency';
import { audibleOutputBusId, createDefaultStrip, type InsertSlot } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import { useProjectStore } from '@/project/store';
import { trackChannelPresetFromTrack } from '@/project/track-preset';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const resolve = insertLatencyResolverFromCatalog([{ id: 'lookahead', latencySamples: 240 }]);
const latentStrip = () => ({
  ...createDefaultStrip(),
  inserts: [{ processor: 'lookahead', params: {}, enabled: true }],
});

describe('insert PDC over the bus graph', () => {
  it('sums insert latency across a chained bus route', () => {
    const chained = { id: 1, kind: 'audio', mixer: { ...createDefaultStrip(), outputBusId: 'x' } };
    const direct = { id: 2, kind: 'audio', mixer: createDefaultStrip() };
    const pdc = createInsertPdcPlan(
      [chained, direct],
      [
        { id: 'x', strip: { ...createDefaultStrip(), outputBusId: 'y' } },
        { id: 'y', strip: latentStrip() },
      ],
      resolve,
    );

    expect(pdc.maxLatencySamples).toBe(240);
    expect(pdc.delayFor(chained)).toBe(0);
    expect(pdc.delayFor(direct)).toBe(240);
  });

  it('follows a group bus into a chained return and stops on a cycle', () => {
    const member = { id: 1, kind: 'midi', groupId: 3, mixer: createDefaultStrip() };
    const group = { id: 3, kind: 'group', mixer: { ...createDefaultStrip(), outputBusId: 'x' } };
    const direct = { id: 2, kind: 'audio', mixer: createDefaultStrip() };
    const pdc = createInsertPdcPlan(
      [member, group, direct],
      [
        { id: 'x', strip: { ...latentStrip(), outputBusId: 'y' } },
        { id: 'y', strip: { ...latentStrip(), outputBusId: 'x' } },
      ],
      resolve,
    );

    expect(pdc.maxLatencySamples).toBe(480);
    expect(pdc.delayFor(member)).toBe(0);
    expect(pdc.delayFor(direct)).toBe(480);
  });

  it('ignores an inaudible route stored on a group member', () => {
    const member = {
      id: 1,
      kind: 'audio',
      groupId: 3,
      mixer: { ...createDefaultStrip(), outputBusId: 'latent' },
    };
    const group = { id: 3, kind: 'group', mixer: createDefaultStrip() };
    const pdc = createInsertPdcPlan(
      [member, group],
      [{ id: 'latent', strip: latentStrip() }],
      resolve,
    );

    expect(pdc.maxLatencySamples).toBe(0);
    expect(pdc.delayFor(member)).toBe(0);
  });
});

describe('setStripOutputBus on group members', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('refuses a route the group bus would override but lets a stale one be cleared', () => {
    const trackId = store.tracks[0].id;
    const busId = addMixerBus();
    setStripOutputBus(trackId, busId);
    const groupId = addGroupTrack();
    setTrackGroup(trackId, groupId);

    const other = addMixerBus();
    expect(() => setStripOutputBus(trackId, other)).toThrow(/group member/);
    expect(store.tracks[0].mixer?.outputBusId).toBe(busId);

    setStripOutputBus(trackId, null);
    expect(store.tracks[0].mixer?.outputBusId).toBeUndefined();
    // The group track itself still routes its bus.
    setStripOutputBus(groupId, other);
    expect(store.tracks.find((track) => track.id === groupId)?.mixer?.outputBusId).toBe(other);
  });
});

describe('audible output routes', () => {
  it('ignores a route stored on a live or document group member', () => {
    const mixer = { ...createDefaultStrip(), outputBusId: 'fx' };
    expect(audibleOutputBusId({ mixer })).toBe('fx');
    expect(audibleOutputBusId({ groupId: 3, mixer })).toBeUndefined();
    expect(audibleOutputBusId({ groupIndex: 0, mixer })).toBeUndefined();
  });

  it('estimates the tail through a chained bus and not through a member route', () => {
    const tail = (seconds: number): InsertSlot => ({
      processor: `tail-${seconds}`,
      params: {},
      enabled: true,
    });
    const strip = (inserts: InsertSlot[], outputBusId?: string) => ({
      ...createDefaultStrip(),
      inserts,
      ...(outputBusId ? { outputBusId } : {}),
    });
    const doc: ProjectDocument = {
      schemaVersion: 3,
      name: 'Tail',
      sampleRate: 48000,
      tempoSegments: [{ startPpq: 0, bpm: 120 }],
      timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
      tracks: [
        { name: 'Drums', kind: 'audio', clips: [], mixer: strip([], 'x') },
        { name: 'Group', kind: 'group', clips: [], mixer: strip([]) },
        { name: 'Member', kind: 'audio', clips: [], groupIndex: 1, mixer: strip([], 'big') },
      ],
      markers: [],
      sections: [],
      mixer: {
        master: createDefaultStrip(),
        buses: [
          { id: 'x', name: 'X', gainDb: 0, strip: strip([tail(1)], 'y') },
          { id: 'y', name: 'Y', gainDb: 0, strip: strip([tail(2)]) },
          { id: 'big', name: 'Big', gainDb: 0, strip: strip([tail(9)]) },
        ],
      },
    } as ProjectDocument;
    const resolve = (slot: Pick<InsertSlot, 'processor'>) => Number(slot.processor.slice(5));

    expect(estimatedTailSeconds(doc, new Set([0]), resolve)).toBe(3);
    expect(estimatedTailSeconds(doc, new Set([2]), resolve)).toBe(0);
  });
});

describe('route writers on group members', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  it('scene apply and preset paste do not store a route the group bus overrides', () => {
    const trackId = store.tracks[0].id;
    const busId = addMixerBus();
    setStripOutputBus(trackId, busId);
    const preset = trackChannelPresetFromTrack(store.tracks[0], 'Routed');
    setStripOutputBus(trackId, null);
    const groupId = addGroupTrack();
    setTrackGroup(trackId, groupId);

    applyTrackChannelPreset(trackId, preset);
    expect(store.tracks[0].mixer?.outputBusId).toBeUndefined();

    applyMixerSceneJson(
      JSON.stringify({
        strips: [{ id: `track-${trackId}` }],
        buses: [{ id: busId }],
        connections: [{ source: `track-${trackId}`, destination: busId }],
      }),
    );
    expect(store.tracks.find((track) => track.id === trackId)?.mixer?.outputBusId).toBeUndefined();
  });
});
