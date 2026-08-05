import { describe, expect, it } from 'vitest';
import { SNAP_CHOICES } from '@/ui/shell/app-shell-options';

describe('SNAP_CHOICES', () => {
  it('offers bar, triplet, and dotted grids alongside straight note divisions', () => {
    expect(SNAP_CHOICES).toContainEqual({ value: 'bar', label: 'Bar' });
    expect(SNAP_CHOICES).toContainEqual({ value: 12, label: '1/8T' });
    expect(SNAP_CHOICES).toContainEqual({ value: 24, label: '1/16T' });
    expect(SNAP_CHOICES).toContainEqual({ value: 8 / 3, label: '1/4.' });
    expect(SNAP_CHOICES).toContainEqual({ value: 16 / 3, label: '1/8.' });
    expect(SNAP_CHOICES).toContainEqual({ value: 32 / 3, label: '1/16.' });
  });
});
