import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMidiClipSchedules } from '@/engine/midi-sync';
import { clipArticulations } from '@/project/annotations';
import {
  addMidiClip,
  addNote,
  addTrack,
  clearHistory,
  setTrackExpressionMap,
  undo,
} from '@/project/commands';
import {
  EXPRESSION_MAP_PRESETS,
  expressionMapEntryFor,
  isExpressionMapEmpty,
  matchingExpressionMapPreset,
  sanitizeExpressionMap,
} from '@/project/expression-map';
import { useProjectStore } from '@/project/store';
import type { EditorClip, EditorTrack } from '@/project/types';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

const STATUS_NOTE_ON = 0x90;
const STATUS_CONTROL_CHANGE = 0xb0;

/** Decodes an engine event word into its status/data bytes. */
function decode(word: number): { status: number; data0: number; data1: number } {
  return {
    status: (word >>> 16) & 0xf0,
    data0: (word >>> 8) & 0x7f,
    data1: word & 0x7f,
  };
}

describe('expression map model', () => {
  it('drops entries that could not send anything', () => {
    expect(
      sanitizeExpressionMap({
        entries: [
          { articulation: 'staccato', keySwitch: 24 },
          { articulation: 'staccato', keySwitch: 30 },
          { articulation: 'nonsense', keySwitch: 24 },
          { articulation: 'accent' },
          { articulation: 'tenuto', keySwitch: 900 },
          { articulation: 'marcato', controller: 32 },
        ],
      }),
    ).toEqual({
      entries: [
        { articulation: 'staccato', keySwitch: 24 },
        { articulation: 'marcato', controller: 32, value: 127 },
      ],
    });
    expect(sanitizeExpressionMap({ entries: [] })).toBeUndefined();
    expect(sanitizeExpressionMap(null)).toBeUndefined();
  });

  it('recognizes its own presets and reports empty maps', () => {
    const preset = EXPRESSION_MAP_PRESETS[0];
    expect(matchingExpressionMapPreset(preset.map)?.id).toBe(preset.id);
    expect(matchingExpressionMapPreset(undefined)).toBeUndefined();
    expect(isExpressionMapEmpty(undefined)).toBe(true);
    expect(isExpressionMapEmpty({ entries: [{ articulation: 'accent' }] })).toBe(true);
    expect(expressionMapEntryFor(preset.map, 'accent')?.keySwitch).toBe(25);
    expect(expressionMapEntryFor(preset.map, undefined)).toBeUndefined();
  });
});

