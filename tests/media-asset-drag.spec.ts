import { describe, expect, it } from 'vitest';
import {
  ASSET_DRAG_MIME,
  hasAssetDrag,
  readAssetDragId,
  setAssetDragData,
} from '@/ui/media/asset-drag';

/** Minimal DataTransfer stub (jsdom has no constructible DataTransfer). */
function stubDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  const stub = {
    effectAllowed: 'none',
    get types() {
      return [...data.keys()];
    },
    setData(type: string, value: string) {
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? '';
    },
  };
  return stub as unknown as DataTransfer;
}

describe('asset drag payload', () => {
  it('writes the asset id under the custom MIME and text/plain', () => {
    const dt = stubDataTransfer();
    setAssetDragData(dt, 'abc123');
    expect(dt.getData(ASSET_DRAG_MIME)).toBe('abc123');
    expect(dt.getData('text/plain')).toBe('abc123');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('round-trips through hasAssetDrag and readAssetDragId', () => {
    const dt = stubDataTransfer();
    setAssetDragData(dt, 'abc123');
    expect(hasAssetDrag(dt)).toBe(true);
    expect(readAssetDragId(dt)).toBe('abc123');
  });

  it('rejects transfers without the asset MIME', () => {
    const dt = stubDataTransfer();
    dt.setData('text/plain', 'not-an-asset');
    expect(hasAssetDrag(dt)).toBe(false);
    expect(readAssetDragId(dt)).toBeNull();
  });

  it('handles a null DataTransfer', () => {
    expect(hasAssetDrag(null)).toBe(false);
    expect(readAssetDragId(null)).toBeNull();
  });

  it('treats an empty stored id as no payload', () => {
    const dt = stubDataTransfer();
    dt.setData(ASSET_DRAG_MIME, '');
    expect(readAssetDragId(dt)).toBeNull();
  });
});
