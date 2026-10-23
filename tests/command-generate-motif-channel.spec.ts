import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMidiClip } from '@/project/command/clips';
import { generateMotifCommand } from '@/project/command/generate-motif';
import { clearHistory } from '@/project/command/history';
import { addTrack, setTrackPercussion } from '@/project/command/tracks';
import { useProjectStore } from '@/project/store';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('generateMotifCommand note channel', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  function activeClipOn(trackId: number): void {
    store.clipId = addMidiClip({ trackId, startPpq: 0, lengthPpq: 8 });
    store.refresh();
  }

  it('refuses to write pitched motif notes into a drum-track clip in either mode', () => {
    const trackId = addTrack({ name: 'Kit' });
    setTrackPercussion(trackId, true);
    activeClipOn(trackId);

    expect(() => generateMotifCommand({ bars: 1, mode: 'append', develop: false })).toThrow(
      /percussion/,
    );
    expect(() => generateMotifCommand({ bars: 1, mode: 'replace', develop: false })).toThrow(
      /percussion/,
    );
    expect(store.activeClip?.notes ?? []).toEqual([]);
  });

  it('keeps a melodic clip on its own channel', () => {
    const trackId = addTrack({ name: 'Lead' });
    activeClipOn(trackId);

    generateMotifCommand({ bars: 1, mode: 'replace', develop: false });

    expect((store.activeClip?.notes ?? []).every((note) => note.channel === 0)).toBe(true);
  });
});
