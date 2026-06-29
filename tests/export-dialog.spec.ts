import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import ExportDialog from '@/components/export/ExportDialog.vue';
import type { ExportRenderHandle } from '@/export/client';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownResult,
} from '@/export/mixdown';
import { encodeWav } from '@/export/wav';
import type { ProjectDocument } from '@/project/serialization';
import type { ExportRenderOptions } from '@/workers/export.worker';
import { readOptionLabels, selectOption } from './helpers/select-menu';

/** Minimal valid project document for the render seam. */
function makeDocument(): ProjectDocument {
  return {
    schemaVersion: 3,
    name: 'My Song',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [{ startPpq: 0, numerator: 4, denominator: 4 }],
    tracks: [],
    markers: [],
    sections: [],
  };
}

function makeResult(overrides: Partial<MixdownResult> = {}): MixdownResult {
  return {
    channels: [new Float32Array([0.25, -0.25]), new Float32Array([0.5, -0.5])],
    sampleRate: 48000,
    totalFrames: 2,
    report: { peakDb: -6.0, truePeakDb: -5.8, lufs: -14.2 },
    ...overrides,
  };
}

interface RenderControl {
  render: ReturnType<typeof vi.fn>;
  resolve: (result: MixdownResult) => void;
  reject: (error: Error) => void;
  cancel: ReturnType<typeof vi.fn>;
  progress: () => MixdownProgressFn | undefined;
  options: () => ExportRenderOptions;
}

/** A controllable render seam: one deferred handle shared by all calls. */
function makeRender(): RenderControl {
  let resolveFn: (result: MixdownResult) => void = () => {};
  let rejectFn: (error: Error) => void = () => {};
  const cancel = vi.fn();
  const render = vi.fn(
    (
      _doc: ProjectDocument,
      _options: ExportRenderOptions,
      _onProgress?: MixdownProgressFn,
    ): ExportRenderHandle => {
      const result = new Promise<MixdownResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      return { result, cancel };
    },
  );
  return {
    render,
    resolve: (result) => resolveFn(result),
    reject: (error) => rejectFn(error),
    cancel,
    progress: () => render.mock.calls[0]?.[2] as MixdownProgressFn | undefined,
    options: () => render.mock.calls[0]?.[1] as ExportRenderOptions,
  };
}

interface MountOptions {
  hasLoop?: boolean;
  loopRegion?: { startPpq: number; endPpq: number } | null;
  encoders?: Array<{
    id: string;
    label: string;
    extension: string;
    mime: string;
    encode: (
      channels: ReadonlyArray<Float32Array>,
      sampleRate: number,
      options?: Record<string, unknown>,
    ) => Uint8Array | Promise<Uint8Array>;
  }> | null;
}

function mountDialog(control: RenderControl, options: MountOptions = {}) {
  const download = vi.fn();
  const wrapper = mount(ExportDialog, {
    props: {
      open: true,
      getDocument: makeDocument,
      projectName: 'My Song',
      hasLoop: options.hasLoop ?? false,
      loopRegion: options.loopRegion ?? null,
      render: control.render,
      download,
      encoders: options.encoders ?? null,
    },
  });
  return { wrapper, download };
}

async function clickExport(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.export-button').trigger('click');
}

async function downloadedBytes(download: ReturnType<typeof vi.fn>): Promise<Uint8Array> {
  const blob = download.mock.calls[0][0] as Blob;
  return new Uint8Array(await blob.arrayBuffer());
}