describe('expression map scheduling', () => {
  const track: EditorTrack = {
    id: 1,
    name: 'Strings',
    color: '#fff',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 0,
    expressionMap: {
      entries: [
        { articulation: 'staccato', keySwitch: 24 },
        { articulation: 'marcato', controller: 32, value: 4 },
      ],
    },
  };
  const clip: EditorClip = {
    id: 7,
    trackId: 1,
    name: 'Phrase',
    startPpq: 1,
    lengthPpq: 4,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [
      { id: 11, pitch: 60, velocity: 96, startPpq: 0, durationPpq: 1, channel: 0 },
      { id: 12, pitch: 62, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
      { id: 13, pitch: 64, velocity: 96, startPpq: 2, durationPpq: 1, channel: 0 },
    ],
  };

  function schedule(articulations?: Map<number, Map<number, 'staccato' | 'marcato'>>) {
    return buildMidiClipSchedules(
      [track],
      [clip],
      [{ startPpq: 0, bpm: 120 }],
      48000,
      undefined,
      undefined,
      articulations,
    );
  }

  it('places a key switch strictly before the note it marks', () => {
    const [entry] = schedule(new Map([[7, new Map([[11, 'staccato' as const]])]]));
    const noteOn = entry.events.find(
      (event) => decode(event.word0).status === STATUS_NOTE_ON && decode(event.word0).data0 === 60,
    );
    const keySwitch = entry.events.find(
      (event) => decode(event.word0).status === STATUS_NOTE_ON && decode(event.word0).data0 === 24,
    );

    expect(keySwitch).toBeDefined();
    expect(keySwitch?.renderFrame).toBeLessThan(noteOn?.renderFrame ?? 0);
    expect(decode(keySwitch?.word0 ?? 0).data1).toBe(1);
  });

  it('sends the mapped controller before the note it marks', () => {
    const [entry] = schedule(new Map([[7, new Map([[13, 'marcato' as const]])]]));
    const cc = entry.events.find((event) => decode(event.word0).status === STATUS_CONTROL_CHANGE);
    const noteOn = entry.events.find(
      (event) => decode(event.word0).status === STATUS_NOTE_ON && decode(event.word0).data0 === 64,
    );

    expect(decode(cc?.word0 ?? 0).data0).toBe(32);
    expect(decode(cc?.word0 ?? 0).data1).toBe(4);
    expect(cc?.renderFrame).toBeLessThan(noteOn?.renderFrame ?? 0);
  });

  it('injects nothing for a track without a map', () => {
    const mapped = schedule(new Map([[7, new Map([[12, 'staccato' as const]])]]));
    const withoutMap = buildMidiClipSchedules(
      [{ ...track, expressionMap: undefined }],
      [clip],
      [{ startPpq: 0, bpm: 120 }],
      48000,
      undefined,
      undefined,
      new Map([[7, new Map([[11, 'staccato' as const]])]]),
    );

    // The same articulations reach both calls; only the mapped track reacts.
    expect(mapped[0].events.some((event) => decode(event.word0).data0 === 24)).toBe(true);
    expect(withoutMap[0].events.some((event) => decode(event.word0).data0 === 24)).toBe(false);
  });

  it('leaves the stored notes untouched', () => {
    schedule(new Map([[7, new Map([[11, 'staccato' as const]])]]));
    expect(clip.notes.map((note) => note.pitch)).toEqual([60, 62, 64]);
  });
});

describe('articulation lookup', () => {
  it('keeps only notes that carry an articulation', () => {
    const lookup = clipArticulations({
      3: { 1: { articulation: 'accent' }, 2: { dynamics: 'ff' } },
      4: { 5: { dynamics: 'p' } },
    });

    expect(lookup.get(3)?.get(1)).toBe('accent');
    expect(lookup.get(3)?.has(2)).toBe(false);
    expect(lookup.has(4)).toBe(false);
  });
});

describe('expression map command and entry point', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  it('stores a sanitized map on the track, undoably', () => {
    const trackId = addTrack({ name: 'Strings' });
    const clipId = addMidiClip({ trackId, lengthPpq: 4 });
    store.clipId = clipId;
    store.refresh();
    addNote({ pitch: 60, startPpq: 0, durationPpq: 1 });

    setTrackExpressionMap(trackId, {
      entries: [
        { articulation: 'accent', keySwitch: 25 },
        { articulation: 'accent', keySwitch: 99 },
      ],
    });

    expect(store.tracks.find((track) => track.id === trackId)?.expressionMap).toEqual({
      entries: [{ articulation: 'accent', keySwitch: 25 }],
    });

    expect(undo()).toBe(true);
    expect(store.tracks.find((track) => track.id === trackId)?.expressionMap).toBeUndefined();
  });

  it('offers off and both presets from the track header menu', () => {
    const headers = readFileSync(
      resolve(process.cwd(), 'src/components/arrangement/TrackHeaderList.vue'),
      'utf8',
    );

    expect(headers).toContain("id: 'expression-map-off'");
    expect(headers).toContain('setTrackExpressionMap(track.id, null)');
    expect(headers).toContain('setTrackExpressionMap(track.id, preset.map)');

    for (const bundle of [en, ja]) {
      const header = bundle.shell.arrangement.trackHeader;
      expect(header.expressionMap.length).toBeGreaterThan(0);
      expect(header.expressionMapOff.length).toBeGreaterThan(0);
      for (const preset of EXPRESSION_MAP_PRESETS) {
        expect(header.expressionMapPresets[preset.id].length).toBeGreaterThan(0);
      }
    }
  });
});
