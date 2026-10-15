import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, shallowRef } from 'vue';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { exportMusicXml } from '@/notation/io';
import type { VerovioClient } from '@/notation/verovio';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  deleteClip,
  renameTrack,
  setActiveClip,
} from '@/project/commands';
import {
  loadProjectDocument,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from '@/project/serialization';
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

vi.mock('@/notation/print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/notation/print')>()),
  downloadBlob: vi.fn(),
}));

interface FakeVerovioClient {
  client: VerovioClient;
  load: ReturnType<typeof vi.fn>;
  renderPage: ReturnType<typeof vi.fn>;
}

function fakeVerovio(): FakeVerovioClient {
  const load = vi.fn(async () => 1);
  const renderPage = vi.fn(async () => '<svg data-page="1"/>');
  return {
    client: {
      failed: false,
      load,
      renderPage,
      getTimemap: vi.fn(async () => []),
      setLayout: vi.fn(async () => 1),
      cancelPending: vi.fn(),
      dispose: vi.fn(),
    } as unknown as VerovioClient,
    load,
    renderPage,
  };
}

const LAYOUT: ScoreLayoutSettings = {
  pageFormat: 'a4',
  landscape: false,
  pageMarginMm: 12,
  scalePercent: 100,
  spacingStaff: 8,
  barsPerSystem: 4,
  barsPerPage: 16,
};

function projectDocument(name: string): ProjectDocument {
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Replacement',
        color: '#60a5fa',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        clips: [
          {
            name: 'Replacement clip',
            startPpq: 0,
            lengthPpq: 8,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            kind: 'midi',
            notes: [{ pitch: 67, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
          },
        ],
      },
    ],
    markers: [],
    sections: [],
  };
}

function notationHarness(
  store: ReturnType<typeof useProjectStore>,
  fullScore = false,
  exportClient = vi.fn(() => fakeVerovio().client),
  createClient?: () => VerovioClient,
  getLayoutSettings: () => ScoreLayoutSettings = () => LAYOUT,
) {
  const verovio = fakeVerovio();
  const notation = useScoreNotation({
    store,
    client: shallowRef(verovio.client),
    getDivisionPpq: () => 0.25,
    getTimeSig: () => ({ beats: 4, beatUnit: 4 }),
    getMeasureLenPpq: () => 4,
    getScreenClipLengthPpq: () => Math.max(4, store.clipLengthPpq),
    getTimeSignatures: () => store.timeSignatures,
    getPickupLengthPpq: () => store.pickupLengthPpq,
    getKeyFifths: () => 0,
    getChordsEnabled: () => false,
    getFullScoreEnabled: () => fullScore,
    getLayoutSettings,
    resetPlayheadScan: vi.fn(),
    ...(createClient === undefined ? {} : { createClient }),
    createExportClient: exportClient,
  });
  return { exportClient, notation, verovio };
}

