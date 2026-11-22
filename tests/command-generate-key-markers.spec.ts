import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenerationTargetFrame } from '@/compose/generation-target';
import { buildBackingPlan } from '@/project/command/generate-backing';
import { buildBassPlan } from '@/project/command/generate-bass';
import { buildCounterPlan } from '@/project/command/generate-counter-melody';
import { buildMotifCell } from '@/project/command/generate-motif';
import { generateProgressionCommand } from '@/project/command/generate-progression';
import { generationKeyAt } from '@/project/command/generation-key';
import { clearHistory } from '@/project/command/history';
import { addNote } from '@/project/command/notes';
import { setMarker } from '@/project/command/timeline';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('generation key follows Key markers', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('resolves the marker key after a Key marker and the declared key before it', () => {
    setMarker(null, 8, 'Key: G');
    expect(generationKeyAt(store, 0).rootPc).toBe(0);
    expect(generationKeyAt(store, 8).rootPc).toBe(7);
  });

  it('writes a motif that starts after a Key marker in that key', () => {
    setMarker(null, 8, 'Key: G');
    const frame = (startPpq: number) =>
      createGenerationTargetFrame({
        startPpq,
        endPpq: startPpq + 4,
        chords: [],
        timeSignatures: store.timeSignatures,
      });
    const params = { bars: 1, seed: 3, develop: false } as const;
    const afterMarker = buildMotifCell(store, params, frame(8), []).notes;

    store.scaleHighlight = { enabled: true, rootPc: 7, modeMask: MAJOR_MODE_MASK };
    const inG = buildMotifCell(store, params, frame(0), []).notes;
    expect(afterMarker).toEqual(inG);
  });

  it('writes progressions, bass, backing and counter-melody in the marker key', () => {
    const generate = () => {
      generateProgressionCommand({ bars: 4, seed: 1 });
      const chords = [...store.chords];
      return {
        chords: chords.map(({ rootPc, quality, startPpq, endPpq }) => ({
          rootPc,
          quality,
          startPpq,
          endPpq,
        })),
        bass: buildBassPlan(store, { seed: 1 }, chords)?.notes,
        backing: buildBackingPlan(store, {}, chords)?.notes,
        counter: buildCounterPlan(store, { seed: 1 }, chords)?.notes,
      };
    };
    for (const [pitch, startPpq] of [
      [67, 0],
      [69, 1],
      [71, 2],
      [72, 3],
    ]) {
      addNote({ pitch, startPpq, durationPpq: 1 });
    }
    setMarker(null, 0, 'Key: G');
    const fromMarker = generate();

    setMarker(null, 0, '');
    store.scaleHighlight = { enabled: true, rootPc: 7, modeMask: MAJOR_MODE_MASK };
    const declared = generate();

    expect(fromMarker.chords.length).toBeGreaterThan(0);
    for (const part of [fromMarker.bass, fromMarker.backing, fromMarker.counter]) {
      expect(part?.length).toBeGreaterThan(0);
    }
    expect(fromMarker).toEqual(declared);
  });
});
