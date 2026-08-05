import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/ui/i18n/en';
import { ja } from '@/ui/i18n/ja';

const pianoRoll = readFileSync(
  resolve(process.cwd(), 'src/components/piano-roll/PianoRollEditor.vue'),
  'utf8',
);
const arrangementView = readFileSync(
  resolve(process.cwd(), 'src/components/arrangement/ArrangementView.vue'),
  'utf8',
);

describe('groove template entry points', () => {
  it('captures and applies a groove from the piano-roll quantize menu', () => {
    expect(pianoRoll).toContain("id: 'groove-capture'");
    expect(pianoRoll).toContain('store.grooveTemplate = captureGrooveFromSelection();');
    expect(pianoRoll).toContain('applyGrooveToSelection(groove, store.quantizeStrength);');
  });

  it('disables apply until a template can move something', () => {
    expect(pianoRoll).toContain('disabled: !grooveTemplateIsUsable(store.grooveTemplate)');
    expect(arrangementView).toContain(
      'disabled: frozen || !grooveTemplateIsUsable(store.grooveTemplate)',
    );
  });

  it('offers whole-clip capture and apply on MIDI clips only', () => {
    const midiOnlyBlock = arrangementView.slice(arrangementView.indexOf('if (!isAudioClip(clip))'));
    expect(midiOnlyBlock).toContain('store.grooveTemplate = captureGrooveFromActiveClip();');
    expect(midiOnlyBlock).toContain('applyGrooveToActiveClip(groove, store.quantizeStrength);');
  });

  it('labels both entry points in every locale', () => {
    for (const bundle of [en, ja]) {
      expect(bundle.shell.pianoRoll.context.grooveCapture.length).toBeGreaterThan(0);
      expect(bundle.shell.pianoRoll.context.grooveApply.length).toBeGreaterThan(0);
      expect(bundle.shell.pianoRoll.context.grooveClear.length).toBeGreaterThan(0);
      expect(bundle.shell.pianoRoll.context.grooveEmpty.length).toBeGreaterThan(0);
      expect(bundle.shell.arrangement.clipActions.grooveCapture.length).toBeGreaterThan(0);
      expect(bundle.shell.arrangement.clipActions.grooveApply.length).toBeGreaterThan(0);
    }
  });
});
