import { afterEach, describe, expect, it } from 'vitest';
import { addMidiClip, addTrack, canUndo } from '@/project/commands';
import {
  type ArrangementViewHarness,
  mountArrangementView,
} from './helpers/arrangement-view-mount';
import { readSource, sourceWindow } from './helpers/source-text';

let view: ArrangementViewHarness | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

describe('editor gesture refusals and no-op key edits', () => {
  it('surfaces a refused piano-roll draw in the error line instead of throwing', () => {
    const body = sourceWindow(
      readSource('src/components/piano-roll/PianoRollEditor.vue'),
      'function addDrawnNotes',
      '\n}\n',
    );
    expect(body).toMatch(/try \{[\s\S]*addNotesInNewClip[\s\S]*\} catch \(err\) \{/);
    expect(body).toMatch(
      /error\.value = describeError\(err, t\.value\.notices\.errors\);\s+return \[\];/,
    );
  });

  it('moves or trims an arrangement clip from the keyboard only when the value changes', async () => {
    const ids = { clip: -1 };
    view = await mountArrangementView({
      seed: () => {
        const trackId = addTrack({ name: 'Keys' });
        // Already at the timeline start and at the minimum keyboard length.
        ids.clip = addMidiClip({ trackId, startPpq: 0, lengthPpq: 0.25 });
      },
    });
    const clip = () => view?.store.clips.find((entry) => entry.id === ids.clip);

    await view.pressClipKey(ids.clip, 'ArrowLeft', { ctrlKey: true });
    await view.pressClipKey(ids.clip, 'ArrowLeft', { shiftKey: true });
    await view.setClipControl(ids.clip, 'start', 0);
    await view.setClipControl(ids.clip, 'length', 0.25);

    expect(clip()).toMatchObject({ startPpq: 0, lengthPpq: 0.25 });
    expect(canUndo()).toBe(false);

    await view.pressClipKey(ids.clip, 'ArrowRight', { ctrlKey: true });

    expect(clip()?.startPpq).toBeGreaterThan(0);
    expect(canUndo()).toBe(true);
  });

  it('trims an arrangement clip from the keyboard when the length changes', async () => {
    const ids = { clip: -1 };
    view = await mountArrangementView({
      seed: () => {
        const trackId = addTrack({ name: 'Keys' });
        ids.clip = addMidiClip({ trackId, startPpq: 0, lengthPpq: 0.25 });
      },
    });

    await view.pressClipKey(ids.clip, 'ArrowRight', { shiftKey: true });

    expect(view.store.clips.find((entry) => entry.id === ids.clip)?.lengthPpq).toBeGreaterThan(
      0.25,
    );
    expect(canUndo()).toBe(true);
  });
});
