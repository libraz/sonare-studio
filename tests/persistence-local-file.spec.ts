import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickedExternalAudioFile } from '@/persistence/local-file';
import {
  LocalFileSizeError,
  matchPickedExternalAudioFile,
  pickViaInputElement,
  readFileBytesBounded,
} from '@/persistence/local-file';

function audioFile(name: string, marker: number, relativePath?: string): PickedExternalAudioFile {
  return {
    name,
    bytes: new Uint8Array([marker]),
    ...(relativePath ? { relativePath } : {}),
  };
}

function currentInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found');
  return input;
}

function stubFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: files,
  });
}

describe('pickViaInputElement', () => {
  afterEach(() => {
    for (const input of document.querySelectorAll('input[type="file"]')) input.remove();
    vi.restoreAllMocks();
  });

  it('resolves null and removes the transient input on cancel', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const picked = pickViaInputElement({
      accept: '.szd',
      read: async () => 'unreachable',
    });
    const input = currentInput();

    input.dispatchEvent(new Event('cancel'));

    await expect(picked).resolves.toBeNull();
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('reads selected files once and ignores a later cancel event', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const read = vi.fn(async (files: File[]) => files.map((file) => file.name));
    const picked = pickViaInputElement({ accept: 'audio/*', multiple: true, read });
    const input = currentInput();
    stubFiles(input, [new File([new Uint8Array([1])], 'a.wav')]);

    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('cancel'));

    await expect(picked).resolves.toEqual(['a.wav']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('rejects read errors and removes the transient input', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const picked = pickViaInputElement({
      accept: '.szd',
      read: async () => {
        throw new Error('read failed');
      },
    });
    const input = currentInput();
    stubFiles(input, [new File([new Uint8Array([1])], 'broken.szd')]);

    input.dispatchEvent(new Event('change'));

    await expect(picked).rejects.toThrow('read failed');
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('bounded local-file reads', () => {
  it('rejects from File.size before reading an oversized payload', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = {
      name: 'huge.szd',
      size: 1025,
      arrayBuffer,
    } as unknown as File;

    await expect(readFileBytesBounded(file, 1024)).rejects.toThrow(LocalFileSizeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('streams into one bounded owned buffer when File.stream is available', async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be used');
    });
    const file = {
      name: 'streamed.szd',
      size: 4,
      arrayBuffer,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
    } as unknown as File;

    await expect(readFileBytesBounded(file, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('DAWproject external audio matching', () => {
  it('uses relative paths before basenames regardless of selection order and case', () => {
    const drums = audioFile('Vox.wav', 1, 'Picked Root/Drums/Vox.wav');
    const vocals = audioFile('VOX.WAV', 2, 'Picked Root/Vocals/VOX.WAV');

    for (const files of [
      [drums, vocals],
      [vocals, drums],
    ]) {
      expect(matchPickedExternalAudioFile('/DRUMS/vox.WAV', files)).toEqual({
        status: 'exact-path',
        file: drums,
      });
      expect(matchPickedExternalAudioFile('vocals/vox.wav', files)).toEqual({
        status: 'exact-path',
        file: vocals,
      });
    }
  });

  it('separates unique, ambiguous and unresolved basename states', () => {
    const drums = audioFile('Vox.wav', 1, 'Drums/Vox.wav');
    const vocals = audioFile('Vox.wav', 2, 'Vocals/Vox.wav');
    const fx = audioFile('Vox.wav', 3, 'FX/Vox.wav');
    const bass = audioFile('Bass.wav', 4);

    expect(matchPickedExternalAudioFile('/Unknown/Bass.wav', [drums, bass])).toEqual({
      status: 'unique-basename',
      file: bass,
    });
    expect(matchPickedExternalAudioFile('/Unknown/Vox.wav', [fx, drums, vocals])).toEqual({
      status: 'ambiguous-basename',
      files: [fx, drums, vocals],
    });
    expect(matchPickedExternalAudioFile('/Unknown/Guitar.wav', [drums, bass])).toEqual({
      status: 'unresolved',
    });
  });
});
