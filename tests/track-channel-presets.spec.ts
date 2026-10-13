import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addInsert,
  addMixerBus,
  addTrack,
  applyTrackChannelPreset,
  clearHistory,
  copyTrackChannelPreset,
  pasteTrackChannelPreset,
  setInsertSidechain,
  setSend,
  setTrackInstrument,
  setTrackMidiFx,
  undo,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { normalizeTrackChannelPreset, trackChannelPresetFromTrack } from '@/project/track-preset';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('track channel presets', () => {
  let store: ReturnType<typeof useProjectStore>;
  let sourceId: number;
  let targetId: number;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    sourceId = store.tracks[0].id;
    targetId = addTrack({ name: 'Target' });
    clearHistory();
  });

  it('copies a complete MIDI channel, rebases insert ids, and undoes as one edit', () => {
    const keyId = addTrack({ name: 'Sidechain key' });
    const busId = addMixerBus({ name: 'Verb' });
    addInsert(sourceId, 'dynamics.compressor', { thresholdDb: -18 });
    setInsertSidechain(sourceId, 0, keyId);
    setSend(sourceId, busId, { levelDb: -9, enabled: true });
    setTrackInstrument(sourceId, { kind: 'synth-preset', preset: 'warm-pad' });
    setTrackMidiFx(sourceId, { ...store.tracks[0].midiFx!, transposeSemitones: 7 });

    const source = store.tracks.find((track) => track.id === sourceId)!;
    const sourceInsertId = source.mixer!.inserts[0].id;
    copyTrackChannelPreset(sourceId);
    pasteTrackChannelPreset(targetId);

    const target = store.tracks.find((track) => track.id === targetId)!;
    expect(target.instrument).toEqual({ kind: 'synth-preset', preset: 'warm-pad' });
    expect(target.midiFx?.transposeSemitones).toBe(7);
    expect(target.mixer).toMatchObject({ sends: [{ busId, levelDb: -9, enabled: true }] });
    expect(target.mixer?.inserts[0]).toMatchObject({
      processor: 'dynamics.compressor',
      sidechainSourceTrackId: keyId,
    });
    expect(target.mixer?.inserts[0].id).not.toBe(sourceInsertId);

    expect(undo()).toBe(true);
    const restored = store.tracks.find((track) => track.id === targetId)!;
    expect(restored.instrument).toBeUndefined();
    expect(restored.mixer).toBeUndefined();
  });

  it('reads saved presets in current spelling for retired processor ids and filter models', () => {
    addInsert(sourceId, 'eq.passiveTube');
    setTrackInstrument(sourceId, { kind: 'synth-patch', patch: { filterModel: 'svf' } });
    const saved = JSON.parse(
      JSON.stringify(trackChannelPresetFromTrack(store.tracks[0], 'Legacy'))
        .replace('"eq.passiveTube"', '"eq.pultec"')
        .replace('"svf"', '"moog-ladder"'),
    );

    const preset = normalizeTrackChannelPreset(saved);

    expect(preset.strip.inserts[0].processor).toBe('eq.passiveTube');
    expect(preset.instrument).toEqual({
      kind: 'synth-patch',
      patch: { filterModel: 'transistor-ladder' },
    });
  });

  it('drops routing and sidechain references that do not exist in the destination project', () => {
    const source = store.tracks.find((track) => track.id === sourceId)!;
    const preset = trackChannelPresetFromTrack(source, 'Portable');
    preset.strip.sends = [{ busId: 'missing-bus', levelDb: -6, enabled: true }];
    preset.strip.outputBusId = 'missing-bus';
    preset.strip.inserts = [
      {
        id: 'source-processor',
        processor: 'dynamics.compressor',
        params: {},
        enabled: true,
        sidechainSourceTrackId: 999_999,
      },
    ];

    applyTrackChannelPreset(targetId, preset);
    const target = store.tracks.find((track) => track.id === targetId)!;
    expect(target.mixer?.sends).toEqual([]);
    expect(target.mixer?.outputBusId).toBeUndefined();
    expect(target.mixer?.inserts[0].sidechainSourceTrackId).toBeUndefined();
    expect(target.mixer?.inserts[0].id).not.toBe('source-processor');
  });
});
