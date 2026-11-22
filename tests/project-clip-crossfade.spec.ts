import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAsset } from '@/persistence/assets';
import {
  crossfadePartner,
  DEFAULT_CLIP_CROSSFADE_PPQ,
  planClipCrossfade,
} from '@/project/clip-crossfade';
import {
  addAudioClip,
  addAudioTrack,
  addMidiClip,
  addTrack,
  clearHistory,
  crossfadeClips,
  moveClip,
  undo,
} from '@/project/commands';
import { getProject, useProjectStore } from '@/project/store';
import type { EditorClip } from '@/project/types';
import { requestAudioAsset } from '@/ui/arrangement/audio-clip-data';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import {
  type ArrangementViewHarness,
  mountArrangementView,
} from './helpers/arrangement-view-mount';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

const wasmModule = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  const fakeModule = createFakeWasmModule();
  wasmModule.current = fakeModule as unknown as Record<string, unknown>;
  return { ensureWasm: async () => wasmModule.current };
});

/** Minimal clip shape for the pure planner tests. */
function clip(fields: Partial<EditorClip> & { id: number }): EditorClip {
  return {
    id: fields.id,
    trackId: fields.trackId ?? 1,
    name: fields.name ?? `clip-${fields.id}`,
    startPpq: fields.startPpq ?? 0,
    lengthPpq: fields.lengthPpq ?? 4,
    sourceOffsetPpq: fields.sourceOffsetPpq ?? 0,
    gain: fields.gain ?? 1,
    loopEnabled: fields.loopEnabled ?? false,
    loopLengthPpq: fields.loopLengthPpq ?? 0,
    notes: [],
    kind: fields.kind ?? 'audio',
    ...(fields.assetId === undefined ? { assetId: 'asset-a' } : { assetId: fields.assetId }),
    ...(fields.fadeInPpq === undefined ? {} : { fadeInPpq: fields.fadeInPpq }),
    ...(fields.fadeOutPpq === undefined ? {} : { fadeOutPpq: fields.fadeOutPpq }),
  } as EditorClip;
}

describe('clip crossfade planning', () => {
  it('turns the overlap of two audio clips into a matching fade pair', () => {
    const left = clip({ id: 1, startPpq: 0, lengthPpq: 4 });
    const right = clip({ id: 2, startPpq: 3, lengthPpq: 4 });

    const plan = planClipCrossfade(right, left);

    expect(plan).toMatchObject({
      leftClipId: 1,
      rightClipId: 2,
      startPpq: 3,
      lengthPpq: 1,
      leftLengthPpq: 4,
    });
  });

  it('shortens the fade so it never collides with the opposite fade', () => {
    const left = clip({ id: 1, startPpq: 0, lengthPpq: 4, fadeInPpq: 3.5 });
    const right = clip({ id: 2, startPpq: 3, lengthPpq: 4 });

    const plan = planClipCrossfade(left, right);

    expect(plan).toMatchObject({ lengthPpq: 0.5 });
  });

  it('extends a touching clip into its remaining source material', () => {
    const left = clip({ id: 1, startPpq: 0, lengthPpq: 4 });
    const right = clip({ id: 2, startPpq: 4, lengthPpq: 4 });

    const plan = planClipCrossfade(left, right, { lengthPpq: 1, leftSourceEndPpq: 6 });

    expect(plan).toMatchObject({ lengthPpq: 1, leftLengthPpq: 5, startPpq: 4 });
  });

  it('refuses pairs that cannot form a fade', () => {
    const left = clip({ id: 1, startPpq: 0, lengthPpq: 4 });
    expect(planClipCrossfade(left, clip({ id: 2, startPpq: 6 }))).toEqual({ reason: 'gap' });
    expect(planClipCrossfade(left, clip({ id: 3, startPpq: 4 }))).toEqual({ reason: 'no-source' });
    expect(planClipCrossfade(left, clip({ id: 4, startPpq: 1, lengthPpq: 1 }))).toEqual({
      reason: 'contained',
    });
    expect(planClipCrossfade(left, clip({ id: 5, startPpq: 3, trackId: 2 }))).toEqual({
      reason: 'different-track',
    });
    expect(planClipCrossfade(left, clip({ id: 6, startPpq: 3, kind: 'midi' }))).toEqual({
      reason: 'not-audio',
    });
    expect(planClipCrossfade(left, clip({ id: 7, startPpq: 3, loopEnabled: true }))).toEqual({
      reason: 'loop',
    });
  });

  it('pairs a clip with its nearest right-hand neighbour only', () => {
    const target = clip({ id: 1, startPpq: 0, lengthPpq: 4 });
    const near = clip({ id: 2, startPpq: 3, lengthPpq: 4 });
    const far = clip({ id: 3, startPpq: 3.5, lengthPpq: 4 });
    const other = clip({ id: 4, startPpq: 3, trackId: 9 });

    expect(crossfadePartner(target, [target, far, near, other])?.id).toBe(2);
    expect(crossfadePartner(clip({ id: 5, startPpq: 20 }), [target, near])).toBeNull();
  });

  it('keeps a sane default length for editors without a grid', () => {
    expect(DEFAULT_CLIP_CROSSFADE_PPQ).toBeGreaterThan(0);
  });
});

