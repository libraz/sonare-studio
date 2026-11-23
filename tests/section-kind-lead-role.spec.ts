import type { Section } from '@libraz/libsonare';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import {
  isSectionId,
  SECTION_IDS,
  type SectionId,
  sectionIdFromName,
  sectionKind,
} from '@/compose/section-shaping';
import { exportDawproject, importDawproject } from '@/export/dawproject';
import {
  createSonareDawprojectMetadata,
  parseSonareDawprojectMetadata,
} from '@/export/dawproject/sonare-metadata';
import { inspectMusicXmlExportLoss } from '@/notation/musicxml-export-loss';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { analyzeAudioClipSections } from '@/project/audio-sections';
import { setProjectChords } from '@/project/command/chords';
import { createLeadMelodyCommand } from '@/project/command/generate-lead';
import { clearHistory, redo, undo } from '@/project/command/history';
import {
  deleteTime,
  duplicateTime,
  insertTime,
  type SectionInput,
  setSections,
} from '@/project/command/timeline';
import { renameTrack } from '@/project/command/tracks';
import { setWasmModule } from '@/project/runtime';
import {
  type DocumentSection,
  type DocumentTrack,
  loadProjectDocument,
  type ProjectDocument,
  serializeProject,
} from '@/project/serialization';
import { SMF_TRACK_FIELDS } from '@/project/smf-export-loss';
import { useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';
import { createFakeWasmModule } from './fake-wasm';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule: create } = await import('./fake-wasm');
  const fakeModule = create();
  return { ensureWasm: async () => fakeModule };
});

const settings = useAppSettings();
const previousLanguage = settings.settings.language;

const JPOP_KINDS: SectionId[] = [
  'intro',
  'verse',
  'prechorus',
  'chorus',
  'verse',
  'prechorus',
  'chorus',
  'outro',
];

function midiTrack(overrides: Partial<DocumentTrack> = {}): DocumentTrack {
  return {
    name: 'Keys',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    clips: [],
    ...overrides,
  };
}

function baseDoc(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    ...createTemplate('empty'),
    tracks: [midiTrack()],
    markers: [],
    sections: [],
    ...overrides,
  };
}

/** A document whose section and track carry fields of arbitrary type, as a file could. */
function untrustedDoc(section: Record<string, unknown>, track: Record<string, unknown>) {
  return baseDoc({
    tracks: [midiTrack(track as Partial<DocumentTrack>)],
    sections: [
      { name: 'Part', color: '#123456', startPpq: 0, endPpq: 8, ...section } as DocumentSection,
    ],
  });
}

