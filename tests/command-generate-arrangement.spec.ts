import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectChords } from '@/project/command/chords';
import { generateArrangementCommand } from '@/project/command/generate-arrangement';
import { buildBackingPlan, generateBackingCommand } from '@/project/command/generate-backing';
import { clearHistory, redo, undo } from '@/project/command/history';
import { useProjectStore } from '@/project/store';
import { MAJOR_MODE_MASK } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

const TWO_CHORDS = [
  { startPpq: 0, endPpq: 4, rootPc: 0, quality: 0 },
  { startPpq: 4, endPpq: 8, rootPc: 7, quality: 0 },
];

describe('generateBackingCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('voices the chord track onto a new backing track and reverts on undo', () => {
    setProjectChords(TWO_CHORDS);
    const trackCount = store.tracks.length;
    const count = generateBackingCommand({ style: 'smooth' });
    expect(count).toBeGreaterThan(0);
    expect(store.tracks.length).toBe(trackCount + 1);
    expect(store.tracks.some((t) => t.name === 'Backing')).toBe(true);
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
  });

  it('supports a fixed tertian style', () => {
    setProjectChords(TWO_CHORDS);
    const count = generateBackingCommand({ style: 'shell' });
    expect(count).toBeGreaterThan(0);
  });

  it('voices m(add9), min9, 7b9, and 13 extension tones', () => {
    setProjectChords([
      { startPpq: 0, endPpq: 4, rootPc: 0, quality: 11 },
      { startPpq: 4, endPpq: 8, rootPc: 0, quality: 6, extensions: [2] },
      { startPpq: 8, endPpq: 12, rootPc: 0, quality: 4, extensions: [1] },
      { startPpq: 12, endPpq: 16, rootPc: 0, quality: 4, extensions: [9] },
    ]);

    const plan = buildBackingPlan(store, { style: 'close', octave: 4 });
    expect(plan).not.toBeNull();
    for (const [startPpq, extensionPc] of [
      [0, 2],
      [4, 2],
      [8, 1],
      [12, 9],
    ]) {
      const pitchClasses = new Set(
        plan?.notes
          .filter((note) => note.startPpq === startPpq)
          .map((note) => ((note.pitch % 12) + 12) % 12),
      );
      expect(pitchClasses.has(extensionPc)).toBe(true);
    }
  });

  it('is a no-op without a chord track', () => {
    const trackCount = store.tracks.length;
    expect(generateBackingCommand()).toBe(0);
    expect(store.tracks.length).toBe(trackCount);
  });

  it('voices the smooth mode against the project key', () => {
    // I-vi-ii-V-I: told the key, the voicer resolves the final chord instead of
    // leaving the leading tone to jump, which changes the last voicing.
    const progression = [0, 9, 2, 7, 0].map((rootPc, index) => ({
      startPpq: index * 4,
      endPpq: index * 4 + 4,
      rootPc,
      quality: rootPc === 9 || rootPc === 2 ? 1 : 0,
    }));
    setProjectChords(progression);

    const inKey = buildBackingPlan(store, { style: 'smooth' });
    store.scaleHighlight = { enabled: false, rootPc: 0, modeMask: MAJOR_MODE_MASK };
    // Highlighting off means no key context, and the C-major fallback its
    // resolver returns is the same key here, so the two must still agree.
    const disabled = buildBackingPlan(store, { style: 'smooth' });
    expect(disabled?.notes).toEqual(inKey?.notes);

    const lastStart = progression[progression.length - 1].startPpq;
    const finalChord = (plan: typeof inKey) =>
      (plan?.notes ?? [])
        .filter((note) => note.startPpq === lastStart)
        .map((note) => note.pitch)
        .sort((a, b) => a - b);
    // Told the key, the voicer closes on the tonic in the top voice; without it
    // the same progression ends on the fifth.
    const top = finalChord(inKey).at(-1) ?? Number.NaN;
    expect(((top % 12) + 12) % 12).toBe(0);

    // A key the music does not bear out is not a hazard: its rules only fire on
    // its own leading tone, so the voicing falls back to the keyless one.
    store.scaleHighlight = { enabled: true, rootPc: 6, modeMask: MAJOR_MODE_MASK };
    const wrongKey = buildBackingPlan(store, { style: 'smooth' });
    expect(wrongKey?.notes.length).toBe(inKey?.notes.length);
  });

  it('leaves a styled voicing untouched by the key, being a per-chord stack', () => {
    setProjectChords(TWO_CHORDS);
    const inC = buildBackingPlan(store, { style: 'drop2' });
    store.scaleHighlight = { enabled: true, rootPc: 6, modeMask: MAJOR_MODE_MASK };
    expect(buildBackingPlan(store, { style: 'drop2' })?.notes).toEqual(inC?.notes);
  });
});

