import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSISTENCE_MUTATION_LOCK,
  resetPersistenceMutationLockForTests,
  withPersistenceMutationLock,
} from '@/persistence/mutation-lock';

describe('origin-wide persistence mutation lock', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  afterEach(() => {
    resetPersistenceMutationLockForTests();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });

  it('serializes mutations through the same-realm fallback queue', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    let releaseFirst!: () => void;
    const events: string[] = [];
    const first = withPersistenceMutationLock(async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = withPersistenceMutationLock(async () => {
      events.push('second');
    });

    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('requests the shared origin lock from the Web Locks API', async () => {
    const request = vi.fn(
      async (_name: string, _options: LockOptions, callback: () => Promise<string>) => callback(),
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request } as unknown as LockManager,
    });

    await expect(withPersistenceMutationLock(async () => 'done')).resolves.toBe('done');
    expect(request).toHaveBeenCalledWith(
      PERSISTENCE_MUTATION_LOCK,
      { mode: 'exclusive' },
      expect.any(Function),
    );
  });
});
