import { describe, expect, it } from 'vitest';
import { createAssetReferenceGuard } from '@/project/asset-references';

describe('createAssetReferenceGuard', () => {
  it('reports clip, take and frozen-track references', () => {
    const guard = createAssetReferenceGuard({
      clips: [{ assetId: 'a', takes: [{ assetId: 'b' }] }],
      tracks: [{ frozen: { assetId: 'c' } }],
    });

    expect(['a', 'b', 'c', 'd'].map(guard)).toEqual([true, true, true, false]);
  });

  it('walks the project once however many assets are checked', () => {
    let clipReads = 0;
    const guard = createAssetReferenceGuard({
      get clips() {
        clipReads++;
        return [{ assetId: 'a' }];
      },
      tracks: [],
    });

    guard('a');
    guard('b');
    guard('c');

    expect(clipReads).toBe(1);
  });

  it('defers the walk until the first check', () => {
    let clipReads = 0;
    createAssetReferenceGuard({
      get clips() {
        clipReads++;
        return [];
      },
      tracks: [],
    });

    expect(clipReads).toBe(0);
  });
});
