import { createPinia, setActivePinia } from 'pinia';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHistory, redo, undo } from '@/project/command/history';
import {
  deleteTime,
  duplicateTime,
  setTempoSegments,
  setTimeSignatures,
} from '@/project/command/timeline';
import { setWasmModule } from '@/project/runtime';
import { useProjectStore } from '@/project/store';
import { deleteTimelineSegments } from '@/project/timeline-edit';
import type { TempoSegment, TimeSignatureSegment } from '@/project/types';
import { createFakeWasmModule } from './fake-wasm';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule: create } = await import('./fake-wasm');
  const fakeModule = create();
  return { ensureWasm: async () => fakeModule };
});

const tempo = (store: ReturnType<typeof useProjectStore>) =>
  store.tempoSegments.map(({ startPpq, bpm, endBpm }) => ({
    startPpq,
    bpm,
    ...(endBpm !== undefined && endBpm !== 0 ? { endBpm } : {}),
  }));
const meters = (store: ReturnType<typeof useProjectStore>) =>
  store.timeSignatures.map(({ startPpq, numerator, denominator }) => ({
    startPpq,
    numerator,
    denominator,
  }));

describe('tempo and meter breakpoints written by time commands', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeAll(() => {
    setWasmModule(createFakeWasmModule());
  });

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  const useMaps = (tempoMap: TempoSegment[], meterMap: TimeSignatureSegment[]) => {
    setTempoSegments(tempoMap);
    setTimeSignatures(meterMap);
    clearHistory();
  };

  describe('duplicateTime', () => {
    it('leaves a constant tempo and meter map as it was', () => {
      useMaps([{ startPpq: 0, bpm: 120 }], [{ startPpq: 0, numerator: 4, denominator: 4 }]);
      duplicateTime(0, 16);
      expect(tempo(store)).toEqual([{ startPpq: 0, bpm: 120 }]);
      expect(meters(store)).toEqual([{ startPpq: 0, numerator: 4, denominator: 4 }]);
      expect(undo()).toBe(true);
      expect(redo()).toBe(true);
      expect(tempo(store)).toEqual([{ startPpq: 0, bpm: 120 }]);
    });

    it('restores the source tempo at the copy when the window changes it', () => {
      useMaps(
        [
          { startPpq: 0, bpm: 120 },
          { startPpq: 8, bpm: 90 },
        ],
        [{ startPpq: 0, numerator: 4, denominator: 4 }],
      );
      duplicateTime(0, 16);
      expect(tempo(store)).toEqual([
        { startPpq: 0, bpm: 120 },
        { startPpq: 8, bpm: 90 },
        { startPpq: 16, bpm: 120 },
        { startPpq: 24, bpm: 90 },
      ]);
    });

    it('keeps a redundant breakpoint the user placed', () => {
      useMaps(
        [
          { startPpq: 0, bpm: 120 },
          { startPpq: 20, bpm: 120 },
        ],
        [{ startPpq: 0, numerator: 4, denominator: 4 }],
      );
      duplicateTime(0, 16);
      expect(tempo(store)).toEqual([
        { startPpq: 0, bpm: 120 },
        { startPpq: 36, bpm: 120 },
      ]);
    });

    it('restarts a tempo ramp at the copy', () => {
      useMaps(
        [
          { startPpq: 0, bpm: 100, endBpm: 140 },
          { startPpq: 16, bpm: 140 },
        ],
        [{ startPpq: 0, numerator: 4, denominator: 4 }],
      );
      duplicateTime(0, 16);
      expect(tempo(store)).toEqual([
        { startPpq: 0, bpm: 100, endBpm: 140 },
        { startPpq: 16, bpm: 100, endBpm: 140 },
        { startPpq: 32, bpm: 140 },
      ]);
    });

    it('keeps a same-meter boundary that lands off the bar grid', () => {
      useMaps([{ startPpq: 0, bpm: 120 }], [{ startPpq: 0, numerator: 3, denominator: 4 }]);
      duplicateTime(0, 4);
      expect(meters(store)).toEqual([
        { startPpq: 0, numerator: 3, denominator: 4 },
        { startPpq: 4, numerator: 3, denominator: 4 },
      ]);
    });
  });

  describe('deleteTime', () => {
    it('keeps a redundant breakpoint the user placed after the cut', () => {
      useMaps(
        [
          { startPpq: 0, bpm: 120 },
          { startPpq: 8, bpm: 120 },
          { startPpq: 12, bpm: 100 },
        ],
        [{ startPpq: 0, numerator: 4, denominator: 4 }],
      );
      deleteTime(2, 4);
      expect(tempo(store)).toEqual([
        { startPpq: 0, bpm: 120 },
        { startPpq: 6, bpm: 120 },
        { startPpq: 10, bpm: 100 },
      ]);
    });
  });

  describe('deleteTimelineSegments', () => {
    it('drops only the left-edge boundary it creates when nothing changes there', () => {
      expect(
        deleteTimelineSegments(
          [
            { startPpq: 0, bpm: 120 },
            { startPpq: 4, bpm: 120 },
          ],
          6,
          8,
        ),
      ).toEqual([
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 120 },
      ]);
    });

    it('keeps a user breakpoint that the cut brings next to an equal one', () => {
      expect(
        deleteTimelineSegments(
          [
            { startPpq: 0, bpm: 120 },
            { startPpq: 4, bpm: 90 },
            { startPpq: 8, bpm: 120 },
          ],
          4,
          8,
        ),
      ).toEqual([
        { startPpq: 0, bpm: 120 },
        { startPpq: 4, bpm: 120 },
      ]);
    });
  });
});
