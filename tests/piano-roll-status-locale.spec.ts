import { describe, expect, it } from 'vitest';
import { readSource, sourceWindow } from './helpers/source-text';

const status = sourceWindow(
  readSource('src/components/piano-roll/PianoRollEditor.vue'),
  'const statusText = computed(',
  '});',
);

describe('piano-roll status line wording', () => {
  it('builds the selection and snap readout from the locale table', () => {
    expect(status).toContain('copy.statusSelected');
    expect(status).toContain('copy.statusSnap');
    expect(status).toContain('copy.statusSnapBar');
    expect(status).toContain('copy.statusSnapOff');
  });

  it('writes no English words of its own', () => {
    expect(status).not.toMatch(/selected|Snap |'Bar'|'off'/);
  });
});
