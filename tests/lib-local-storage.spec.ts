import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLocalStorage, writeLocalStorage } from '@/lib/local-storage';

const KEY = 'sonare-studio.test.local-storage';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(KEY);
});

describe('local storage helpers', () => {
  it('round-trips a value and reads a missing key as null', () => {
    expect(readLocalStorage(KEY)).toBeNull();
    writeLocalStorage(KEY, '{"a":1}');
    expect(readLocalStorage(KEY)).toBe('{"a":1}');
  });

  it('returns stored text verbatim, leaving corrupt JSON to the caller', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(readLocalStorage(KEY)).toBe('{not json');
  });

  it('reads as null when storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readLocalStorage(KEY)).toBeNull();
  });

  it('ignores a refused write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => writeLocalStorage(KEY, 'x')).not.toThrow();
    vi.restoreAllMocks();
    expect(readLocalStorage(KEY)).toBeNull();
  });
});
