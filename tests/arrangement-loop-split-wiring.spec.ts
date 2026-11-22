import { afterEach, describe, expect, it } from 'vitest';
import { addMidiClip, addTrack, setClipLoop } from '@/project/commands';
import { en } from '@/ui/i18n/en';
import { snapChoices } from '@/ui/shell/app-shell-options';
import {
  type ArrangementViewHarness,
  type ArrangementViewMountOptions,
  mountArrangementView,
} from './helpers/arrangement-view-mount';
import { readOptionLabels, selectOption, selectValueText } from './helpers/select-menu';

const arrangement = en.shell.arrangement;

let view: ArrangementViewHarness | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

async function mountView(options: ArrangementViewMountOptions = {}) {
  view = await mountArrangementView(options);
  return view;
}

/** One looping and one plain clip, each one bar long, on a fresh track. */
async function mountWithLoopingAndPlainClip() {
  const ids = { looping: -1, plain: -1 };
  const mounted = await mountView({
    seed: () => {
      const trackId = addTrack({ name: 'Keys' });
      ids.looping = addMidiClip({ trackId, startPpq: 0, lengthPpq: 4 });
      setClipLoop(ids.looping, true, 2);
      ids.plain = addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 });
    },
  });
  return { view: mounted, ...ids };
}

/** Enough tracks that the lanes overflow the viewport and can scroll. */
async function mountWithManyTracks(count = 8) {
  const trackIds: number[] = [];
  const mounted = await mountView({
    seed: () => {
      for (let index = 0; index < count; index += 1) {
        trackIds.push(addTrack({ name: `Track ${index + 2}` }));
      }
    },
  });
  return { view: mounted, trackIds };
}

describe('arrangement loop split entry points', () => {
  it('reports a split-tool press on a looping clip in the error line and keeps the clip', async () => {
    const { view, looping, plain } = await mountWithLoopingAndPlainClip();
    const clipCount = view.store.clips.length;

    await view.splitWithTool(looping, 2);

    expect(view.errorLine()).toBe(arrangement.loopSplitUnavailable);
    expect(view.store.clips).toHaveLength(clipCount);

    await view.splitWithTool(plain, 10);

    expect(view.store.clips).toHaveLength(clipCount + 1);
  });

  it('disables the context split on a looping clip with the localized reason', async () => {
    const { view, looping, plain } = await mountWithLoopingAndPlainClip();

    const loopingMenu = await view.openClipMenu(looping, 2);
    expect(loopingMenu.find((item) => item.id === 'split')?.disabledReason).toBe(
      arrangement.loopSplitUnavailable,
    );

    const plainMenu = await view.openClipMenu(plain, 10);
    expect(plainMenu.find((item) => item.id === 'split')?.disabledReason).toBeNull();
  });

  it('rejects the playhead split of a looping clip with the same localized reason', async () => {
    let playhead = 2;
    const ids = { looping: -1, plain: -1 };
    const view = await mountView({
      props: { positionPpq: () => playhead },
      seed: () => {
        const trackId = addTrack({ name: 'Keys' });
        ids.looping = addMidiClip({ trackId, startPpq: 0, lengthPpq: 4 });
        setClipLoop(ids.looping, true, 2);
        ids.plain = addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 });
      },
    });
    view.store.clipId = ids.looping;
    const clipCount = view.store.clips.length;

    view.wrapper.vm.cutAtPlayhead();
    await view.wrapper.vm.$nextTick();

    expect(view.errorLine()).toBe(arrangement.loopSplitUnavailable);
    expect(view.store.clips).toHaveLength(clipCount);

    view.store.clipId = ids.plain;
    playhead = 10;
    view.wrapper.vm.cutAtPlayhead();
    await view.wrapper.vm.$nextTick();

    expect(view.errorLine()).toBe('');
    expect(view.store.clips).toHaveLength(clipCount + 1);
  });
});

