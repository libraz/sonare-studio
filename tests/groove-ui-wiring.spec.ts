import { afterEach, describe, expect, it } from 'vitest';
import {
  addAudioClip,
  addAudioTrack,
  addMidiClip,
  addNote,
  addTrack,
  setActiveClip,
} from '@/project/commands';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import {
  type ArrangementViewHarness,
  mountArrangementView,
} from './helpers/arrangement-view-mount';
import { readSource } from './helpers/source-text';

const pianoRoll = readSource('src/components/piano-roll/use-piano-roll-note-menu.ts');

describe('groove template entry points', () => {
  it('captures and applies a groove from the piano-roll quantize menu', () => {
    expect(pianoRoll).toContain("id: 'groove-capture'");
    expect(pianoRoll).toContain('store.grooveTemplate = captureGrooveFromSelection();');
    expect(pianoRoll).toContain('applyGrooveToSelection(groove, store.quantizeStrength);');
  });

  it('disables piano-roll apply until a template can move something', () => {
    expect(pianoRoll).toContain('!grooveTemplateIsUsable(store.grooveTemplate),');
    expect(pianoRoll).toContain('t.value.shell.editor.reasons.noGroove,');
  });

  it('labels both entry points in every locale', () => {
    for (const bundle of [en, ja]) {
      expect(bundle.shell.pianoRoll.context.grooveCapture.length).toBeGreaterThan(0);
      expect(bundle.shell.pianoRoll.context.grooveApply.length).toBeGreaterThan(0);
      expect(bundle.shell.pianoRoll.context.grooveClear.length).toBeGreaterThan(0);
      expect(bundle.shell.editor.reasons.noGroove.length).toBeGreaterThan(0);
      expect(bundle.shell.arrangement.clipActions.grooveCapture.length).toBeGreaterThan(0);
      expect(bundle.shell.arrangement.clipActions.grooveApply.length).toBeGreaterThan(0);
    }
  });
});

describe('arrangement clip groove actions', () => {
  let view: ArrangementViewHarness | null = null;

  afterEach(() => {
    view?.unmount();
    view = null;
  });

  /**
   * A swung MIDI clip (every off-sixteenth 0.05 PPQ late), a straight MIDI
   * clip on another track and an audio clip, with a sixteenth grid.
   */
  async function mountGrooveDocument() {
    const ids = { swung: -1, straight: -1, audio: -1, straightNote: -1 };
    view = await mountArrangementView({
      seed: async () => {
        const swungTrack = addTrack({ name: 'Drums' });
        ids.swung = addMidiClip({ trackId: swungTrack, startPpq: 0, lengthPpq: 4 });
        setActiveClip(ids.swung);
        for (const startPpq of [0, 0.3, 0.5, 0.8]) {
          addNote({ pitch: 36, startPpq, durationPpq: 0.2 });
        }
        const straightTrack = addTrack({ name: 'Keys' });
        ids.straight = addMidiClip({ trackId: straightTrack, startPpq: 0, lengthPpq: 4 });
        setActiveClip(ids.straight);
        ids.straightNote = addNote({ pitch: 60, startPpq: 0.25, durationPpq: 0.2 });
        const audioTrack = addAudioTrack();
        ids.audio = await addAudioClip({ trackId: audioTrack, assetId: 'take', lengthPpq: 4 });
      },
    });
    view.store.snapDivision = 16;
    const straightNoteStart = () =>
      view?.store.clips
        .find((clip) => clip.id === ids.straight)
        ?.notes.find((note) => note.id === ids.straightNote)?.startPpq;
    return { view, ids, straightNoteStart };
  }

  it('disables apply until a template can move something', async () => {
    const { view, ids } = await mountGrooveDocument();
    const applyReason = async () =>
      (await view.openClipMenu(ids.straight)).find((item) => item.id === 'groove-apply')
        ?.disabledReason;

    expect(await applyReason()).toBe(en.shell.editor.reasons.noGroove);

    view.store.grooveTemplate = { gridPpq: 0.25, offsetsPpq: [0, 0] };
    expect(await applyReason()).toBe(en.shell.editor.reasons.noGroove);

    view.store.grooveTemplate = { gridPpq: 0.25, offsetsPpq: [0, 0.05] };
    expect(await applyReason()).toBeNull();
  });

  it('offers whole-clip capture and apply on MIDI clips only', async () => {
    const { view, ids } = await mountGrooveDocument();

    const audioMenu = (await view.openClipMenu(ids.audio)).map((item) => item.id);
    expect(audioMenu).not.toContain('groove-capture');
    expect(audioMenu).not.toContain('groove-apply');

    const midiMenu = (await view.openClipMenu(ids.swung)).map((item) => item.id);
    expect(midiMenu).toEqual(expect.arrayContaining(['groove-capture', 'groove-apply']));
  });

  it('captures the clicked clip feel and applies it to another clip at the quantize strength', async () => {
    const { view, ids, straightNoteStart } = await mountGrooveDocument();

    await view.openClipMenu(ids.swung);
    await view.runMenuItem('groove-capture');

    expect(view.store.grooveTemplate?.offsetsPpq.some((offset) => offset > 0.04)).toBe(true);

    view.store.quantizeStrength = 0.5;
    await view.openClipMenu(ids.straight);
    await view.runMenuItem('groove-apply');

    // Half of the captured 0.05 PPQ lateness on the off-sixteenth.
    expect(straightNoteStart()).toBeCloseTo(0.275, 9);
  });
});
