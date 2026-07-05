import { describe, expect, it } from 'vitest';
import { collectReferencedAudioAssetIds } from '@/project/asset-references';

describe('collectReferencedAudioAssetIds', () => {
  it('collects active clip, inactive take and frozen-track assets', () => {
    const ids = collectReferencedAudioAssetIds(
      [{ assetId: 'clip-a' }, { takes: [{ assetId: 'take-a' }, { assetId: 'take-b' }] }, {}],
      [{ frozen: { assetId: 'frozen-a' } }, {}],
    );

    expect([...ids].sort()).toEqual(['clip-a', 'frozen-a', 'take-a', 'take-b']);
  });

  it('ignores missing and duplicate ids', () => {
    const ids = collectReferencedAudioAssetIds(
      [{ assetId: 'asset-a', takes: [{ assetId: 'asset-a' }, {}] }],
      [{ frozen: {} }],
    );

    expect([...ids]).toEqual(['asset-a']);
  });
});
