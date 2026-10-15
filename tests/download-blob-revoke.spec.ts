import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from '@/lib/download';

describe('downloadBlob', () => {
  const revokeObjectURL = vi.fn();
  let order: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    order = [];
    revokeObjectURL.mockReset().mockImplementation(() => order.push('revoke'));
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      order.push('click');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('revokes the object URL after the click, not synchronously', () => {
    downloadBlob(new Blob(['x']), 'file.bin');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    expect(order).toEqual(['click', 'revoke']);
  });
});