describe('crossfadeClips command', () => {
  let store: ReturnType<typeof useProjectStore>;

  beforeEach(async () => {
    installMockOpfs();
    setActivePinia(createPinia());
    store = useProjectStore();
    await store.init();
    clearHistory();
  });

  it('writes both fades in one undoable edit', async () => {
    const trackId = addAudioTrack();
    const left = await addAudioClip({ trackId, assetId: 'a', lengthPpq: 4, startPpq: 0 });
    const right = await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 3 });

    const length = crossfadeClips(right, left);

    expect(length).toBeCloseTo(1);
    expect(store.clips.find((c) => c.id === left)).toMatchObject({ fadeOutPpq: 1 });
    expect(store.clips.find((c) => c.id === right)).toMatchObject({ fadeInPpq: 1 });

    expect(undo()).toBe(true);
    expect(store.clips.find((c) => c.id === left)?.fadeOutPpq).toBeUndefined();
    expect(store.clips.find((c) => c.id === right)?.fadeInPpq).toBeUndefined();
    uninstallMockOpfs();
  });

  it('extends the earlier clip when the pair only touches', async () => {
    const trackId = addAudioTrack();
    const left = await addAudioClip({ trackId, assetId: 'a', lengthPpq: 4, startPpq: 0 });
    const right = await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 4 });

    crossfadeClips(left, right, { lengthPpq: 1, leftSourceEndPpq: 8 });

    expect(getProject().overlapPolicy).toBe('allow');

    expect(store.clips.find((c) => c.id === left)).toMatchObject({
      lengthPpq: 5,
      fadeOutPpq: 1,
    });
    expect(store.clips.find((c) => c.id === right)).toMatchObject({ fadeInPpq: 1 });

    expect(undo()).toBe(true);
    expect(store.clips.find((c) => c.id === left)?.lengthPpq).toBe(4);
    expect(getProject().overlapPolicy).toBe('disallow');
    uninstallMockOpfs();
  });

  it('keeps ordinary moves from creating new overlaps after a crossfade', async () => {
    const trackId = addAudioTrack();
    const left = await addAudioClip({ trackId, assetId: 'a', lengthPpq: 4, startPpq: 0 });
    const right = await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 4 });
    const unrelated = await addAudioClip({ trackId, assetId: 'c', lengthPpq: 2, startPpq: 9 });

    crossfadeClips(left, right, { lengthPpq: 1, leftSourceEndPpq: 8 });

    expect(() => moveClip(unrelated, 1)).toThrow(/overlap/);
    expect(store.clips.find((clip) => clip.id === unrelated)?.startPpq).toBe(9);
    uninstallMockOpfs();
  });

  it('rejects pairs it cannot fade and leaves both clips untouched', async () => {
    const audioTrack = addAudioTrack();
    const left = await addAudioClip({ trackId: audioTrack, assetId: 'a', lengthPpq: 4 });
    const midiTrack = addTrack({ name: 'midi' });
    const midi = addMidiClip({ trackId: midiTrack, lengthPpq: 4, startPpq: 3 });

    expect(() => crossfadeClips(left, midi)).toThrow(/not-audio|different-track/);
    expect(store.clips.find((c) => c.id === left)?.fadeOutPpq).toBeUndefined();
    uninstallMockOpfs();
  });
});

