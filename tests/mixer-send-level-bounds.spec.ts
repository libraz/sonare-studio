import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMixerBus, clearHistory, setSend } from '@/project/commands';
import { MAX_STRIP_GAIN_DB, MIN_STRIP_GAIN_DB } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { normalizeTrackChannelPreset, trackChannelPresetFromTrack } from '@/project/track-preset';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('send levels share the strip gain range', () => {
  let trackId: number;
  let busId: string;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    trackId = store.tracks[0].id;
    busId = addMixerBus({ name: 'FX' });
  });

  it('accepts the range ends and refuses a level past either one', () => {
    setSend(trackId, busId, { levelDb: MAX_STRIP_GAIN_DB });
    setSend(trackId, busId, { levelDb: MIN_STRIP_GAIN_DB });
    expect(() => setSend(trackId, busId, { levelDb: MAX_STRIP_GAIN_DB + 1 })).toThrow(RangeError);
    expect(() => setSend(trackId, busId, { levelDb: MIN_STRIP_GAIN_DB - 1 })).toThrow(RangeError);
  });

  it('refuses a track preset whose send is out of range, as it refuses its strip gain', () => {
    const track = useProjectStore().tracks[0];
    const preset = trackChannelPresetFromTrack(track, 'Loud send');
    preset.strip.sends = [{ busId, levelDb: MAX_STRIP_GAIN_DB + 1, enabled: true }];
    expect(() => normalizeTrackChannelPreset(preset)).toThrow(RangeError);
  });
});
