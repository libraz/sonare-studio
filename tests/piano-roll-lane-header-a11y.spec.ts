import { describe, expect, it } from 'vitest';
import { readSource } from './helpers/source-text';

const pianoRollEditor = readSource('src/components/piano-roll/PianoRollEditor.vue');

const laneHeader = readSource('src/components/piano-roll/PianoRollLaneHeader.vue');

const noteKeyboardEdits = readSource('src/ui/piano-roll/use-note-keyboard-edits.ts');

const pianoRollEditorStyles = readSource('src/components/piano-roll/piano-roll-editor.css');

describe('piano roll lane header accessibility', () => {
  it('groups the lane parameter selects instead of claiming an empty tablist', () => {
    // The lane header holds SelectMenu comboboxes, not tabs; a role="tablist"
    // with no role="tab" children is announced as an empty tablist.
    expect(laneHeader).toContain('role="group"');
    expect(laneHeader).not.toContain('role="tablist"');
    expect(pianoRollEditor).not.toContain('role="tablist"');
  });

  it('drops the dead active-tab centering code left over from the old tab strip', () => {
    // The centering helper queried .lane-tab-active, a class the current markup
    // never renders, so it was a no-op kept alive only by its own dead CSS.
    for (const source of [pianoRollEditor, laneHeader]) {
      expect(source).not.toContain('centerActiveLaneTab');
      expect(source).not.toContain('lane-tab-active');
      expect(source).not.toContain('.lane-tab ');
    }
    expect(pianoRollEditorStyles).not.toContain('.lane-tab ');
  });

  it('does not route form-control keyboard events into note editing shortcuts', () => {
    expect(noteKeyboardEdits).toContain(
      'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]',
    );
  });

  it('makes the MIDI 1.0 expression limitation explicit beside expression controls', () => {
    expect(laneHeader).toContain('t.shell.pianoRoll.mpeUnsupported');
    expect(laneHeader).toContain('class="mpe-unsupported-note"');
  });
});
