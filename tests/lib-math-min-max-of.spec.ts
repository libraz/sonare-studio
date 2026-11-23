import { describe, expect, it } from 'vitest';
import { maxOf, minOf } from '@/lib/math';

describe('minOf / maxOf', () => {
  it('match Math.min / Math.max on ordinary input', () => {
    expect(minOf([3, -1, 2])).toBe(-1);
    expect(maxOf([3, -1, 2])).toBe(3);
  });

  it('return Infinity / -Infinity for an empty iterable', () => {
    expect(minOf([])).toBe(Number.POSITIVE_INFINITY);
    expect(maxOf([])).toBe(Number.NEGATIVE_INFINITY);
  });

  it('propagate NaN wherever it appears', () => {
    expect(minOf([1, Number.NaN, 0])).toBeNaN();
    expect(maxOf([Number.NaN, 1])).toBeNaN();
    expect(maxOf([1, 2, Number.NaN])).toBeNaN();
  });

  it('order -0 below +0', () => {
    expect(Object.is(minOf([0, -0]), -0)).toBe(true);
    expect(Object.is(minOf([-0, 0]), -0)).toBe(true);
    expect(Object.is(maxOf([-0, 0]), 0)).toBe(true);
    expect(Object.is(maxOf([0, -0]), 0)).toBe(true);
  });

  it('accepts any iterable and handles huge arrays', () => {
    expect(minOf(new Set([4, 2, 9]))).toBe(2);
    const big = Array.from({ length: 300_000 }, (_, i) => i);
    expect(maxOf(big)).toBe(299_999);
    expect(minOf(big)).toBe(0);
  });
});
