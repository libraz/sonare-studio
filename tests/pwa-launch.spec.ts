import { describe, expect, it, vi } from 'vitest';
import { installPwaLaunchQueue, type PwaLaunchQueue } from '@/pwa-launch';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('installPwaLaunchQueue', () => {
  it('waits for initial project boot before importing the launched file', async () => {
    let consumer:
      | ((params: { files: readonly { getFile(): Promise<File> }[] }) => void)
      | undefined;
    const queue: PwaLaunchQueue = {
      setConsumer: (next) => {
        consumer = next;
      },
    };
    const boot = deferred();
    const file = new File(['project'], 'opened.szd', { type: 'application/x-sonare-studio' });
    const importFile = vi.fn(async () => undefined);

    installPwaLaunchQueue(queue, {
      waitForBoot: () => boot.promise,
      importFile,
      onError: vi.fn(),
    });
    consumer?.({ files: [{ getFile: vi.fn(async () => file) }] });

    await Promise.resolve();
    expect(importFile).not.toHaveBeenCalled();
    boot.resolve();
    await vi.waitFor(() => expect(importFile).toHaveBeenCalledWith(file));
  });

  it('ignores an empty launch and reports asynchronous failures', async () => {
    let consumer:
      | ((params: { files: readonly { getFile(): Promise<File> }[] }) => void)
      | undefined;
    const queue: PwaLaunchQueue = { setConsumer: (next) => (consumer = next) };
    const onError = vi.fn();

    installPwaLaunchQueue(queue, {
      waitForBoot: async () => undefined,
      importFile: vi.fn(async () => undefined),
      onError,
    });
    consumer?.({ files: [] });
    expect(onError).not.toHaveBeenCalled();

    const failure = new Error('file access denied');
    consumer?.({ files: [{ getFile: vi.fn(async () => Promise.reject(failure)) }] });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
