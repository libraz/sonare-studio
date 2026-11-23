import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { downloadBlob } from '@/lib/download';
import {
  loadPdfTextFont,
  PdfTextFontUnavailableError,
  pdfTextFontFromBytes,
} from '@/notation/pdf-font';
import { createPdfPageWriter } from '@/notation/print';
import type { VerovioClient } from '@/notation/verovio';
import { addNote, clearHistory, renameTrack } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { ScoreLayoutSettings } from '@/ui/score/layout';
import { useScoreNotation } from '@/ui/score/use-score-notation';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/notation/pdf-font', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/notation/pdf-font')>()),
  loadPdfTextFont: vi.fn(),
}));

vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

vi.mock('@/notation/print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/notation/print')>()),
  createPdfPageWriter: vi.fn(async () => ({
    addPage: vi.fn(async () => undefined),
    close: vi.fn(() => new Blob()),
    undrawable: vi.fn(() => []),
  })),
}));

vi.mock('@/composables/useDialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/composables/useDialogs')>()),
  confirmDialog: vi.fn(async () => true),
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

const NOTO_SANS_JP = pdfTextFontFromBytes(
  new Uint8Array(
    readFileSync(
      'node_modules/@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf',
    ),
  ),
);

async function exportPdfWithTrackName(trackName: string) {
  setActivePinia(createPinia());
  const store = useProjectStore();
  store.dispose();
  clearHistory();
  await store.init();
  store.projectName = 'Etude';
  addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
  renameTrack(store.tracks[0].id, trackName);
  const client = {
    failed: false,
    load: vi.fn(async () => 1),
    renderPage: vi.fn(async () => '<svg data-page="1"/>'),
    getTimemap: vi.fn(async () => []),
    setLayout: vi.fn(async () => 1),
    cancelPending: vi.fn(),
    dispose: vi.fn(),
  } as unknown as VerovioClient;
  const notation = useScoreNotation({
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
    getFullScoreEnabled: () => false,
    getLayoutSettings: () => LAYOUT,
    resetPlayheadScan: vi.fn(),
    createExportClient: () => client,
  });
  await notation.transcribe();
  notation.onExportPdf();
  await vi.waitFor(() => expect(notation.exporting.value).toBe(false));
  store.dispose();
  return notation;
}

describe('score PDF export text font', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => {
    settings.set('language', 'en');
    vi.mocked(confirmDialog).mockClear();
    vi.mocked(createPdfPageWriter).mockClear();
    vi.mocked(downloadBlob).mockClear();
  });
  afterEach(() => settings.set('language', previous));

  it('lists each character the embedded font lacks, one by one, before writing', async () => {
    vi.mocked(loadPdfTextFont).mockResolvedValue(NOTO_SANS_JP);
    const notation = await exportPdfWithTrackName('한국 ピアノ 们 Ђ Piano é 右手');
    expect(notation.error.value).toBe('');
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const { message } = vi.mocked(confirmDialog).mock.calls[0][0];
    // Four code points counted; the shared loss formatter names the first three.
    expect(message).toContain('4 character(s): 한, 국, 们, …');
    for (const character of ['ピ', '右', 'é']) expect(message).not.toContain(character);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
  });

  it('tells the user the font could not be loaded and points at Print, writing nothing', async () => {
    vi.mocked(loadPdfTextFont).mockRejectedValue(
      new PdfTextFontUnavailableError({ cause: new TypeError('Failed to fetch') }),
    );
    const notation = await exportPdfWithTrackName('ピアノ');
    expect(notation.error.value).toContain('could not be downloaded');
    expect(notation.error.value).toContain('Print');
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(createPdfPageWriter).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
