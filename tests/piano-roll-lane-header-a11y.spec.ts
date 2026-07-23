import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pianoRollEditor = readFileSync(
  resolve(process.cwd(), 'src/components/piano-roll/PianoRollEditor.vue'),
  'utf8',
);

describe('piano roll lane header accessibility', () => {
  it('groups the lane parameter selects instead of claiming an empty tablist', () => {
    // The lane header holds SelectMenu comboboxes, not tabs; a role="tablist"
    // with no role="tab" children is announced as an empty tablist.
    expect(pianoRollEditor).toContain('role="group"');
    expect(pianoRollEditor).not.toContain('role="tablist"');
  });

  it('drops the dead active-tab centering code left over from the old tab strip', () => {
    // The centering helper queried .lane-tab-active, a class the current markup
    // never renders, so it was a no-op kept alive only by its own dead CSS.
    expect(pianoRollEditor).not.toContain('centerActiveLaneTab');
    expect(pianoRollEditor).not.toContain('lane-tab-active');
    expect(pianoRollEditor).not.toContain('.lane-tab ');
  });

  it('does not route form-control keyboard events into note editing shortcuts', () => {
    expect(pianoRollEditor).toContain(
      'input, textarea, select, button, [contenteditable="true"], [contenteditable=""]',
    );
  });
});
