import { describe, expect, it } from 'vitest';
import { readSource, sourceWindow } from './helpers/source-text';

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

  it('moves or trims an arrangement clip from the keyboard only when the value changes', () => {
    const body = sourceWindow(
      readSource('src/components/arrangement/ArrangementView.vue'),
      'function onClipKeyboardAction',
      '\n}\n',
    );
    expect(body).toMatch(/if \(startPpq !== clip\.startPpq\) moveClip\(clip\.id, startPpq\);/);
    expect(body).toMatch(
      /if \(lengthPpq !== clip\.lengthPpq\) trimClip\(clip\.id, clip\.startPpq, lengthPpq\);/,
    );
    // The only other move targets a different lane, which is never a no-op.
    expect(body.match(/\bmoveClip\(clip\.id, (?!clip\.startPpq, destination)/g)).toHaveLength(1);
    expect(body.match(/\btrimClip\(/g)).toHaveLength(1);
  });
});
