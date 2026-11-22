import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTracksBatchCommand } from '@/project/command/generate-batch';
import { buildDrumsPlan } from '@/project/command/generate-drums';
import { regenerateDrumsRangeCommand } from '@/project/command/generate-drums-range';
import { clearHistory, redo, undo } from '@/project/command/history';
import { getProject, useProjectStore } from '@/project/store';
import { createTemplate } from '@/project/templates';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  return { ensureWasm: async () => fakeModule };
});

describe('regenerateDrumsRangeCommand', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    store = useProjectStore();
    store.dispose();
    clearHistory();
    await store.init();
  });

  async function makeDrums(bars = 8) {
    const { generateDrumsCommand } = await import('@/project/command/generate-drums');
    generateDrumsCommand({ bars, style: 'standard', seed: 0 });
    const track = store.tracks.find((entry) => entry.generated?.part === 'drums');
    if (!track) throw new Error('missing generated drums track');
    const clip = store.clips.find((entry) => entry.trackId === track.id);
    if (!clip) throw new Error('missing generated drums clip');
    clearHistory();
    return { track, clip };
  }

  it('replaces one source-offset section in place and keeps the rest unchanged', async () => {
    const { track, clip } = await makeDrums();
    const project = getProject();
    // Move the clip while keeping its source notes in source-relative
    // coordinates. The range command must account for sourceOffsetPpq when it
    // removes old onsets and inserts the new section.
    project.trimClip(clip.id, 4, clip.lengthPpq);
    store.refresh();
    clearHistory();
    const before = store.clips.find((entry) => entry.id === clip.id);
    if (!before) throw new Error('missing source-offset clip');
    const beforeJson = project.toJson();
    const originalOutside = before.notes
      .filter((note) => {
        const timelineStart = before.startPpq + note.startPpq - before.sourceOffsetPpq;
        return timelineStart < 8 || timelineStart >= 16;
      })
      .map((note) => ({ ...note }));

    const generated = regenerateDrumsRangeCommand({
      trackId: track.id,
      startPpq: 8,
      endPpq: 16,
      style: 'funk',
      section: 'prechorus',
      seed: 44,
    });

    expect(generated).toBeGreaterThan(0);
    const after = store.clips.find((entry) => entry.id === clip.id);
    expect(after).toBeDefined();
    expect(after?.id).toBe(clip.id);
    expect(after?.trackId).toBe(track.id);
    expect(after?.startPpq).toBe(4);
    expect(after?.sourceOffsetPpq).toBe(4);
    expect(after?.lengthPpq).toBe(before.lengthPpq);
    expect(
      after?.notes.filter((note) => {
        const timelineStart = after.startPpq + note.startPpq - after.sourceOffsetPpq;
        return timelineStart < 8 || timelineStart >= 16;
      }),
    ).toEqual(originalOutside);

    // The one command is one native history entry and one local undo step.
    expect(undo()).toBe(true);
    expect(project.toJson()).toBe(beforeJson);
    expect(store.clips.find((entry) => entry.id === clip.id)?.notes).toEqual(before.notes);
    expect(redo()).toBe(true);
    expect(store.clips.find((entry) => entry.id === clip.id)?.notes).not.toEqual(before.notes);
  });

  it('rejects looped clips without changing native or mirror state', async () => {
    const { track, clip } = await makeDrums();
    const project = getProject();
    project.setClipLoop(clip.id, { loopMode: 'loop', loopLengthPpq: 4 });
    store.refresh();
    clearHistory();
    const beforeJson = project.toJson();
    const beforeMirror = JSON.stringify(store.clips);

    expect(() =>
      regenerateDrumsRangeCommand({ trackId: track.id, startPpq: 8, endPpq: 16, seed: 1 }),
    ).toThrow(/looped/i);
    expect(project.toJson()).toBe(beforeJson);
    expect(JSON.stringify(store.clips)).toBe(beforeMirror);
  });

  it('rejects a range that crosses multiple clips', async () => {
    const { track, clip } = await makeDrums(8);
    const project = getProject();
    project.splitClip(clip.id, 16);
    store.refresh();
    clearHistory();

    expect(() =>
      regenerateDrumsRangeCommand({ trackId: track.id, startPpq: 8, endPpq: 24, seed: 1 }),
    ).toThrow(/one MIDI clip/i);
  });

  it('supports the same one-step range replacement through batch generation', async () => {
    const { track, clip } = await makeDrums();
    const before = store.clips.find((entry) => entry.id === clip.id)?.notes;
    const written = generateTracksBatchCommand([
      {
        part: 'drums',
        params: { style: 'funk', section: 'chorus', seed: 17 },
        target: { kind: 'replaceRange', trackId: track.id, startPpq: 8, endPpq: 16 },
      },
    ]);
    expect(written).toBe(1);
    expect(store.clips.find((entry) => entry.id === clip.id)?.notes).not.toEqual(before);
    expect(undo()).toBe(true);
    expect(store.clips.find((entry) => entry.id === clip.id)?.notes).toEqual(before);
  });

  it('rolls back the range when the native note write fails', async () => {
    const { track } = await makeDrums();
    const project = getProject();
    const beforeJson = project.toJson();
    const beforeMirror = JSON.stringify(store.clips);
    const spy = vi.spyOn(project, 'setMidiEvents').mockImplementationOnce(() => {
      throw new Error('range native write failed');
    });

    expect(() =>
      regenerateDrumsRangeCommand({ trackId: track.id, startPpq: 8, endPpq: 16, seed: 2 }),
    ).toThrow('range native write failed');
    spy.mockRestore();
    expect(project.toJson()).toBe(beforeJson);
    expect(JSON.stringify(store.clips)).toBe(beforeMirror);
  });

  it('rejects melodic tracks before writing', () => {
    const track = store.tracks[0];
    if (!track) throw new Error('missing default track');
    expect(() =>
      regenerateDrumsRangeCommand({ trackId: track.id, startPpq: 0, endPpq: 4, seed: 1 }),
    ).toThrow(/drum track/i);
  });

  it('rejects both start and end positions between bar lines', async () => {
    const { track } = await makeDrums();
    const before = getProject().toJson();
    expect(() =>
      regenerateDrumsRangeCommand({ trackId: track.id, startPpq: 6, endPpq: 16, seed: 1 }),
    ).toThrow(/whole number|boundary/i);
    expect(() =>
      regenerateDrumsRangeCommand({ trackId: track.id, startPpq: 8, endPpq: 18, seed: 1 }),
    ).toThrow(/whole number|boundary/i);
    expect(getProject().toJson()).toBe(before);
  });

  it('checks the meter at the requested generation start', () => {
    store.timeSignatures = [
      { startPpq: 0, numerator: 3, denominator: 4 },
      { startPpq: 8, numerator: 4, denominator: 4 },
    ];
    expect(buildDrumsPlan(store, { bars: 1, seed: 3 }, 8)).not.toBeNull();
    expect(() => buildDrumsPlan(store, { bars: 1, seed: 3 }, 0)).toThrow(/4\/4/);
  });

  it('changes the final two pre-chorus bars when they build into a chorus', () => {
    const common = { bars: 8, style: 'synthpop' as const, section: 'prechorus' as const, seed: 12 };
    const intoChorus = buildDrumsPlan(store, { ...common, nextSection: 'chorus' });
    const intoVerse = buildDrumsPlan(store, { ...common, nextSection: 'verse' });
    expect(intoChorus).not.toBeNull();
    expect(intoVerse).not.toBeNull();
    const onsets = (notes: typeof intoChorus) =>
      notes?.notes
        .filter((note) => note.startPpq >= 24)
        .map((note) => [note.startPpq, note.pitch, note.velocity]);
    expect(onsets(intoChorus)).not.toEqual(onsets(intoVerse));
    expect(intoChorus?.notes.every((note) => note.channel === 9)).toBe(true);
  });

  it('accepts an empty percussion-marked J-pop drum lane for section generation', async () => {
    await store.loadDocument(createTemplate('jpop'));
    const drums = store.tracks.find((track) => track.name === 'Drums');
    const clip =
      drums === undefined ? undefined : store.clips.find((entry) => entry.trackId === drums.id);
    if (drums === undefined || clip === undefined) throw new Error('missing J-pop drum lane');
    clearHistory();

    const generated = regenerateDrumsRangeCommand({
      trackId: drums.id,
      startPpq: 64,
      endPpq: 96,
      style: 'synthpop',
      section: 'prechorus',
      seed: 9,
    });
    expect(generated).toBeGreaterThan(0);
    expect(store.tracks.find((track) => track.id === drums.id)?.percussion).toBe(true);
    const updated = store.clips.find((entry) => entry.id === clip.id);
    expect(updated?.lengthPpq).toBe(384);
    expect(updated?.notes.every((note) => note.channel === 9)).toBe(true);
  });
});
