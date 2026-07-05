import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickViaInputElement } from '@/persistence/local-file';

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