async function settleExports(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('score artifact identity and exports', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    vi.mocked(exportMusicXml).mockClear();
    vi.mocked(confirmLossReport).mockClear();
    await store.init();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
  });

  afterEach(() => {
    store.dispose();
  });

  it('blocks every export immediately after an edit and while re-transcribing', async () => {
    const { exportClient, notation, verovio } = notationHarness(store);
    await notation.transcribe();
    expect(notation.getCurrentXml()).toContain('<score-partwise');

    notation.onExportMusicXml();
    await settleExports();
    expect(exportMusicXml).toHaveBeenCalledTimes(1);
    vi.mocked(exportMusicXml).mockClear();

    addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    expect(notation.getCurrentXml()).toBe('');
    notation.onExportMusicXml();
    notation.onExportPartMusicXml();
    notation.onPrint();
    await settleExports();
    notation.onExportPdf();
    await settleExports();
    expect(exportMusicXml).not.toHaveBeenCalled();
    expect(exportClient).not.toHaveBeenCalled();

    let resolveLoad: ((count: number) => void) | undefined;
    verovio.load.mockImplementationOnce(
      () => new Promise<number>((resolve) => (resolveLoad = resolve)),
    );
    const pending = notation.transcribe();
    expect(notation.loading.value).toBe(true);
    notation.onExportMusicXml();
    notation.onPrint();
    await settleExports();
    expect(exportMusicXml).not.toHaveBeenCalled();
    expect(exportClient).not.toHaveBeenCalled();
    resolveLoad?.(1);
    await pending;
    expect(notation.getCurrentXml()).toContain('<score-partwise');
  });

  it('resolves the current artifact once for repeated readers of an unchanged state', async () => {
    const getLayoutSettings = vi.fn(() => LAYOUT);
    const { notation } = notationHarness(store, false, undefined, undefined, getLayoutSettings);
    await notation.transcribe();
    notation.getCurrentXml();
    getLayoutSettings.mockClear();

    notation.getCurrentXml();
    notation.getCurrentPartName();
    notation.getCurrentXml();
    expect(getLayoutSettings).not.toHaveBeenCalled();
  });

  it('lets a computed reader of the current score follow transcription and edits', async () => {
    const { notation } = notationHarness(store);
    const hasXml = computed(() => notation.getCurrentXml() !== '');
    expect(hasXml.value).toBe(false);

    await notation.transcribe();
    expect(hasXml.value).toBe(true);

    addNote({ pitch: 64, startPpq: 1, durationPpq: 1 });
    expect(hasXml.value).toBe(false);
  });

  it('reports grid-moved notes before either MusicXML export and honours a refusal', async () => {
    addNote({ pitch: 62, startPpq: 2.1, durationPpq: 1 });
    const { notation } = notationHarness(store);
    await notation.transcribe();

    vi.mocked(confirmLossReport).mockResolvedValueOnce(false);
    notation.onExportMusicXml();
    await vi.waitFor(() => expect(confirmLossReport).toHaveBeenCalledTimes(1));
    await settleExports();
    const report = vi.mocked(confirmLossReport).mock.calls[0][0];
    expect(report.entries.length).toBeGreaterThan(0);
    expect(exportMusicXml).not.toHaveBeenCalled();

    notation.onExportPartMusicXml();
    await vi.waitFor(() => expect(confirmLossReport).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(exportMusicXml).toHaveBeenCalledTimes(1));
  });

  it('hides tempo directions from the screen preview while retaining them for artifacts and exports', async () => {
    const document = projectDocument('Tempo Project');
    document.tempoSegments = [
      { startPpq: 0, bpm: 120, endBpm: 90 },
      { startPpq: 4, bpm: 90 },
    ];
    await loadProjectDocument(document);

    const exportClients: FakeVerovioClient[] = [];
    const createExportClient = vi.fn(() => {
      const fake = fakeVerovio();
      exportClients.push(fake);
      return fake.client;
    });
    const { notation, verovio } = notationHarness(store, false, createExportClient);

    await notation.transcribe();
    const previewXml = verovio.load.mock.calls[0]?.[0] as string;
    const artifactXml = notation.getCurrentXml();
    expect(previewXml).not.toContain('<metronome>');
    expect(previewXml).not.toContain('rit.');
    expect(previewXml).not.toContain('a tempo');
    expect(artifactXml).toContain('<metronome>');
    expect(artifactXml).toContain('rit.');
    expect(artifactXml).toContain('tempo="120"');
    expect(artifactXml).toContain('tempo="90"');

    notation.onExportMusicXml();
    await settleExports();
    const [musicXml] = vi.mocked(exportMusicXml).mock.calls[0] as [string, string];
    expect(musicXml).toContain('tempo="120"');
    expect(musicXml).toContain('tempo="90"');

    vi.mocked(exportMusicXml).mockClear();
    notation.onExportPartMusicXml();
    await settleExports();
    const [partXml] = vi.mocked(exportMusicXml).mock.calls[0] as [string, string];
    expect(partXml).toContain('tempo="120"');
    expect(partXml).toContain('tempo="90"');

    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    notation.onPrint();
    await vi.waitFor(() => expect(exportClients).toHaveLength(1));
    expect(exportClients[0]?.load.mock.calls[0]?.[0]).toContain('tempo="120"');
    expect(exportClients[0]?.load.mock.calls[0]?.[0]).toContain('tempo="90"');
    await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('afterprint'));
    print.mockRestore();
    await vi.waitFor(() => expect(notation.exporting.value).toBe(false));

    notation.onExportPdf();
    await vi.waitFor(() => expect(exportClients).toHaveLength(2));
    expect(exportClients[1]?.load.mock.calls[0]?.[0]).toContain('tempo="120"');
    expect(exportClients[1]?.load.mock.calls[0]?.[0]).toContain('tempo="90"');
    await vi.waitFor(() => expect(notation.exporting.value).toBe(false));
  });

  it('invalidates the same numeric clip id across a project switch and clears an empty score', async () => {
    const { notation } = notationHarness(store);
    const firstClipId = store.clipId;
    await notation.transcribe();
    expect(firstClipId).toBe(1);
    expect(notation.getCurrentXml()).not.toBe('');

    await loadProjectDocument(projectDocument('Replacement Project'));
    expect(store.clipId).toBe(firstClipId);
    expect(notation.getCurrentXml()).toBe('');
    notation.onExportMusicXml();
    await settleExports();
    expect(exportMusicXml).not.toHaveBeenCalled();

    notation.bumpGeneration(true);
    await notation.transcribe();
    expect(notation.getCurrentXml()).toContain('Replacement Project');
    expect(notation.pageCount.value).toBe(1);

    deleteClip(store.clipId);
    await notation.transcribe();
    expect(notation.getCurrentXml()).toBe('');
    expect(notation.svg.value).toBe('');
    expect(notation.pageCount.value).toBe(0);
  });

  it('keeps a failed stale transcription unpublished and recovers on retry', async () => {
    const { notation, verovio } = notationHarness(store);
    await notation.transcribe();
    addNote({ pitch: 65, startPpq: 2, durationPpq: 1 });
    verovio.load.mockRejectedValueOnce(new Error('engraver failed'));

    await notation.transcribe();
    expect(notation.error.value).toBe('engraver failed');
    expect(notation.getCurrentXml()).toBe('');
    expect(notation.svg.value).toBe('');

    await notation.transcribe();
    expect(notation.error.value).toBe('');
    expect(notation.getCurrentXml()).toContain('<score-partwise');
  });

  it('replaces a fatally failed display client before the next transcription', async () => {
    const replacement = fakeVerovio();
    const createClient = vi.fn(() => replacement.client);
    const { notation, verovio } = notationHarness(store, false, undefined, createClient);
    (verovio.client as unknown as { failed: boolean }).failed = true;

    await notation.transcribe();

    expect(verovio.client.dispose).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    expect(replacement.load).toHaveBeenCalledOnce();
    expect(replacement.renderPage).toHaveBeenCalledWith(1);
    expect(notation.getCurrentXml()).toContain('<score-partwise');
  });

  it('exports the active non-first full-score part and includes its name in the filename', async () => {
    const firstClipId = store.clipId;
    const leadTrackId = addTrack({ name: 'Lead', kind: 'midi' });
    const leadClipId = addMidiClip({
      trackId: leadTrackId,
      startPpq: 0,
      lengthPpq: 8,
      name: 'Lead clip',
    });
    setActiveClip(leadClipId);
    addNote({ pitch: 72, startPpq: 0, durationPpq: 1 });
    const { notation } = notationHarness(store, true);

    await notation.transcribe();
    expect(notation.getCurrentPartName()).toBe('Lead');
    notation.onExportPartMusicXml();
    await settleExports();

    const [xml, filename] = vi.mocked(exportMusicXml).mock.calls[0] as [string, string];
    expect(xml).toContain('<part-name>Lead</part-name>');
    expect(xml).not.toContain('<part-name>Piano</part-name>');
    expect(filename).toContain('Lead.part.musicxml');

    vi.mocked(exportMusicXml).mockClear();
    setActiveClip(firstClipId);
    expect(notation.getCurrentPartName()).toBe('');
    notation.onExportPartMusicXml();
    await settleExports();
    expect(exportMusicXml).not.toHaveBeenCalled();

    await notation.transcribe();
    expect(notation.getCurrentPartName()).toBe('Piano');
  });

  it('exports both emitted halves when the active full-score track is hybrid', async () => {
    addNote({ pitch: 36, channel: 9, startPpq: 1, durationPpq: 1 });
    store.tracks[0].name = 'Hybrid';
    const { notation } = notationHarness(store, true);

    await notation.transcribe();
    notation.onExportPartMusicXml();
    await settleExports();

    const [xml, filename] = vi.mocked(exportMusicXml).mock.calls[0] as [string, string];
    expect(xml).toContain('<part-name>Hybrid</part-name>');
    expect(xml).toContain('<part-name>Hybrid Percussion</part-name>');
    expect(filename).toContain('Hybrid.part.musicxml');
    expect((xml.match(/<part id=/g) ?? []).length).toBe(2);
  });

  it('stops reporting a stale part name or XML as current after a track rename', async () => {
    store.tracks[0].name = 'Before';
    const { notation } = notationHarness(store, true);
    await notation.transcribe();
    expect(notation.getCurrentPartName()).toBe('Before');

    renameTrack(store.tracks[0].id, 'After');
    expect(notation.getCurrentPartName()).toBe('');
    expect(notation.getCurrentXml()).toBe('');

    await notation.transcribe();
    expect(notation.getCurrentPartName()).toBe('After');
    expect(notation.getCurrentXml()).toContain('<part-name>After</part-name>');
  });

  it('lets an in-flight print export finish when the score is re-transcribed unchanged', async () => {
    const exportVerovio = fakeVerovio();
    let releaseLoad: ((count: number) => void) | undefined;
    exportVerovio.load.mockImplementationOnce(
      () => new Promise<number>((resolve) => (releaseLoad = resolve)),
    );
    const { notation } = notationHarness(
      store,
      false,
      vi.fn(() => exportVerovio.client),
    );
    await notation.transcribe();
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    notation.onPrint();
    await vi.waitFor(() => expect(exportVerovio.load).toHaveBeenCalled());
    await notation.transcribe();
    releaseLoad?.(1);

    await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event('afterprint'));
    print.mockRestore();
    await vi.waitFor(() => expect(notation.exporting.value).toBe(false));
    expect(notation.error.value).toBe('');
  });
});
