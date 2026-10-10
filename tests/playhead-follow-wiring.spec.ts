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

const playheadFollow = readFileSync(
  resolve(process.cwd(), 'src/ui/arrangement/use-playhead-follow.ts'),
  'utf8',
);

describe('playhead follow preference wiring', () => {
  it('keeps the follow loop in the shared composable', () => {
    expect(playheadFollow).toContain('function tick');
    expect(playheadFollow).toContain('anchoredPlayheadFollowStart(range, ppq, anchorLocalX)');
    expect(playheadFollow).toContain('() => [options.isPlaying(), options.followEnabled()]');
  });

  it('wires the arrangement view to the scroll-follow setting', () => {
    expect(arrangementView).toContain('usePlayheadFollow({');
    expect(arrangementView).toContain(
      'followEnabled: () => appSettings.settings.scrollFollowPlayhead',
    );
    expect(arrangementView).not.toContain('function followPlayheadTick');
  });

  it('wires the piano roll to the scroll-follow setting', () => {
    expect(pianoRollEditor).toContain('usePlayheadFollow({');
    expect(pianoRollEditor).toContain(
      'followEnabled: () => appSettings.settings.scrollFollowPlayhead',
    );
    expect(pianoRollEditor).toContain('playheadFollow.restart()');
    expect(pianoRollEditor).not.toContain('function followPlayheadTick');
  });

  it('wires the score panel to the scroll-follow setting independently from highlighting', () => {
    expect(scorePanel).toContain('usePlayheadSync({');
    expect(scorePanel).toContain(
      'getFollowEnabled: () => appSettings.settings.scrollFollowPlayhead',
    );
    expect(scorePanel).toContain('getIsPlaying: () => props.isPlaying === true');
  });
});
