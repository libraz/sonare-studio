import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pickAndReadBrowserBackup,
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
} from '@/persistence/local-file';

/** The File System Access rule: a dot, then at most 15 of [A-Za-z0-9+.], not ending in a dot. */
function isPickerValid(extension: string): boolean {
  return extension.length <= 16 && /^\.[A-Za-z0-9+.]*[A-Za-z0-9+]$/.test(extension);
}

type Picker = (options: { types: Array<{ accept: Record<string, string[]> }> }) => Promise<[]>;

describe('native file picker accept lists', () => {
  afterEach(() => {
    delete (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  it('hands the picker only extensions it accepts', async () => {
    const picker = vi.fn<Picker>(async () => []);
    (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker = picker;

    await pickAndReadSzd();
    await pickAndReadBrowserBackup();
    await pickAndReadDawproject();
    await pickAndReadExternalAudioFiles();

    expect(picker).toHaveBeenCalledTimes(4);
    for (const [options] of picker.mock.calls) {
      const extensions = options.types.flatMap((type) => Object.values(type.accept).flat());
      expect(extensions.length).toBeGreaterThan(0);
      expect(extensions.filter((extension) => !isPickerValid(extension))).toEqual([]);
    }
    const [backupOptions] = picker.mock.calls[1];
    const backupExtensions = Object.values(backupOptions.types[0].accept).flat();
    // The downloaded "<name>.sonare-backup.zip" still matches.
    expect(backupExtensions.some((extension) => 'x.sonare-backup.zip'.endsWith(extension))).toBe(
      true,
    );
  });
});