describe('section kind and lead role', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeAll(() => {
    setWasmModule(createFakeWasmModule());
  });

  beforeEach(async () => {
    settings.set('language', 'ja');
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });
  afterEach(() => settings.set('language', previousLanguage));

  describe('vocabulary', () => {
    it('accepts only members of the closed list', () => {
      for (const id of SECTION_IDS) expect(isSectionId(id)).toBe(true);
      for (const bad of [null, undefined, 3, 'Chorus', 'constructor', '__proto__', 'drop', '']) {
        expect(isSectionId(bad)).toBe(false);
      }
    });

    it('prefers the recorded kind over the name', () => {
      expect(sectionKind({ name: 'A', kind: 'chorus' })).toBe('chorus');
      expect(sectionKind({ name: 'A' })).toBeNull();
      expect(sectionKind({ name: 'Chorus 2' })).toBe('chorus');
    });
  });

  describe('section kind', () => {
    it('writes kinds from the J-pop template and keeps them through a rename', async () => {
      const doc = createTemplate('jpop');
      expect(doc.sections.map((section) => section.kind)).toEqual(JPOP_KINDS);
      await store.loadDocument(doc);

      const target = store.sections[3];
      setSections(store.sections.map((section) => ({ ...section })));
      setSections(
        store.sections.map((section) =>
          section.id === target.id ? { ...section, name: 'A' } : { ...section },
        ),
      );
      const renamed = store.sections.find((section) => section.id === target.id);
      expect(renamed?.name).toBe('A');
      expect(sectionIdFromName('A')).toBeNull();
      expect(renamed && sectionKind(renamed)).toBe('chorus');
    });

    it('keeps the stored kind when a field-by-field entry omits it', async () => {
      await store.loadDocument(createTemplate('jpop'));
      const first = store.sections[0];
      const entries: SectionInput[] = store.sections.map((section) => ({
        id: section.id,
        name: section.id === first.id ? 'Part 1' : section.name,
        startPpq: section.startPpq,
        endPpq: section.endPpq,
      }));
      setSections(entries);
      expect(store.sections.find((section) => section.id === first.id)?.kind).toBe('intro');
      setSections([{ name: 'Fresh', startPpq: 0, endPpq: 4 }]);
      expect(store.sections[0].kind).toBeUndefined();
      expect('kind' in store.sections[0]).toBe(false);
    });

    it('survives serialize and load, writing no kind key when absent', async () => {
      await store.loadDocument(createTemplate('jpop'));
      setSections([
        ...store.sections.map((section) => ({ ...section })),
        { name: 'Mine', startPpq: 400, endPpq: 408 },
      ]);
      const doc = serializeProject();
      expect(doc.sections.slice(0, 8).map((section) => section.kind)).toEqual(JPOP_KINDS);
      expect('kind' in doc.sections[8]).toBe(false);

      await loadProjectDocument(JSON.parse(JSON.stringify(doc)));
      expect(store.sections.slice(0, 8).map((section) => section.kind)).toEqual(JPOP_KINDS);
      expect(store.sections[8].kind).toBeUndefined();
    });

    it('survives undo, redo, insertTime, deleteTime and duplicateTime', async () => {
      await store.loadDocument(createTemplate('jpop'));
      const kinds = () => store.sections.map((section) => section.kind);

      setSections([{ id: store.sections[0].id, name: 'X', startPpq: 0, endPpq: 32 }]);
      expect(kinds()).toEqual(['intro']);
      expect(undo()).toBe(true);
      expect(kinds()).toEqual(JPOP_KINDS);
      expect(redo()).toBe(true);
      expect(kinds()).toEqual(['intro']);
      expect(undo()).toBe(true);

      insertTime(0, 16);
      expect(kinds()).toEqual(JPOP_KINDS);
      expect(undo()).toBe(true);
      deleteTime(0, 8);
      expect(kinds().slice(0, 3)).toEqual(['intro', 'verse', 'prechorus']);
      expect(undo()).toBe(true);
      duplicateTime(0, 32);
      expect(store.sections.length).toBeGreaterThan(8);
      expect(kinds().slice(0, 2)).toEqual(['intro', 'intro']);
      for (const section of store.sections) expect(section.kind).toBeDefined();
    });

    it('writes kinds for detected sections and none for the unknown type', async () => {
      const analyze = (samples: Float32Array, sampleRate: number) => {
        void samples;
        void sampleRate;
        const types = ['intro', 'preChorus', 'instrumental', 'unknown'] as const;
        return {
          sections: types.map((type, index) => ({
            type,
            startSec: index,
            endSec: index + 1,
            energyLevel: 0,
            confidence: 1,
            group: index,
            name: type,
          })) as Section[],
          form: '',
        };
      };
      const sections = await analyzeAudioClipSections(
        { assetId: 'a', startPpq: 0, lengthPpq: 64, sourceOffsetPpq: 0 },
        120,
        {
          loadAudioAsset: async () =>
            ({
              meta: { id: 'a', name: 'a', sampleRate: 48000, numChannels: 1, numFrames: 48000 * 4 },
              channels: [new Float32Array(48000 * 4).fill(0.5)],
            }) as LoadedAudioAsset,
          analyzeSections: analyze,
        },
      );
      expect(sections.map((section) => section.kind)).toEqual([
        'intro',
        'prechorus',
        'bridge',
        undefined,
      ]);
      expect('kind' in sections[3]).toBe(false);
    });

    it.each([null, 3, 'Chorus', 'constructor', '__proto__', 'drop'])(
      'drops the malformed kind %j on load and keeps the entry',
      async (kind) => {
        await loadProjectDocument(untrustedDoc({ kind }, {}));
        expect(store.sections).toHaveLength(1);
        expect(store.sections[0].name).toBe('Part');
        expect('kind' in store.sections[0]).toBe(false);
      },
    );

    it('classifies an old unkinded section by name', () => {
      expect(sectionKind({ name: 'Chorus 2' })).toBe('chorus');
    });
  });

  describe('lead role', () => {
    beforeEach(async () => {
      await store.loadDocument(createTemplate('empty'));
      setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
    });

    it('reuses a renamed lead track', () => {
      const first = createLeadMelodyCommand();
      expect(store.tracks[0].role).toBe('lead');
      renameTrack(store.tracks[0].id, 'Melody');
      const second = createLeadMelodyCommand();
      expect(second).toBe(first);
      expect(store.tracks).toHaveLength(1);
      expect(store.activeClip?.id).toBe(first);
    });

    it('prefers the role track over a name-matched track with a spanning clip', async () => {
      const spanning = (name: string): DocumentTrack['clips'][number] => ({
        name,
        startPpq: 0,
        lengthPpq: 16,
        sourceOffsetPpq: 0,
        gain: 1,
        loopEnabled: false,
        loopLengthPpq: 0,
        kind: 'midi',
        notes: [],
      });
      await store.loadDocument(
        baseDoc({
          tracks: [
            midiTrack({ name: 'Lead', clips: [spanning('Lead')] }),
            midiTrack({ name: 'Melody', role: 'lead', clips: [spanning('Melody')] }),
          ],
        }),
      );
      setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
      createLeadMelodyCommand();
      expect(store.tracks).toHaveLength(2);
      expect(store.activeTrack?.name).toBe('Melody');
    });

    it('prefers the role track even when only the name-matched track has a spanning clip', async () => {
      await store.loadDocument(
        baseDoc({
          tracks: [
            midiTrack({
              name: 'Lead',
              clips: [
                {
                  name: 'Lead',
                  startPpq: 0,
                  lengthPpq: 16,
                  sourceOffsetPpq: 0,
                  gain: 1,
                  loopEnabled: false,
                  loopLengthPpq: 0,
                  kind: 'midi',
                  notes: [],
                },
              ],
            }),
            midiTrack({ name: 'Melody', role: 'lead' }),
          ],
        }),
      );
      setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
      createLeadMelodyCommand();
      expect(store.tracks).toHaveLength(2);
      expect(store.activeTrack?.name).toBe('Melody');
    });

    it('still reuses a name-matched track that has no role', async () => {
      await store.loadDocument(baseDoc({ tracks: [midiTrack({ name: '主旋律' })] }));
      setProjectChords([{ startPpq: 0, endPpq: 16, rootPc: 0, quality: 0 }]);
      createLeadMelodyCommand();
      expect(store.tracks).toHaveLength(1);
      expect(store.activeTrack?.name).toBe('主旋律');
    });

    it('writes the role from the J-pop template and keeps it through save and load', async () => {
      const doc = createTemplate('jpop');
      expect(doc.tracks.map((track) => track.role)).toEqual([
        undefined,
        undefined,
        undefined,
        'lead',
      ]);
      await store.loadDocument(doc);
      renameTrack(store.tracks[3].id, 'Hook');
      const saved = serializeProject();
      expect(saved.tracks[3].role).toBe('lead');
      expect('role' in saved.tracks[0]).toBe(false);
      await loadProjectDocument(JSON.parse(JSON.stringify(saved)));
      expect(store.tracks[3].role).toBe('lead');
      expect('role' in store.tracks[0]).toBe(false);
    });

    it.each([null, 'Lead', 'solo'])('drops the malformed role %j on load', async (role) => {
      await loadProjectDocument(untrustedDoc({}, { role }));
      expect(store.tracks).toHaveLength(1);
      expect('role' in store.tracks[0]).toBe(false);
    });
  });

  describe('DAWproject sidecar', () => {
    it('round-trips kind and role', async () => {
      const doc = baseDoc({
        tracks: [midiTrack({ role: 'lead' }), midiTrack({ name: 'Other' })],
        sections: [
          { name: 'A', kind: 'chorus', color: '#123456', startPpq: 0, endPpq: 8 },
          { name: 'B', color: '#123456', startPpq: 8, endPpq: 16 },
        ],
      });
      const imported = importDawproject(await exportDawproject(doc, { includeAudio: false }));
      expect(imported.tracks.map((track) => track.role)).toEqual(['lead', undefined]);
      expect(imported.sections.map((section) => section.kind)).toEqual(['chorus', undefined]);
      expect('role' in imported.tracks[1]).toBe(false);
    });

    it('drops a malformed sidecar kind or role and keeps the entry', () => {
      const metadata = parseSonareDawprojectMetadata(
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            tracks: { 'track-0': { role: 'Lead', vcaId: 'v' }, 'track-1': { role: 'lead' } },
            sections: [
              { name: 'A', kind: '__proto__', color: '#111', startPpq: 0, endPpq: 4 },
              { name: 'B', kind: 'verse', color: '#111', startPpq: 4, endPpq: 8 },
            ],
          }),
        ),
      );
      expect(metadata.tracks?.['track-0']).toEqual({ vcaId: 'v' });
      expect(metadata.tracks?.['track-1']?.role).toBe('lead');
      expect(metadata.sections?.map((section) => section.kind)).toEqual([undefined, 'verse']);
      expect('kind' in (metadata.sections?.[0] ?? {})).toBe(false);
    });

    it('writes role per track into the sidecar', () => {
      const metadata = createSonareDawprojectMetadata(
        baseDoc({ tracks: [midiTrack({ role: 'lead' }), midiTrack()] }),
      );
      expect(metadata.tracks?.['track-0']?.role).toBe('lead');
      expect(metadata.tracks?.['track-1']).not.toHaveProperty('role');
    });
  });

  describe('export loss tables', () => {
    it('does not report role in MusicXML or SMF', () => {
      const withRole = baseDoc({ tracks: [midiTrack({ role: 'lead' })] });
      const without = baseDoc({ tracks: [midiTrack()] });
      expect(inspectMusicXmlExportLoss(withRole, 1)).toEqual(inspectMusicXmlExportLoss(without, 1));
      expect(SMF_TRACK_FIELDS.role).toBe('not-content');
    });
  });
});
