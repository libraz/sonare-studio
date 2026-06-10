import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('mocks crossOriginIsolated for jsdom', () => {
    expect(globalThis.crossOriginIsolated).toBe(false);
  });
});
