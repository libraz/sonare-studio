import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import { sectionIdFromName } from '@/compose/section-shaping';
import type { MixdownReport, MixdownResult } from '@/export/mixdown';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { analyzeAudioClipSections } from '@/project/audio-sections';
import { setProjectChords } from '@/project/command/chords';
import { generateBassLineCommand } from '@/project/command/generate-bass';
import { generateDrumsCommand } from '@/project/command/generate-drums';
import { createLeadMelodyCommand } from '@/project/command/generate-lead';
import { addAudioClip, addAudioTrack, clearHistory, setClipCompSegments } from '@/project/commands';
import { flattenClipComp } from '@/project/comp-flatten';
import { EXTERNAL_STEM_ROLES, externalStemTrackName } from '@/project/external-stems';
import { bounceTrackRange, freezeTrack } from '@/project/freeze';
import { useProjectStore } from '@/project/store';
import { createTemplate, TEMPLATE_NAMES } from '@/project/templates';
import { MESSAGES } from '@/ui/i18n/messages';
import { editedAssetName } from '@/ui/sample-editor/history';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const settings = useAppSettings();
const previousLanguage = settings.settings.language;

function renderResult(): MixdownResult {
  return {
    channels: [new Float32Array(8).fill(0.5), new Float32Array(8).fill(0.5)],
    sampleRate: 48000,
    totalFrames: 8,
    report: { peakDb: -6 } as MixdownReport,
  };
}

describe('derived names in the UI language', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    settings.set('language', 'ja');
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });
  afterEach(() => settings.set('language', previousLanguage));

  it('names external stem tracks in Japanese', () => {
    expect(EXTERNAL_STEM_ROLES.map(externalStemTrackName)).toEqual([
      'ボーカル',
      'ドラム',
      'ベース',
      'その他',
    ]);
  });

  it('names template documents, tracks and sections in Japanese', () => {
    const jpop = createTemplate('jpop');
    expect(jpop.name).toBe('J-POP ソング');
    expect(jpop.tracks.map((track) => track.name)).toEqual([
      'ドラム',
      'ベース',
      'バッキング',
      '主旋律',
    ]);
    expect(jpop.sections.map((section) => section.name)).toEqual([
      'イントロ',
      'Aメロ',
      'Bメロ',
      'サビ',
      'Aメロ',
      'Bメロ',
      'ラストサビ',
      'アウトロ',
    ]);
    expect(createTemplate('baroque-organ').tracks.map((track) => track.name)).toEqual([
      '第 1 手鍵盤 ソプラノ',
      '第 1 手鍵盤 アルト',
      '第 2 手鍵盤 テノール',
      '足鍵盤 バス',
    ]);
    expect(createTemplate('transcription').tracks[0].name).toBe('ピアノ');
    expect(createTemplate('empty').name).toBe('空のプロジェクト');
    expect(createTemplate('gm-orchestra').tracks.map((track) => track.name)).toContain(
      'ヴァイオリン I',
    );
  });

  it('names generated parts in Japanese', async () => {
    setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
    generateBassLineCommand();
    generateDrumsCommand({ bars: 1 });
    const names = store.tracks.map((track) => track.name);
    expect(names).toContain('ベース');
    expect(names).toContain('ドラム');
  });

  it('names frozen and bounced renders in Japanese', async () => {
    const voxId = addAudioTrack({ name: 'Vox' });
    const ingest = vi.fn(async () => ({ id: 'baked-1' }));
    const render = vi.fn(async () => renderResult());
    await freezeTrack(voxId, { render, ingest });
    expect(ingest.mock.calls[0]).toEqual([expect.anything(), 48000, 'Vox（フリーズ）']);

    const guitarId = addAudioTrack({ name: 'Gtr' });
    const clipId = await bounceTrackRange(guitarId, 4, 12, { render, ingest });
    expect(store.clips.find((clip) => clip.id === clipId)?.name).toBe('Gtr（バウンス）');
  });

  it('names a flattened comp in Japanese', async () => {
    const trackId = addAudioTrack({ name: 'Vox' });
    const clipId = await addAudioClip({
      trackId,
      assetId: 'take-b',
      lengthPpq: 4,
      name: 'Lead',
      takes: [
        { assetId: 'take-a', name: 'Take 1' },
        { assetId: 'take-b', name: 'Take 2' },
      ],
    });
    setClipCompSegments(clipId, [
      { startPpq: 0, takeIndex: 0 },
      { startPpq: 2, takeIndex: 1 },
    ]);
    const asset = (id: string): LoadedAudioAsset => ({
      meta: { id, name: id, sampleRate: 4, numChannels: 1, numFrames: 8 },
      channels: [new Float32Array(8).fill(0.5)],
    });
    const ingest = vi.fn(async (_channels: Float32Array[], _sampleRate: number, _name: string) => ({
      id: 'baked',
    }));
    await flattenClipComp(clipId, {
      tempoBpm: 120,
      loadAudioAsset: async (id) => asset(id),
      ingest,
    });
    expect(ingest.mock.calls[0][2]).toBe('Lead（コンプ）');
  });

  it('names detected audio sections in Japanese', async () => {
    const sections = await analyzeAudioClipSections(
      { assetId: 'a', startPpq: 0, lengthPpq: 16, sourceOffsetPpq: 0 },
      120,
      {
        loadAudioAsset: async () =>
          ({
            meta: { id: 'a', name: 'a', sampleRate: 48000, numChannels: 1, numFrames: 48000 },
            channels: [new Float32Array(48000).fill(0.5)],
          }) as LoadedAudioAsset,
        analyzeSections: () => ({
          form: '',
          sections: (['intro', 'preChorus', 'instrumental'] as const).map((type, index) => ({
            type,
            startSec: index,
            endSec: index + 1,
            energyLevel: 0,
            confidence: 1,
            group: index,
            name: type,
          })),
        }),
      },
    );
    expect(sections.map((section) => section.name)).toEqual(['イントロ', 'Bメロ', '間奏']);
  });

  it('suffixes edited assets in Japanese and keeps the suffix once in any language', () => {
    expect(editedAssetName('キック')).toBe('キック（編集済み）');
    expect(editedAssetName('キック（編集済み）')).toBe('キック（編集済み）');
    settings.set('language', 'en');
    expect(editedAssetName('キック（編集済み）')).toBe('キック（編集済み）');
    expect(editedAssetName('Kick')).toBe('Kick (edited)');
    settings.set('language', 'ja');
    expect(editedAssetName('Kick (edited)')).toBe('Kick (edited)');
  });

  it('reuses a lead track created in Japanese after switching to English', async () => {
    setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
    const before = store.tracks.length;
    const first = createLeadMelodyCommand();
    expect(store.tracks.at(-1)?.name).toBe('主旋律');
    settings.set('language', 'en');
    const second = createLeadMelodyCommand();
    expect(second).toBe(first);
    expect(store.tracks).toHaveLength(before + 1);
  });
});

