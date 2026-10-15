import { beforeEach, describe, expect, it } from 'vitest';
import { useAppSettings } from '@/composables/useAppSettings';
import { confirmDestructive, dialogQueue } from '@/composables/useDialogs';

describe('confirmDestructive', () => {
  beforeEach(() => {
    dialogQueue.splice(0);
    useAppSettings().set('confirmDestructive', true);
  });

  it('asks with a danger dialog while destructive confirmations are on', async () => {
    const answer = confirmDestructive({ message: 'Delete everything?' });
    expect(dialogQueue).toHaveLength(1);
    expect(dialogQueue[0]).toMatchObject({ kind: 'confirm', danger: true });
    dialogQueue[0]?.resolve(true);
    await expect(answer).resolves.toBe(true);
  });

  it('resolves true without asking when destructive confirmations are off', async () => {
    useAppSettings().set('confirmDestructive', false);
    await expect(confirmDestructive({ message: 'Delete everything?' })).resolves.toBe(true);
    expect(dialogQueue).toHaveLength(0);
  });
});
