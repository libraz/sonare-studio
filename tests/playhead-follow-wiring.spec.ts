import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const arrangementView = readFileSync(
  resolve(process.cwd(), 'src/components/arrangement/ArrangementView.vue'),
  'utf8',
);
const pianoRollEditor = readFileSync(
  resolve(process.cwd(), 'src/components/piano-roll/PianoRollEditor.vue'),
  'utf8',
);
const scorePanel = readFileSync(
  resolve(process.cwd(), 'src/components/score/ScorePanel.vue'),
  'utf8',
);

describe('playhead follow preference wiring', () => {
  it('wires the arrangement view to the scroll-follow setting', () => {
    expect(arrangementView).toContain('appSettings.settings.scrollFollowPlayhead');
    expect(arrangementView).toContain('function followPlayheadTick');
    expect(arrangementView).toContain('nextPlayheadFollowStart(range, ppq)');
    expect(arrangementView).toContain(
      '() => [props.isPlaying, appSettings.settings.scrollFollowPlayhead]',
    );
  });

  it('wires the piano roll to the scroll-follow setting', () => {
    expect(pianoRollEditor).toContain('appSettings.settings.scrollFollowPlayhead');
    expect(pianoRollEditor).toContain('function followPlayheadTick');
    expect(pianoRollEditor).toContain('nextPlayheadFollowStart(range, ppq)');
    expect(pianoRollEditor).toContain(
      '() => [props.isPlaying, appSettings.settings.scrollFollowPlayhead]',
    );
  });

  it('wires the score panel to the scroll-follow setting independently from highlighting', () => {
    expect(scorePanel).toContain('usePlayheadSync({');
    expect(scorePanel).toContain(
      'getFollowEnabled: () => appSettings.settings.scrollFollowPlayhead',
    );
    expect(scorePanel).toContain('getIsPlaying: () => props.isPlaying === true');
  });
});