describe('section names match across languages', () => {
  const languages = Object.keys(MESSAGES) as Array<keyof typeof MESSAGES>;
  const expected = {
    sectionIntro: 'intro',
    sectionVerse: 'verse',
    sectionPreChorus: 'prechorus',
    sectionChorus: 'chorus',
    sectionFinalChorus: 'chorus',
    sectionBridge: 'bridge',
    sectionInstrumental: 'bridge',
    sectionOutro: 'outro',
    sectionSection: null,
    sectionPrelude: null,
    sectionExposition: null,
    sectionEpisode: null,
    sectionMiddleEntry: null,
    sectionFinalEntry: null,
    sectionCoda: null,
  } as const;

  it.each(languages)('maps every %s default section name to its kind', (language) => {
    const names = MESSAGES[language].common.defaultNames;
    for (const [key, id] of Object.entries(expected)) {
      expect(sectionIdFromName(names[key as keyof typeof expected]), `${language} ${key}`).toBe(id);
    }
  });

  it('maps the aliases users type by hand', () => {
    expect(sectionIdFromName('Pre_Chorus')).toBe('prechorus');
    expect(sectionIdFromName(' HOOK ')).toBe('chorus');
    expect(sectionIdFromName('サビ前')).toBe('prechorus');
    expect(sectionIdFromName('エンディング')).toBe('outro');
    expect(sectionIdFromName('Instrumental')).toBe('bridge');
    expect(sectionIdFromName('Coda')).toBeNull();
  });

  it.each(languages)('maps every section of the %s templates', (language) => {
    settings.set('language', language);
    try {
      const ids = TEMPLATE_NAMES.flatMap((name) =>
        createTemplate(name).sections.map((section) => sectionIdFromName(section.name)),
      );
      expect(ids).toEqual([
        'intro',
        'verse',
        'prechorus',
        'chorus',
        'verse',
        'prechorus',
        'chorus',
        'outro',
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
    } finally {
      settings.set('language', previousLanguage);
    }
  });
});
