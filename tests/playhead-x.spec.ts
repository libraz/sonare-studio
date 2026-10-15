import { describe, expect, it } from 'vitest';
import { playheadX } from '@/ui/canvas/playhead-x';

const view = { ppqToX: (ppq: number) => ppq * 10 };

describe('playheadX', () => {
  it('tracks the live column when not following', () => {
    expect(playheadX(view, 12, null)).toBe(120);
  });

  it('moves normally until it reaches the follow anchor, then pins there', () => {
    expect(playheadX(view, 5, 80)).toBe(50);
    expect(playheadX(view, 20, 80)).toBe(80);
  });
});
