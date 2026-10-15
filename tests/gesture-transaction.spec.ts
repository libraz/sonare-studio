import { describe, expect, it, vi } from 'vitest';
import { useGestureTransaction } from '@/composables/useGestureTransaction';

describe('useGestureTransaction', () => {
  it('commits once with the opening snapshot when the gesture changed something', () => {
    const commit = vi.fn();
    const tx = useGestureTransaction<string>({ commit });
    tx.begin('before');
    tx.markDirty();
    tx.markDirty();
    tx.end();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('before');
    expect(tx.active).toBe(false);
  });

  it('commits nothing for a clean or cancelled gesture', () => {
    const commit = vi.fn();
    const tx = useGestureTransaction<string>({ commit });
    tx.begin('a');
    tx.end();
    tx.begin('b');
    tx.markDirty();
    tx.cancel();
    tx.markDirty();
    tx.end();
    expect(commit).not.toHaveBeenCalled();
  });

  it('closes a gesture left open when the next one begins', () => {
    const commit = vi.fn();
    const tx = useGestureTransaction<string>({ commit });
    tx.begin('first');
    tx.markDirty();
    tx.begin('second');
    expect(commit).toHaveBeenCalledWith('first');
    tx.end();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('reports a drag only after the pointer travels past the threshold', () => {
    const tx = useGestureTransaction<string>({ commit: vi.fn(), thresholdPx: 4 });
    tx.begin('s', 10, 10);
    expect(tx.move(12, 11)).toBe(false);
    expect(tx.move(14, 10)).toBe(true);
    expect(tx.move(10, 10)).toBe(true);
  });
});
