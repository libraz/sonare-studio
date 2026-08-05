import { describe, expect, it } from 'vitest';
import { visibleGroupRows } from '@/ui/arrangement/group-rows';

describe('visibleGroupRows', () => {
  it('keeps group rows while hiding only members of collapsed groups', () => {
    const tracks = [{ id: 1 }, { id: 2 }, { id: 3, groupId: 2 }, { id: 4, groupId: 2 }, { id: 5 }];
    expect(visibleGroupRows(tracks, new Set([2])).map((track) => track.id)).toEqual([1, 2, 5]);
    expect(visibleGroupRows(tracks, new Set()).map((track) => track.id)).toEqual([1, 2, 3, 4, 5]);
  });
});