describe('crossfade entry point', () => {
  const actions = en.shell.arrangement.clipActions;
  let view: ArrangementViewHarness | null = null;

  beforeEach(() => {
    installMockOpfs();
  });

  afterEach(() => {
    view?.unmount();
    view = null;
    uninstallMockOpfs();
  });

  /** Stores an 8 s mono asset (16 PPQ at 120 BPM) and loads it into the render cache. */
  async function loadLongAsset(id: string): Promise<void> {
    await saveAsset({ id, name: id, sampleRate: 48000 }, new Float32Array(48000 * 8));
    await new Promise<void>((resolve) => {
      if (requestAudioAsset(id, resolve)) resolve();
    });
  }

  /** Mounts the view over audio clips placed by `place` on one fresh audio track. */
  async function mountAudioClips(
    place: (trackId: number) => Promise<Record<string, number>>,
  ): Promise<{ view: ArrangementViewHarness; ids: Record<string, number> }> {
    let ids: Record<string, number> = {};
    view = await mountArrangementView({
      seed: async () => {
        ids = await place(addAudioTrack());
      },
    });
    return { view, ids };
  }

  const crossfadeReason = async (harness: ArrangementViewHarness, clipId: number) =>
    (await harness.openClipMenu(clipId)).find((item) => item.id === 'crossfade')?.disabledReason;

  it('offers the action from the clip context menu with the blocking reason', async () => {
    const { view, ids } = await mountAudioClips(async (trackId) => ({
      lone: await addAudioClip({ trackId, assetId: 'a', lengthPpq: 4, startPpq: 0 }),
      touching: await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 8 }),
      next: await addAudioClip({ trackId, assetId: 'c', lengthPpq: 4, startPpq: 12 }),
    }));

    expect(await crossfadeReason(view, ids.lone)).toBe(actions.crossfadeNoPartner);
    // Touching clips need source material past the earlier clip's end, unknown here.
    expect(await crossfadeReason(view, ids.touching)).toBe(actions.crossfadeReasons['no-source']);
  });

  it('crossfades an overlapping pair from the clip context menu', async () => {
    const { view, ids } = await mountAudioClips(async (trackId) => ({
      left: await addAudioClip({ trackId, assetId: 'a', lengthPpq: 4, startPpq: 0 }),
      right: await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 3 }),
    }));

    expect(await crossfadeReason(view, ids.left)).toBeNull();
    await view.runMenuItem('crossfade');

    expect(view.errorLine()).toBe('');
    expect(view.store.clips.find((c) => c.id === ids.left)).toMatchObject({ fadeOutPpq: 1 });
    expect(view.store.clips.find((c) => c.id === ids.right)).toMatchObject({ fadeInPpq: 1 });
  });

  it('feeds the source limit of the earlier clip into the plan', async () => {
    const { view, ids } = await mountAudioClips(async (trackId) => {
      await loadLongAsset('long');
      return {
        left: await addAudioClip({ trackId, assetId: 'long', lengthPpq: 4, startPpq: 0 }),
        right: await addAudioClip({ trackId, assetId: 'b', lengthPpq: 4, startPpq: 4 }),
      };
    });
    view.store.snapDivision = 16;

    expect(await crossfadeReason(view, ids.left)).toBeNull();
    await view.runMenuItem('crossfade');

    // One sixteenth-grid step of the earlier clip's remaining source becomes the fade.
    expect(view.store.clips.find((c) => c.id === ids.left)).toMatchObject({
      lengthPpq: 4.25,
      fadeOutPpq: 0.25,
    });
  });

  it('localizes every refusal reason', () => {
    const reasons = [
      'not-audio',
      'different-track',
      'loop',
      'gap',
      'contained',
      'no-source',
    ] as const;
    for (const bundle of [en, ja]) {
      expect(bundle.shell.arrangement.clipActions.crossfade.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(
          bundle.shell.arrangement.clipActions.crossfadeReasons[reason].length,
        ).toBeGreaterThan(0);
      }
    }
  });
});
