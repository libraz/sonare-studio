import { describe, expect, it } from 'vitest';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';
import { readSource, sourceWindow } from './helpers/source-text';

const pianoRoll = readSource('src/components/piano-roll/use-piano-roll-note-menu.ts');
const arrangementView = readSource('src/components/arrangement/ArrangementView.vue');

describe('groove template entry points', () => {
  it('captures and applies a groove from the piano-roll quantize menu', () => {
    expect(pianoRoll).toContain("id: 'groove-capture'");
    expect(pianoRoll).toContain('store.grooveTemplate = captureGrooveFromSelection();');
    expect(pianoRoll).toContain('applyGrooveToSelection(groove, store.quantizeStrength);');
  });

  it('disables apply until a template can move something', () => {
    for (const source of [pianoRoll, arrangementView]) {
      expect(source).toContain('!grooveTemplateIsUsable(store.grooveTemplate),');
      expect(source).toContain('t.value.shell.editor.reasons.noGroove,');
    }
  });

  it('offers whole-clip capture and apply on MIDI clips only', () => {
    const midiOnlyBlock = sourceWindow(
      arrangementView,
      'if (!isAudioClip(clip))',
      "{ id: 'sep-1', separator: true },",
    );
    expect(midiOnlyBlock).toContain('store.grooveTemplate = captureGrooveFromActiveClip();');
    expect(midiOnlyBlock).toContain('applyGrooveToActiveClip(groove, store.quantizeStrength);');
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
