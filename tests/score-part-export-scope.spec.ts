import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { exportMusicXml } from '@/notation/io';
import type { VerovioClient } from '@/notation/verovio';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  renameTrack,
  setActiveClip,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { ScoreLayoutSettings } from '@/ui/score/layout';
import { useScoreNotation } from '@/ui/score/use-score-notation';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/composables/useLossConfirm', () => ({
  confirmLossReport: vi.fn(async () => true),
}));

vi.mock('@/notation/io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/notation/io')>()),
  exportMusicXml: vi.fn(),
}));

const LAYOUT: ScoreLayoutSettings = {
  pageFormat: 'a4',
  landscape: false,
  pageMarginMm: 12,
  scalePercent: 100,
  spacingStaff: 8,
  barsPerSystem: 4,
  barsPerPage: 16,
};

function harness(store: ReturnType<typeof useProjectStore>, fullScore: boolean) {
  const client = {
    failed: false,
    load: vi.fn(async () => 1),
    renderPage: vi.fn(async () => '<svg/>'),
    getTimemap: vi.fn(async () => []),
    setLayout: vi.fn(async () => 1),
    cancelPending: vi.fn(),
    dispose: vi.fn(),
  } as unknown as VerovioClient;
  return useScoreNotation({
    store,
    client: shallowRef(client),
    getDivisionPpq: () => 0.25,
    getTimeSig: () => ({ beats: 4, beatUnit: 4 }),
    getMeasureLenPpq: () => 4,
    getScreenClipLengthPpq: () => Math.max(4, store.clipLengthPpq),
    getTimeSignatures: () => store.timeSignatures,
    getPickupLengthPpq: () => store.pickupLengthPpq,
    getKeyFifths: () => 0,
    getChordsEnabled: () => false,
    getFullScoreEnabled: () => fullScore,
    getLayoutSettings: () => LAYOUT,
    resetPlayheadScan: vi.fn(),
    createExportClient: () => client,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function partNames(xml: string): string[] {
  return [...xml.matchAll(/<part-name>([^<]*)<\/part-name>/g)].map((m) => m[1]);
}

describe('part names and part-export loss scope', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.mocked(exportMusicXml).mockClear();
    vi.mocked(confirmLossReport).mockClear();
    await store.init();
    renameTrack(store.tracks[0].id, 'Bass line');
    addNote({ pitch: 40, startPpq: 0, durationPpq: 1 });
  });

  it('names the active-clip part after its track, as Full Score does', async () => {
    const single = harness(store, false);
    await single.transcribe();
    const activeXml = single.getCurrentXml();
    const full = harness(store, true);
    await full.transcribe();
    expect(partNames(activeXml)).toEqual(['Bass line']);
    expect(partNames(full.getCurrentXml())).toEqual(['Bass line']);
  });

  it('reports losses from every clip of the track when exporting a part in Full Score', async () => {
    const trackId = store.activeTrackId;
    const second = addMidiClip({ trackId, startPpq: 4, lengthPpq: 4, name: 'Second' });
    setActiveClip(second);
    addNote({ pitch: 43, startPpq: 4.1, durationPpq: 1 });
    const other = addTrack({ name: 'Other', kind: 'midi' });
    const otherClip = addMidiClip({ trackId: other, startPpq: 0, lengthPpq: 4, name: 'O' });
    setActiveClip(otherClip);
    addNote({ pitch: 50, startPpq: 0.1, durationPpq: 1 });
    setActiveClip(store.clips.find((clip) => clip.trackId === trackId)!.id);

    const notation = harness(store, true);
    await notation.transcribe();
    notation.onExportPartMusicXml();
    await settle();

    const loss = JSON.stringify(vi.mocked(confirmLossReport).mock.calls[0][0]);
    expect(loss).toContain('offGridNotes');
    // Only the one off-grid note of this track's non-active clip counts.
    expect(loss).toMatch(/"count":1\b/);
  });
});
