import { describe, expect, it } from 'vitest';
import { isImeComposing } from '@/ui/keyboard/ime';

describe('isImeComposing', () => {
  it('is true for isComposing and for the legacy keyCode 229', () => {
    expect(isImeComposing(new KeyboardEvent('keydown', { isComposing: true }))).toBe(true);
    expect(isImeComposing(new KeyboardEvent('keydown', { keyCode: 229 }))).toBe(true);
  });

  it('is false for an ordinary key', () => {
    expect(isImeComposing(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
  });
});
