import { describe, expect, it } from 'vitest';
import { firstBlock } from '@/ui/disabled-reason';

describe('firstBlock', () => {
  it('returns null when no gate blocks', () => {
    expect(firstBlock([false, 'a'], [false, 'b'], null, '')).toBeNull();
  });

  it('returns the first blocking reason in order', () => {
    expect(firstBlock([false, 'a'], [true, 'b'], [true, 'c'])).toBe('b');
  });

  it('passes an upstream reason through ahead of local gates', () => {
    expect(firstBlock('engine stopped', [true, 'no selection'])).toBe('engine stopped');
    expect(firstBlock(null, [true, 'no selection'])).toBe('no selection');
  });
});