describe('arrangement viewport wiring', () => {
  it('scrolls the shared vertical viewport from wheel input over the track-header column', async () => {
    const { view } = await mountWithManyTracks();
    expect(view.headerScrollY()).toBe(0);

    await view.wheel('headers', { deltaY: 40 });

    expect(view.headerScrollY()).toBe(40);
    expect(view.canvas().props('scrollY')).toBe(40);
  });

  it('zooms the shared timeline from a pinch over the track-header column', async () => {
    const { view } = await mountWithManyTracks();
    const range = view.canvas().props('range');
    const before = range.pxPerPpq;

    await view.wheel('headers', { deltaY: -100, ctrlKey: true, clientX: 120 });

    expect(range.pxPerPpq).toBeGreaterThan(before);
  });

  it('shares the snap picker choices and writes the picked grid to the arrangement snap', async () => {
    const view = await mountView();
    const expected = snapChoices(en.shell.editor.snapBar);

    expect(await readOptionLabels(view.wrapper, '.arrangement-snap')).toEqual(
      expected.map((choice) => choice.label),
    );

    const grid = expected.find(
      (choice) => choice.value !== 'bar' && choice.value !== view.store.snapDivision,
    );
    if (!grid || grid.value === 'bar') throw new Error('no alternative grid choice');
    await selectOption(view.wrapper, '.arrangement-snap', grid.label);
    expect(view.store.snapBar).toBe(false);
    expect(view.store.snapDivision).toBe(grid.value);

    await selectOption(view.wrapper, '.arrangement-snap', en.shell.editor.snapBar);
    expect(view.store.snapBar).toBe(true);
    expect(selectValueText(view.wrapper, '.arrangement-snap')).toBe(en.shell.editor.snapBar);
  });

  it('applies Alt+wheel vertical zoom to the header rows and the canvas lanes alike', async () => {
    const { view } = await mountWithManyTracks(2);
    const initial = view.canvas().props('laneHeight');
    expect(new Set(view.headerRowHeights())).toEqual(new Set([initial]));

    await view.wheel('canvas', { deltaY: -100, altKey: true });

    const zoomed = view.canvas().props('laneHeight');
    expect(zoomed).toBeGreaterThan(initial);
    expect(new Set(view.headerRowHeights())).toEqual(new Set([zoomed]));

    await view.wrapper.get(`button[aria-label="${arrangement.zoomOutTracks}"]`).trigger('click');

    const zoomedOut = view.canvas().props('laneHeight');
    expect(zoomedOut).toBeLessThan(zoomed);
    expect(new Set(view.headerRowHeights())).toEqual(new Set([zoomedOut]));
  });

  it('reveals a header row through the shared vertical scroll', async () => {
    const { view, trackIds } = await mountWithManyTracks();
    const last = trackIds[trackIds.length - 1];
    const names = view.headers().findAll('.track-name');
    const lastName = names.find((name) => name.text().trim() === `Track ${trackIds.length + 1}`);
    if (!lastName) throw new Error(`no header for track ${last}`);
    expect(view.headerScrollY()).toBe(0);

    await lastName.trigger('dblclick');

    const scrolled = view.headerScrollY();
    expect(scrolled).toBeGreaterThan(0);
    expect(view.canvas().props('scrollY')).toBe(scrolled);
  });
});

describe('arrangement ruler ripple edits', () => {
  /** A clip two bars in, past the ruler point every case edits at. */
  async function mountWithLaterClip() {
    const ids = { later: -1 };
    const mounted = await mountView({
      seed: () => {
        const trackId = addTrack({ name: 'Keys' });
        ids.later = addMidiClip({ trackId, startPpq: 8, lengthPpq: 4 });
      },
    });
    const startOf = () => mounted.store.clips.find((clip) => clip.id === ids.later)?.startPpq;
    return { view: mounted, startOf };
  }

  it('offers ripple insert and delete from the ruler context menu', async () => {
    const { view } = await mountWithLaterClip();

    const menu = await view.openRulerMenu(4);

    expect(menu.map((item) => item.id)).toEqual(
      expect.arrayContaining(['insert-time', 'delete-time']),
    );
    expect(menu.find((item) => item.id === 'insert-time')?.label).toBe(
      arrangement.clipActions.insertTime,
    );
    expect(menu.find((item) => item.id === 'delete-time')?.label).toBe(
      arrangement.clipActions.deleteTime,
    );
  });

  it('inserts the prompted length at the ruler point, defaulting to one bar', async () => {
    const { view, startOf } = await mountWithLaterClip();

    await view.openRulerMenu(4);
    await view.runMenuItem('insert-time');
    const prompt = await view.answerPrompt('6');

    expect(prompt.title).toBe(arrangement.clipActions.insertTimeTitle);
    expect(prompt.defaultValue).toBe('4');
    expect(startOf()).toBe(14);
  });

  it('deletes the prompted length from the ruler point', async () => {
    const { view, startOf } = await mountWithLaterClip();

    await view.openRulerMenu(4);
    await view.runMenuItem('delete-time');
    const prompt = await view.answerPrompt('2');

    expect(prompt.title).toBe(arrangement.clipActions.deleteTimeTitle);
    expect(startOf()).toBe(6);
  });

  it('refuses a non-positive length in the error line and leaves the timeline alone', async () => {
    const { view, startOf } = await mountWithLaterClip();

    await view.openRulerMenu(4);
    await view.runMenuItem('insert-time');
    await view.answerPrompt('0');

    expect(view.errorLine()).toBe(arrangement.clipActions.invalidTimeLength);
    expect(startOf()).toBe(8);
  });
});
