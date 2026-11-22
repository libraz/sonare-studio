import { afterEach, describe, expect, it } from 'vitest';
import { addTrack } from '@/project/commands';
import { EXPRESSION_MAP_PRESETS } from '@/project/expression-map';
import { en } from '@/ui/i18n/en';
import {
  type ArrangementViewHarness,
  mountArrangementView,
} from './helpers/arrangement-view-mount';

const header = en.shell.arrangement.trackHeader;

let view: ArrangementViewHarness | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

async function mountWithTrack() {
  let trackId = -1;
  view = await mountArrangementView({
    seed: () => {
      trackId = addTrack({ name: 'Keys' });
    },
  });
  const track = () => view?.store.tracks.find((entry) => entry.id === trackId);
  return { view, trackId, track };
}

describe('track header menu', () => {
  it('offers the expression map off and every preset, and applies the choice', async () => {
    const { view, trackId, track } = await mountWithTrack();
    const [preset] = EXPRESSION_MAP_PRESETS;

    const menu = await view.openTrackHeaderMenu(trackId);
    const labels = new Map(menu.map((entry) => [entry.id, entry.label]));
    expect(labels.get('expression-map-off')).toBe(
      `${header.expressionMap}: ${header.expressionMapOff}`,
    );
    for (const each of EXPRESSION_MAP_PRESETS) {
      expect(labels.get(`expression-map-${each.id}`)).toBe(
        `${header.expressionMap}: ${header.expressionMapPresets[each.id]}`,
      );
    }

    await view.runMenuItem(`expression-map-${preset.id}`);
    expect(track()?.expressionMap).toEqual(preset.map);

    await view.openTrackHeaderMenu(trackId);
    await view.runMenuItem('expression-map-off');
    expect(track()?.expressionMap).toBeUndefined();
  });

  it('offers the three chord follow modes and applies each', async () => {
    const { view, trackId, track } = await mountWithTrack();

    const menu = await view.openTrackHeaderMenu(trackId);
    expect(menu.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['chord-follow-off', 'chord-follow-tones', 'chord-follow-root']),
    );

    await view.runMenuItem('chord-follow-tones');
    expect(track()?.chordFollow).toBe('chordTones');
    await view.openTrackHeaderMenu(trackId);
    await view.runMenuItem('chord-follow-root');
    expect(track()?.chordFollow).toBe('root');
    await view.openTrackHeaderMenu(trackId);
    await view.runMenuItem('chord-follow-off');
    expect(track()?.chordFollow).toBeUndefined();
  });
});