describe('ExportDialog', () => {
  it('renders nothing while closed', () => {
    const wrapper = mount(ExportDialog, {
      props: { open: false, getDocument: makeDocument },
    });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('lists the registered encoders (WAV and MP3)', async () => {
    const { wrapper } = mountDialog(makeRender());
    const labels = await readOptionLabels(wrapper, '.format-select');
    expect(labels.some((l) => l.includes('WAV'))).toBe(true);
    expect(labels.some((l) => l.includes('MP3'))).toBe(true);
  });

  it('hides MP3 when the registry lacks it (injected encoder list)', async () => {
    const { wrapper } = mountDialog(makeRender(), {
      encoders: [
        {
          id: 'wav',
          label: 'WAV (PCM)',
          extension: '.wav',
          mime: 'audio/wav',
          encode: () => new Uint8Array(0),
        },
      ],
    });
    const labels = await readOptionLabels(wrapper, '.format-select');
    expect(labels).toEqual(['WAV (PCM)']);
  });

  it('shows WAV options by default and MP3 options after switching formats', async () => {
    const { wrapper } = mountDialog(makeRender());
    expect(wrapper.find('.wav-bit-depth').exists()).toBe(true);
    expect(wrapper.find('.mp3-bitrate').exists()).toBe(false);
    await selectOption(wrapper, '.format-select', 'MP3 (CBR)');
    expect(wrapper.find('.wav-bit-depth').exists()).toBe(false);
    expect(wrapper.find('.mp3-bitrate').exists()).toBe(true);
  });

  it('disables the loop range without a loop region', () => {
    const { wrapper } = mountDialog(makeRender());
    expect((wrapper.find('.range-loop').element as HTMLInputElement).disabled).toBe(true);
    const withLoop = mountDialog(makeRender(), {
      hasLoop: true,
      loopRegion: { startPpq: 0, endPpq: 8 },
    });
    expect((withLoop.wrapper.find('.range-loop').element as HTMLInputElement).disabled).toBe(false);
  });

  it('shows a validation error and disables Export for MP3 at 96 kHz', async () => {
    const { wrapper } = mountDialog(makeRender());
    await selectOption(wrapper, '.format-select', 'MP3 (CBR)');
    await selectOption(wrapper, '.sample-rate-select', '96 kHz');
    expect(wrapper.find('.dialog-errors').text()).toContain('MP3 supports 44.1 kHz and 48 kHz');
    expect((wrapper.find('.export-button').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('exports a WAV mixdown: progress, download, report and exported event', async () => {
    const control = makeRender();
    const { wrapper, download } = mountDialog(control);
    await selectOption(wrapper, '.wav-bit-depth', '24-bit PCM');
    await clickExport(wrapper);

    expect(control.render).toHaveBeenCalledTimes(1);
    expect(control.options()).toEqual({
      sampleRate: 48000,
      range: 'project',
      includeMasterChain: true,
      stems: false,
    });

    control.progress()?.(0.5, 'clip:0:0');
    await flushPromises();
    expect(wrapper.find('.progress-stage').text()).toBe('clip:0:0');
    expect(wrapper.find('.progress-fill').attributes('style')).toContain('width: 50%');

    const result = makeResult();
    control.resolve(result);
    await flushPromises();

    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1]).toBe('My Song.wav');
    const bytes = await downloadedBytes(download);
    expect(bytes).toEqual(encodeWav(result.channels, 48000, { bitDepth: 24 }));

    expect(wrapper.find('.export-report').exists()).toBe(true);
    expect(wrapper.find('.report-peak').text()).toBe('-6.0 dBFS');
    expect(wrapper.find('.report-true-peak').text()).toBe('-5.8 dBTP');
    expect(wrapper.find('.report-lufs').text()).toBe('-14.2 LUFS');

    const emitted = wrapper.emitted('exported') as Array<[{ filename: string }]>;
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0].filename).toBe('My Song.wav');
  });

  it('passes WAV dither to the encoder when the dither toggle is enabled', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([1, 2, 3]));
    const { wrapper, download } = mountDialog(control, {
      encoders: [
        {
          id: 'wav',
          label: 'WAV (PCM)',
          extension: '.wav',
          mime: 'audio/wav',
          encode,
        },
      ],
    });

    const dither = wrapper.get('.wav-dither');
    expect(dither.attributes('aria-pressed')).toBe('false');
    await dither.trigger('click');
    expect(dither.attributes('aria-pressed')).toBe('true');
    await clickExport(wrapper);

    const result = makeResult();
    control.resolve(result);
    await flushPromises();

    expect(encode).toHaveBeenCalledWith(result.channels, 48000, { bitDepth: 16, dither: true });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('disables dither outside 16-bit WAV and leaves the encoder option false', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([1]));
    const { wrapper } = mountDialog(control, {
      encoders: [
        {
          id: 'wav',
          label: 'WAV (PCM)',
          extension: '.wav',
          mime: 'audio/wav',
          encode,
        },
      ],
    });

    await selectOption(wrapper, '.wav-bit-depth', '24-bit PCM');
    const dither = wrapper.get('.wav-dither');
    expect(dither.attributes('disabled')).toBeDefined();
    await dither.trigger('click');
    expect(dither.attributes('aria-pressed')).toBe('false');
    await clickExport(wrapper);
    control.resolve(makeResult());
    await flushPromises();

    expect(encode.mock.calls[0][2]).toEqual({ bitDepth: 24, dither: false });
  });

  it('passes includeMasterChain false when the master-chain toggle is disabled', async () => {
    const control = makeRender();
    const { wrapper } = mountDialog(control);

    const includeMasterChain = wrapper.get('.include-master-chain');
    expect(includeMasterChain.attributes('aria-pressed')).toBe('true');
    await includeMasterChain.trigger('click');
    expect(includeMasterChain.attributes('aria-pressed')).toBe('false');
    await clickExport(wrapper);

    expect(control.options()).toEqual({
      sampleRate: 48000,
      range: 'project',
      includeMasterChain: false,
      stems: false,
    });
  });

  it('passes the loop window to the render seam', async () => {
    const control = makeRender();
    const { wrapper } = mountDialog(control, {
      hasLoop: true,
      loopRegion: { startPpq: 4, endPpq: 20 },
    });
    await wrapper.find('.range-loop').setValue(true);
    await clickExport(wrapper);
    expect(control.options().range).toBe('loop');
    expect(control.options().loopRegion).toEqual({ startPpq: 4, endPpq: 20 });
  });

  it('zips stems into one WAV file per track', async () => {
    const control = makeRender();
    const { wrapper, download } = mountDialog(control);
    await wrapper.find('.mode-stems').setValue(true);
    await clickExport(wrapper);
    expect(control.options().stems).toBe(true);

    const stems = [
      {
        trackIndex: 0,
        name: 'Drums',
        channels: [new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])] as [
          Float32Array,
          Float32Array,
        ],
      },
      {
        trackIndex: 1,
        name: 'Bass',
        channels: [new Float32Array([0.5, 0.6]), new Float32Array([0.7, 0.8])] as [
          Float32Array,
          Float32Array,
        ],
      },
    ];
    control.resolve(makeResult({ stems }));
    await flushPromises();

    expect(download.mock.calls[0][1]).toBe('My Song stems.zip');
    const entries = unzipSync(await downloadedBytes(download));
    expect(Object.keys(entries).sort()).toEqual(['01 Drums.wav', '02 Bass.wav']);
    expect(entries['01 Drums.wav']).toEqual(encodeWav(stems[0].channels, 48000, { bitDepth: 16 }));
    expect(entries['02 Bass.wav']).toEqual(encodeWav(stems[1].channels, 48000, { bitDepth: 16 }));
  });

  it('surfaces an error when stems mode returns no stems', async () => {
    const control = makeRender();
    const { wrapper, download } = mountDialog(control);
    await wrapper.find('.mode-stems').setValue(true);
    await clickExport(wrapper);
    control.resolve(makeResult());
    await flushPromises();
    expect(download).not.toHaveBeenCalled();
    expect(wrapper.find('.dialog-error').text()).toContain('No stems were rendered');
  });

  it('cancel during render rejects quietly with a cancelled note', async () => {
    const control = makeRender();
    const { wrapper, download } = mountDialog(control);
    await clickExport(wrapper);
    await wrapper.find('.cancel-render').trigger('click');
    expect(control.cancel).toHaveBeenCalledTimes(1);
    control.reject(new MixdownCancelledError());
    await flushPromises();

    expect(wrapper.find('.export-cancelled').exists()).toBe(true);
    expect(wrapper.find('.dialog-error').exists()).toBe(false);
    expect(wrapper.emitted('exported')).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    // The dialog is usable again.
    expect((wrapper.find('.export-button').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows render errors inline and re-enables the form', async () => {
    const control = makeRender();
    const { wrapper } = mountDialog(control);
    await clickExport(wrapper);
    control.reject(new Error('asset missing'));
    await flushPromises();
    expect(wrapper.find('.dialog-error').text()).toBe('asset missing');
    expect(wrapper.emitted('exported')).toBeUndefined();
    expect((wrapper.find('.export-button').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks Close while busy and emits close when idle', async () => {
    const control = makeRender();
    const { wrapper } = mountDialog(control);
    await clickExport(wrapper);
    expect((wrapper.find('.close-button').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.find('.close-button').trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined();

    control.resolve(makeResult());
    await flushPromises();
    await wrapper.find('.close-button').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('emits close from Escape and the overlay when idle', async () => {
    const { wrapper } = mountDialog(makeRender());
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    await wrapper.find('.dialog-overlay').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(2);
  });

  it('reseeds the filename from the project name when reopened', async () => {
    const { wrapper } = mountDialog(makeRender());
    await wrapper.find('.filename-input').setValue('custom name');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect((wrapper.find('.filename-input').element as HTMLInputElement).value).toBe('My Song');
  });
});
