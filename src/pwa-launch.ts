export interface PwaLaunchFileHandle {
  getFile(): Promise<File>;
}

export interface PwaLaunchQueue {
  setConsumer(consumer: (params: { files: readonly PwaLaunchFileHandle[] }) => void): void;
}

interface PwaLaunchQueueOptions {
  importFile(file: File): Promise<void>;
  onError(reason: unknown): void;
  waitForBoot(): Promise<void>;
}

/**
 * Connects the File Handling API to the app's existing project importer.
 * Waiting for normal startup avoids a launched document being replaced by the
 * restored browser session during the same mounted pass.
 */
export function installPwaLaunchQueue(
  queue: PwaLaunchQueue | undefined,
  options: PwaLaunchQueueOptions,
): void {
  queue?.setConsumer((params) => {
    const handle = params.files[0];
    if (!handle) return;

    void (async () => {
      await options.waitForBoot();
      await options.importFile(await handle.getFile());
    })().catch(options.onError);
  });
}