describe('generateArrangementCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
    store.scaleHighlight = { enabled: true, rootPc: 0, modeMask: MAJOR_MODE_MASK };
  });

  it('lays down chords, drums, bass, and backing in a single undoable edit', () => {
    const trackCount = store.tracks.length;
    const parts = generateArrangementCommand({ bars: 4, seed: 0 });
    // Progression + three new tracks (drums, bass, backing).
    expect(parts).toBe(3);
    expect(store.tracks.length).toBe(trackCount + 3);
    expect(store.chords.length).toBeGreaterThan(0);
    for (const name of ['Drums', 'Bass', 'Backing']) {
      expect(store.tracks.some((t) => t.name === name)).toBe(true);
    }
    // One undo reverts the whole arrangement — tracks and chords together.
    expect(undo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount);
    expect(store.chords).toEqual([]);
    expect(redo()).toBe(true);
    expect(store.tracks.length).toBe(trackCount + 3);
    expect(store.chords.length).toBeGreaterThan(0);
  });

  it('honors part selection', () => {
    const trackCount = store.tracks.length;
    const parts = generateArrangementCommand({ bars: 2, drums: true, bass: false, backing: false });
    expect(parts).toBe(1);
    expect(store.tracks.length).toBe(trackCount + 1);
    expect(store.tracks.some((t) => t.name === 'Drums')).toBe(true);
    expect(store.tracks.some((t) => t.name === 'Bass')).toBe(false);
  });

  it('clips existing chords and generated parts to the requested bars', () => {
    setProjectChords([...TWO_CHORDS, { startPpq: 8, endPpq: 16, rootPc: 5, quality: 0 }]);

    const parts = generateArrangementCommand({
      bars: 2,
      progression: false,
      drums: false,
      bass: false,
      backing: true,
    });

    expect(parts).toBe(1);
    const track = store.tracks.find((candidate) => candidate.name === 'Backing');
    const clip = store.clips.find((candidate) => candidate.trackId === track?.id);
    expect(clip?.lengthPpq).toBe(8);
    expect(clip?.notes.every((note) => note.startPpq + note.durationPpq <= 8)).toBe(true);
    // Existing project harmony is a source, not an output of this command.
    expect(store.chords.at(-1)?.endPpq).toBe(16);
  });

  it('is deterministic in its seed', () => {
    generateArrangementCommand({ bars: 4, seed: 9 });
    const first = JSON.stringify(store.chords);
    undo();
    generateArrangementCommand({ bars: 4, seed: 9 });
    expect(JSON.stringify(store.chords)).toBe(first);
  });

  it('rejects a non-positive bar count', () => {
    expect(() => generateArrangementCommand({ bars: 0 })).toThrow(RangeError);
  });

  it('blocks fixed-grid arrangement generation outside 4/4', () => {
    store.timeSignatures = [{ startPpq: 0, numerator: 5, denominator: 8 }];
    expect(() => generateArrangementCommand({ bars: 1 })).toThrow(/supports 4\/4 bars only/);
  });
});
