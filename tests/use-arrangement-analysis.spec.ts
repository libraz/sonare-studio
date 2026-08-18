import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArrangementAnalysis } from '@/composables/useArrangementAnalysis';
import { addMidiClip, setActiveClip } from '@/project/command/clips';
import { clearHistory } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { addTrack } from '@/project/command/tracks';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('useArrangementAnalysis', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('analyzes on demand and excludes percussion tracks', () => {
    // A C-major melody on the default clip.
    for (const [i, pitch] of [60, 64, 67, 72].entries()) {
      addNote({ pitch, startPpq: i, durationPpq: 1 });
    }
    // A drum track with GM percussion notes on channel 10.
    const drumTrack = addTrack({ name: 'Drums' });
    const drumClip = addMidiClip({ trackId: drumTrack, lengthPpq: 8 });
    setActiveClip(drumClip);
    addNote({ pitch: 36, startPpq: 0, durationPpq: 1, channel: 9 });
    addNote({ pitch: 42, startPpq: 1, durationPpq: 1, channel: 9 });

    const analysis = useArrangementAnalysis();
    expect(analysis.analyzed.value).toBe(false);
    analysis.analyze();
    expect(analysis.analyzed.value).toBe(true);
    expect(analysis.excludedTrackNames.value).toContain('Drums');
    // No conflict is attributed to the excluded drum track.
    expect(analysis.conflicts.value.every((c) => c.trackName !== 'Drums')).toBe(true);
    // Tension is sampled across the piece.
    expect(analysis.tension.value.length).toBeGreaterThan(0);
    for (const point of analysis.tension.value) {
      expect(point.tension).toBeGreaterThanOrEqual(0);
      expect(point.tension).toBeLessThanOrEqual(1);
    }
  });

  it('reads the piece structure in the same run', () => {
    for (let bar = 0; bar < 4; bar += 1) {
      for (const [beat, pitch] of [60, 64, 67, 72].entries()) {
        addNote({ pitch, startPpq: bar * 4 + beat, durationPpq: 1 });
      }
    }

    const analysis = useArrangementAnalysis();
    analysis.analyze();

    expect(analysis.phrases.value.length).toBeGreaterThan(0);
    expect(analysis.phrases.value[0]?.startPpq).toBe(0);
    expect(analysis.hypermeter.value?.groupBars).toBeGreaterThan(0);
    // Every ranked cadence points at a phrase the same run produced.
    for (const cadence of analysis.cadences.value) {
      expect(analysis.phrases.value[cadence.phraseIndex]).toBeDefined();
    }
  });

  it('reset clears the cached results', () => {
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
    const analysis = useArrangementAnalysis();
    analysis.analyze();
    expect(analysis.analyzed.value).toBe(true);
    analysis.reset();
    expect(analysis.analyzed.value).toBe(false);
    expect(analysis.conflicts.value).toEqual([]);
    expect(analysis.tension.value).toEqual([]);
    expect(analysis.phrases.value).toEqual([]);
    expect(analysis.cadences.value).toEqual([]);
    expect(analysis.hypermeter.value).toBeNull();
  });
});
