import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceBetween(file: string, start: string, end: string): string {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from + start.length));
}

describe('editor gesture refusals and no-op key edits', () => {
  it('surfaces a refused piano-roll draw in the error line instead of throwing', () => {
    const body = sourceBetween(
      'src/components/piano-roll/PianoRollEditor.vue',
      'function addDrawnNotes',
      '\n}\n',
    );
    expect(body).toMatch(/try \{[\s\S]*addNotesInNewClip[\s\S]*\} catch \(err\) \{/);
    expect(body).toMatch(
      /error\.value = describeError\(err, t\.value\.notices\.errors\);\s+return \[\];/,
    );
  });

  it('moves or trims an arrangement clip from the keyboard only when the value changes', () => {
    const body = sourceBetween(
      'src/components/arrangement/ArrangementView.vue',
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
