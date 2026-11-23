import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { stemEntryName } from '@/export/options';
import type { VerovioClient } from '@/notation/verovio';
import { addNote, clearHistory } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';
import type { ScoreLayoutSettings } from '@/ui/score/layout';
import { buildFullScore } from '@/ui/score/score-projection';
import { buildProjectScore, characterLabel, useScoreNotation } from '@/ui/score/use-score-notation';

const pdfMetadata = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

vi.mock('@/notation/print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/notation/print')>()),
  downloadBlob: vi.fn(),
  planPdfText: vi.fn(async () => ({ font: null, undrawable: [] })),
  createPdfPageWriter: vi.fn(async (_count: number, _layout: unknown, metadata: object) => {
    pdfMetadata.push({ ...metadata });
    return {
      addPage: vi.fn(async () => undefined),
      close: vi.fn(() => new Blob()),
      undrawable: vi.fn(() => []),
    };
  }),
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

function unnamedTrack(): EditorTrack {
  return {
    id: 1,
    name: '',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
  };
}

function midiClip(): EditorClip & { kind: 'midi' } {
  return {
    id: 1,
    trackId: 1,
    name: 'Clip',
    kind: 'midi',
    startPpq: 0,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [{ id: 1, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 }],
  };
}

describe('score and stem exports in the UI language', () => {
  const settings = useAppSettings();
  const previous = settings.settings.language;

  beforeEach(() => settings.set('language', 'ja'));
  afterEach(() => settings.set('language', previous));

  it('names an unnamed track part in the UI language in the full score', () => {
    const store = { tracks: [unnamedTrack()], clips: [midiClip()], scoreAnnotations: {} };
    const score = buildFullScore(store as never, {
      divisionPpq: 1,
      timeSig: { beats: 4, beatUnit: 4 },
      keyFifths: 0,
      clipStartPpq: 0,
      clipLengthPpq: 4,
    });
    expect(score.parts.map((part) => part.name)).toEqual(['トラック 1']);
  });

  it('names an unnamed active track part in the UI language in the clip score', async () => {
    const active = midiClip();
    const store = {
      tracks: [unnamedTrack()],
      clips: [active],
      activeClip: active,
      scoreAnnotations: {},
      displayTransposeSemitones: 0,
      clipStartPpq: 0,
      projectName: '',
      sections: [],
      markers: [],
      tempoSegments: [],
      tempoBpm: 120,
    };
    const score = await buildProjectScore(store as never, {
      divisionPpq: 1,
      timeSig: { beats: 4, beatUnit: 4 },
      measureLenPpq: 4,
      clipLengthPpq: 4,
      keyFifths: 0,
      chordsEnabled: false,
      fullScoreEnabled: false,
      layoutSettings: { barsPerSystem: 0, barsPerPage: 0 },
    });
    expect(score.parts.map((part) => part.name)).toEqual(['トラック 1']);
  });

  it('names a stem whose track name leaves nothing in the UI language', () => {
    expect(stemEntryName('', 1, 2, '.wav', 'トラック 2')).toBe('02 トラック 2.wav');
    expect(stemEntryName('Bass', 0, 2, '.wav', 'トラック 1')).toBe('01 Bass.wav');
  });

  it('writes the PDF subject, and the title of an unnamed project, in the UI language', async () => {
    setActivePinia(createPinia());
    const store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.projectName = '';
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });
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
    pdfMetadata.length = 0;
    notation.onExportPdf();
    await vi.waitFor(() => expect(notation.exporting.value).toBe(false));
    expect(pdfMetadata.map((metadata) => metadata.subject)).toEqual(['譜面']);
    expect(pdfMetadata.map((metadata) => metadata.title)).toEqual(['譜面']);
    store.dispose();
  });
});

describe('PDF loss notice character labels', () => {
  it('names a private-use glyph by its code point and any other character as itself', () => {
    expect(['\uECA5', '한', 'é'].map(characterLabel)).toEqual(['U+ECA5', '한', 'é']);
  });
});
