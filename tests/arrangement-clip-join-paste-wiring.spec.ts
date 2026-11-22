import { afterEach, describe, expect, it } from 'vitest';
import { addMidiClip, addTrack } from '@/project/commands';
import { en } from '@/ui/i18n/en';
import {
  type ArrangementViewHarness,
  mountArrangementView,
} from './helpers/arrangement-view-mount';

const why = en.shell.arrangement.reasons;

let view: ArrangementViewHarness | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

/** Two touching clips, then one after a gap, on one track; a second, empty track. */
async function mountWithRun() {
  const ids = { keys: -1, empty: -1, first: -1, second: -1, apart: -1 };
  view = await mountArrangementView({
    seed: () => {
      ids.keys = addTrack({ name: 'Keys' });
      ids.empty = addTrack({ name: 'Empty' });
      ids.first = addMidiClip({ trackId: ids.keys, startPpq: 0, lengthPpq: 960 });
      ids.second = addMidiClip({ trackId: ids.keys, startPpq: 960, lengthPpq: 960 });
      ids.apart = addMidiClip({ trackId: ids.keys, startPpq: 3840, lengthPpq: 960 });
    },
  });
  return { view, ...ids };
}

describe('arrangement clip join and lane paste', () => {
  it('glues the run of touching clips and leaves the clip after the gap', async () => {
    const { view, keys, first, second, apart } = await mountWithRun();

    const menu = await view.openClipMenu(first);
    expect(menu.find((entry) => entry.id === 'glue')?.disabledReason).toBeNull();
    await view.runMenuItem('glue');

    const onKeys = view.store.clips.filter((clip) => clip.trackId === keys);
    expect(onKeys.map((clip) => clip.id)).not.toContain(first);
    expect(onKeys.map((clip) => clip.id)).not.toContain(second);
    expect(onKeys.map((clip) => clip.id)).toContain(apart);
    expect(onKeys.find((clip) => clip.id !== apart)).toMatchObject({
      startPpq: 0,
      lengthPpq: 1920,
    });
  });

  it('says there is nothing to join on a clip with no touching neighbour', async () => {
    const { view, apart } = await mountWithRun();

    const menu = await view.openClipMenu(apart);

    expect(menu.find((entry) => entry.id === 'glue')?.disabledReason).toBe(why.nothingToJoin);
  });

  it('pastes a copied clip onto the empty lane under the pointer', async () => {
    const { view, empty, first } = await mountWithRun();
    await view.openClipMenu(first);
    await view.runMenuItem('copy');

    const menu = await view.openLaneMenu(empty, 1920);
    expect(menu.map((entry) => entry.id)).toEqual(['paste']);
    await view.runMenuItem('paste');

    expect(view.store.clips.filter((clip) => clip.trackId === empty)).toEqual([
      expect.objectContaining({ startPpq: 1920, lengthPpq: 960 }),
    ]);
  });
});
