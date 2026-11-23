import { afterEach, describe, expect, it } from 'vitest';
import {
  pickAndReadBrowserBackup,
  pickAndReadDawproject,
  pickAndReadExternalAudioFiles,
  pickAndReadSzd,
} from '@/persistence/local-file';

type Picker = (options: { types: Array<{ description?: string }> }) => Promise<[]>;

describe('native file picker descriptions', () => {
  afterEach(() => {
    delete (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  function install(): string[] {
    const seen: string[] = [];
    const picker: Picker = async (options) => {
      seen.push(options.types[0]?.description ?? '');
      return [];
    };
    (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker = picker;
    return seen;
  }

  it('shows the caller-supplied localized description', async () => {
    const seen = install();
    await pickAndReadSzd('プロジェクト');
    await pickAndReadBrowserBackup('バックアップ');
    await pickAndReadDawproject('DAWproject ファイル');
    await pickAndReadExternalAudioFiles('音声ファイル');
    expect(seen).toEqual(['プロジェクト', 'バックアップ', 'DAWproject ファイル', '音声ファイル']);
  });
});
