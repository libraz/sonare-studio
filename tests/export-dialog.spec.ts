import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ExportDialog from '@/components/export/ExportDialog.vue';
import { dialogQueue, resolveDialog } from '@/composables/useDialogs';
import type { ExportRenderHandle } from '@/export/client';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownResult,
} from '@/export/mixdown';
import { encodeWav } from '@/export/wav';
import type { ProjectDocument } from '@/project/serialization';
import type { ExportRenderOptions } from '@/workers/export.worker';
import { chooseOption, openOptionLabels } from './helpers/select-menu';

// AppModal teleports its content (and SelectMenu its dropdown) to <body>, so the
// dialog is queried through the document rather than the wrapper, and events are
// dispatched natively. The mounts use attachTo: document.body so the teleported
// trees live in the real document where the SelectMenu helper looks for options.

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

/** Opens the SelectMenu matched by `selector` via its teleported trigger. */
async function openSelect(selector: string): Promise<void> {
  q(`${selector} .select-trigger`)?.click();
  await flushPromises();
}

/** Opens the SelectMenu and picks the option labelled `label`. */
async function selectOption(selector: string, label: string): Promise<void> {
  await openSelect(selector);
  await chooseOption(label);
}

/** Reads every option label of the SelectMenu matched by `selector`. */
async function readOptionLabels(selector: string): Promise<string[]> {
  await openSelect(selector);
  const labels = openOptionLabels();
  q(`${selector} .select-trigger`)?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await flushPromises();
  return labels;
}

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
  emitStem: (
    stem: NonNullable<MixdownResult['stems']>[number],
    index: number,
    total: number,
  ) => Promise<void>;
  emitMixdown: (
    channels: readonly [Float32Array, Float32Array],
    offsetFrames: number,
    totalFrames: number,
  ) => Promise<void>;
}

/** A controllable render seam: one deferred handle shared by all calls. */
function makeRender(): RenderControl {
  let resolveFn: (result: MixdownResult) => void = () => {};
  let rejectFn: (error: Error) => void = () => {};
  const cancel = vi.fn();
  let onStemFn:
    | ((
        stem: NonNullable<MixdownResult['stems']>[number],
        index: number,
        total: number,
      ) => Promise<void> | void)
    | undefined;
  let onMixdownFn:
    | ((
        channels: readonly [Float32Array, Float32Array],
        offsetFrames: number,
        totalFrames: number,
      ) => Promise<void> | void)
    | undefined;
  const render = vi.fn(
    (
      _doc: ProjectDocument,
      _options: ExportRenderOptions,
      _onProgress?: MixdownProgressFn,
      onStem?: (
        stem: NonNullable<MixdownResult['stems']>[number],
        index: number,
        total: number,
      ) => Promise<void> | void,
      onMixdownChunk?: (
        channels: readonly [Float32Array, Float32Array],
        offsetFrames: number,
        totalFrames: number,
      ) => Promise<void> | void,
    ): ExportRenderHandle => {
      onStemFn = onStem;
      onMixdownFn = onMixdownChunk;
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
    emitStem: async (stem, index, total) => {
      if (!onStemFn) throw new Error('Stem consumer was not registered');
      await onStemFn(stem, index, total);
    },
    emitMixdown: async (channels, offsetFrames, totalFrames) => {
      if (!onMixdownFn) throw new Error('Mixdown consumer was not registered');
      await onMixdownFn(channels, offsetFrames, totalFrames);
    },
  };
}

interface MountOptions {
  getDocument?: () => ProjectDocument;
  hasLoop?: boolean;
  loopRegion?: { startPpq: number; endPpq: number } | null;
  encoders?: Array<{
    id: string;
    label: string;
    extension: string;
    mime: string;
    deterministic?: boolean;
    encode: (
      channels: ReadonlyArray<Float32Array>,
      sampleRate: number,
      options?: Record<string, unknown>,
    ) => Uint8Array | Promise<Uint8Array>;
  }> | null;
}

let mounted: VueWrapper[] = [];

function track<W extends VueWrapper>(wrapper: W): W {
  mounted.push(wrapper);
  return wrapper;
}

function mountDialog(control: RenderControl, options: MountOptions = {}) {
  const download = vi.fn();
  const wrapper = track(
    mount(ExportDialog, {
      props: {
        open: true,
        getDocument: options.getDocument ?? makeDocument,
        projectName: 'My Song',
        hasLoop: options.hasLoop ?? false,
        loopRegion: options.loopRegion ?? null,
        render: control.render,
        download,
        encoders: options.encoders ?? null,
      },
      attachTo: document.body,
    }),
  );
  return { wrapper, download };
}

async function clickExport(): Promise<void> {
  q('.export-button')?.click();
  await nextTick();
}

async function downloadedBytes(download: ReturnType<typeof vi.fn>): Promise<Uint8Array> {
  const blob = download.mock.calls[0][0] as Blob;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Selects a radio input and notifies the v-model binding. */
async function checkRadio(selector: string): Promise<void> {
  const input = q<HTMLInputElement>(selector);
  if (!input) throw new Error(`radio not found: ${selector}`);
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount();
  mounted = [];
  document.body.innerHTML = '';
  dialogQueue.splice(0);
});

describe('ExportDialog', () => {
  it('confirms a user-selected large memory budget before rendering', async () => {
    const control = makeRender();
    mountDialog(control);

    await selectOption('.memory-budget-select', '2 GiB');
    await clickExport();
    await flushPromises();

    expect(control.render).not.toHaveBeenCalled();
    expect(dialogQueue[0]?.message).toContain('2048 MiB');
    resolveDialog(dialogQueue[0].id, true);
    await flushPromises();
    expect(control.options().memoryBudgetBytes).toBe(2048 * 1024 * 1024);
    control.resolve(makeResult());
    await flushPromises();
  });

  it('requires confirmation before rendering time-varying unsupported automation', async () => {
    const control = makeRender();
    const doc = makeDocument();
    doc.tracks.push({
      name: 'Keys',
      color: '#fff',
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      instrument: { kind: 'synth-patch', patch: { preset: 'lead', cutoffHz: 800 } },
      automation: [
        {
          param: 'instrument:cutoffHz',
          enabled: true,
          points: [
            { ppq: 0, value: 800 },
            { ppq: 4, value: 2400 },
          ],
        },
      ],
      clips: [],
    });
    mountDialog(control, { getDocument: () => doc });

    await clickExport();
    await flushPromises();
    expect(control.render).not.toHaveBeenCalled();
    expect(dialogQueue[0]?.message).toContain(
      'Instrument automation was evaluated at render start',
    );

    resolveDialog(dialogQueue[0].id, true);
    await flushPromises();
    expect(control.render).toHaveBeenCalledTimes(1);
    control.resolve(makeResult());
    await flushPromises();
  });

  it('renders nothing while closed', () => {
    track(
      mount(ExportDialog, {
        props: { open: false, getDocument: makeDocument },
        attachTo: document.body,
      }),
    );
    expect(q('[role="dialog"]')).toBeNull();
  });

  it('lists the registered encoders (WAV, FLAC and MP3)', async () => {
    mountDialog(makeRender());
    const labels = await readOptionLabels('.format-select');
    expect(labels.some((l) => l.includes('WAV'))).toBe(true);
    expect(labels.some((l) => l.includes('FLAC'))).toBe(true);
    expect(labels.some((l) => l.includes('MP3'))).toBe(true);
  });

  it('hides MP3 when the registry lacks it (injected encoder list)', async () => {
    mountDialog(makeRender(), {
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
    const labels = await readOptionLabels('.format-select');
    expect(labels).toEqual(['WAV (PCM)']);
  });

  it('shows format-specific options for WAV, FLAC and MP3', async () => {
    mountDialog(makeRender());
    expect(q('.wav-bit-depth')).not.toBeNull();
    expect(q('.flac-bit-depth')).toBeNull();
    expect(q('.mp3-bitrate')).toBeNull();
    expect(q('.compressed-bitrate')).toBeNull();
    await selectOption('.format-select', 'FLAC (lossless)');
    expect(q('.wav-bit-depth')).toBeNull();
    expect(q('.flac-bit-depth')).not.toBeNull();
    expect(q('.flac-dither')).not.toBeNull();
    expect(await readOptionLabels('.flac-bit-depth')).toEqual(['16-bit PCM', '24-bit PCM']);
    expect(q('.mp3-bitrate')).toBeNull();
    expect(q('.compressed-bitrate')).toBeNull();
    await selectOption('.format-select', 'MP3 (CBR)');
    expect(q('.wav-bit-depth')).toBeNull();
    expect(q('.flac-bit-depth')).toBeNull();
    expect(q('.mp3-bitrate')).not.toBeNull();
    expect(q('.compressed-bitrate')).toBeNull();
  });

  it('shows browser compressed bitrate options for Opus/AAC encoders', async () => {
    mountDialog(makeRender(), {
      encoders: [
        {
          id: 'opus-webm',
          label: 'Opus (WebM)',
          extension: '.webm',
          mime: 'audio/webm;codecs=opus',
          deterministic: false,
          encode: () => new Uint8Array(0),
        },
      ],
    });

    expect(q('.wav-bit-depth')).toBeNull();
    expect(q('.mp3-bitrate')).toBeNull();
    expect(q('.compressed-bitrate')).not.toBeNull();
    expect(await readOptionLabels('.compressed-bitrate')).toEqual([
      '128 kbps',
      '192 kbps',
      '256 kbps',
      '320 kbps',
    ]);
    expect(q('.encoder-notice')?.textContent).toContain('MediaRecorder');
    // The notice sets the expectation that MediaRecorder encodes in real time.
    expect(q('.encoder-notice')?.textContent).toContain('real time');
  });

  it('shows bitrate options for runtime compressed encoders from registry metadata', async () => {
    const encode = vi.fn(() => new Uint8Array([7]));
    const control = makeRender();
    mountDialog(control, {
      encoders: [
        {
          id: 'runtime-aac',
          label: 'Runtime AAC',
          extension: '.m4a',
          mime: 'audio/mp4',
          deterministic: false,
          encode,
        },
      ],
    });

    expect(q('.compressed-bitrate')).not.toBeNull();
    expect(q('.encoder-notice')?.textContent).toContain('MediaRecorder');
    await selectOption('.compressed-bitrate', '128 kbps');
    await clickExport();

    const result = makeResult({
      report: {
        peakDb: -6.0,
        truePeakDb: -5.8,
        lufs: -14.2,
        limitations: [{ kind: 'instrument-automation-at-render-start', tracks: ['Keys'] }],
      },
    });
    control.resolve(result);
    await flushPromises();

    expect(encode).toHaveBeenCalledWith(result.channels, 48000, { bitrate: 128 });
  });

  it('disables the loop range without a loop region', () => {
    mountDialog(makeRender());
    expect(q<HTMLInputElement>('.range-loop')?.disabled).toBe(true);
    document.body.innerHTML = '';
    mountDialog(makeRender(), {
      hasLoop: true,
      loopRegion: { startPpq: 0, endPpq: 8 },
    });
    expect(q<HTMLInputElement>('.range-loop')?.disabled).toBe(false);
  });

  it('shows a validation error and disables Export for MP3 at 96 kHz', async () => {
    mountDialog(makeRender());
    await selectOption('.format-select', 'MP3 (CBR)');
    await selectOption('.sample-rate-select', '96 kHz');
    expect(q('.dialog-errors')?.textContent).toContain('MP3 supports 44.1 kHz and 48 kHz');
    expect(q<HTMLButtonElement>('.export-button')?.disabled).toBe(true);
  });

  it('exports a WAV mixdown: progress, download, report and exported event', async () => {
    const control = makeRender();
    const { wrapper, download } = mountDialog(control);
    await selectOption('.wav-bit-depth', '24-bit PCM');
    await clickExport();

    expect(control.render).toHaveBeenCalledTimes(1);
    expect(control.options()).toEqual({
      sampleRate: 48000,
      range: 'project',
      includeMasterChain: true,
      stems: false,
      busStems: false,
      masterStem: false,
      releaseTailSeconds: 2,
      memoryBudgetBytes: 1024 * 1024 * 1024,
    });

    control.progress()?.(0.5, 'clip:0:0');
    await flushPromises();
    expect(q('.progress-stage')?.textContent).toBe('clip:0:0');
    expect(q('.progress-fill')?.getAttribute('style')).toContain('width: 50%');

    const result = makeResult({
      report: {
        peakDb: -6.0,
        truePeakDb: -5.8,
        lufs: -14.2,
        limitations: [{ kind: 'instrument-automation-at-render-start', tracks: ['Keys'] }],
      },
    });
    control.resolve(result);
    await flushPromises();

    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][1]).toBe('My Song.wav');
    const bytes = await downloadedBytes(download);
    expect(bytes).toEqual(encodeWav(result.channels, 48000, { bitDepth: 24 }));

    expect(q('.export-report')).not.toBeNull();
    expect(q('.report-peak')?.textContent).toBe('-6.0 dBFS');
    expect(q('.report-true-peak')?.textContent).toBe('-5.8 dBTP');
    expect(q('.report-lufs')?.textContent).toBe('-14.2 LUFS');
    expect(q('.report-limitations')?.textContent).toContain('Limitations');
    expect(q('.report-limitations')?.textContent).toContain(
      'Instrument automation was evaluated at render start for: Keys',
    );

    const emitted = wrapper.emitted('exported') as Array<
      [{ filename: string; report: { limitations?: unknown[] } }]
    >;
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0].filename).toBe('My Song.wav');
    expect(emitted[0][0].report.limitations).toEqual([
      { kind: 'instrument-automation-at-render-start', tracks: ['Keys'] },
    ]);
  });

  it('blocks download when the render discovers media issues after preflight', async () => {
    const control = makeRender();
    const { download } = mountDialog(control);
    await clickExport();
    control.resolve(
      makeResult({
        report: {
          peakDb: -6,
          lufs: -14,
          mediaIssues: [
            { kind: 'audio-asset', id: 'clip-7', reason: 'missing-or-unreadable' },
            { kind: 'soundfont', id: 'piano.sf2', reason: 'missing-or-unreadable' },
          ],
        },
      }),
    );
    await flushPromises();

    const text = q('.dialog-error')?.textContent ?? '';
    // The raw machine kind never leaks; it is replaced with a localized label.
    expect(text).toContain('Missing or unreadable audio asset: clip-7');
    expect(text).toContain('Missing or unreadable SoundFont: piano.sf2');
    expect(text).not.toContain('audio-asset');
    expect(download).not.toHaveBeenCalled();
  });

  it('passes WAV dither to the encoder when the dither toggle is enabled', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([1, 2, 3]));
    const { download } = mountDialog(control, {
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

    const dither = q('.wav-dither');
    expect(dither?.getAttribute('aria-pressed')).toBe('false');
    dither?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(dither?.getAttribute('aria-pressed')).toBe('true');
    await clickExport();

    const result = makeResult();
    control.resolve(result);
    await flushPromises();

    expect(encode).toHaveBeenCalledWith(result.channels, 48000, { bitDepth: 16, dither: true });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('passes FLAC bit depth to the encoder', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([4, 5, 6]));
    const { download } = mountDialog(control, {
      encoders: [
        {
          id: 'flac',
          label: 'FLAC (lossless)',
          extension: '.flac',
          mime: 'audio/flac',
          encode,
        },
      ],
    });

    await selectOption('.flac-bit-depth', '16-bit PCM');
    await clickExport();

    const result = makeResult();
    control.resolve(result);
    await flushPromises();

    expect(encode).toHaveBeenCalledWith(result.channels, 48000, { bitDepth: 16, dither: false });
    expect(download.mock.calls[0][1]).toBe('My Song.flac');
  });

  it('normalizes mixdown loudness to the app target before encoding', async () => {
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

    q('.normalize-loudness')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    await clickExport();

    control.resolve(makeResult({ report: { peakDb: -6, truePeakDb: -5.8, lufs: -20 } }));
    await flushPromises();

    const channels = encode.mock.calls[0][0] as ReadonlyArray<Float32Array>;
    expect(channels[0][0]).toBeCloseTo(0.25 * 10 ** (4.8 / 20), 6);
    expect(channels[1][0]).toBeCloseTo(0.5 * 10 ** (4.8 / 20), 6);
    expect(q('.report-lufs')?.textContent).toBe('-15.2 LUFS');
    const emitted = wrapper.emitted('exported') as Array<[{ report: { lufs?: number } }]>;
    expect(emitted[0][0].report.lufs).toBeCloseTo(-15.2, 6);
  });

  it('disables dither outside 16-bit WAV and leaves the encoder option false', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([1]));
    mountDialog(control, {
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

    await selectOption('.wav-bit-depth', '24-bit PCM');
    const dither = q<HTMLButtonElement>('.wav-dither');
    expect(dither?.disabled).toBe(true);
    dither?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(dither?.getAttribute('aria-pressed')).toBe('false');
    await clickExport();
    control.resolve(makeResult());
    await flushPromises();

    expect(encode.mock.calls[0][2]).toEqual({ bitDepth: 24, dither: false });
  });

  it('passes includeMasterChain false when the master-chain toggle is disabled', async () => {
    const control = makeRender();
    mountDialog(control);

    const includeMasterChain = q('.include-master-chain');
    expect(includeMasterChain?.getAttribute('aria-pressed')).toBe('true');
    includeMasterChain?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(includeMasterChain?.getAttribute('aria-pressed')).toBe('false');
    await clickExport();

    expect(control.options()).toEqual({
      sampleRate: 48000,
      range: 'project',
      includeMasterChain: false,
      stems: false,
      busStems: false,
      masterStem: false,
      releaseTailSeconds: 2,
      memoryBudgetBytes: 1024 * 1024 * 1024,
    });
  });

  it('passes the loop window to the render seam', async () => {
    const control = makeRender();
    mountDialog(control, {
      hasLoop: true,
      loopRegion: { startPpq: 4, endPpq: 20 },
    });
    await checkRadio('.range-loop');
    await clickExport();
    expect(control.options().range).toBe('loop');
    expect(control.options().loopRegion).toEqual({ startPpq: 4, endPpq: 20 });
  });

  it('zips stems into one WAV file per track', async () => {
    const control = makeRender();
    const { download } = mountDialog(control);
    await checkRadio('.mode-stems');
    await clickExport();
    expect(control.options().stems).toBe(true);
    expect(control.options().busStems).toBe(true);
    expect(control.options().masterStem).toBe(true);

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

    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));

    expect(download.mock.calls[0][1]).toBe('My Song stems.zip');
    const entries = unzipSync(await downloadedBytes(download));
    expect(Object.keys(entries).sort()).toEqual(['01 Drums.wav', '02 Bass.wav']);
    expect(entries['01 Drums.wav']).toEqual(encodeWav(stems[0].channels, 48000, { bitDepth: 16 }));
    expect(entries['02 Bass.wav']).toEqual(encodeWav(stems[1].channels, 48000, { bitDepth: 16 }));
  });

  it('encodes streamed stems before the render result settles', async () => {
    const control = makeRender();
    const encode = vi.fn((channels: ReadonlyArray<Float32Array>) =>
      Promise.resolve(new Uint8Array([channels[0][0] * 100])),
    );
    const { download } = mountDialog(control, {
      encoders: [{ id: 'wav', label: 'WAV', extension: '.wav', mime: 'audio/wav', encode }],
    });
    await checkRadio('.mode-stems');
    await clickExport();

    await control.emitStem(
      {
        trackIndex: 0,
        name: 'Drums',
        channels: [new Float32Array([0.1]), new Float32Array([0.2])],
      },
      0,
      2,
    );
    expect(encode).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    await control.emitStem(
      {
        trackIndex: 1,
        name: 'Bass',
        channels: [new Float32Array([0.3]), new Float32Array([0.4])],
      },
      1,
      2,
    );
    control.resolve(makeResult());
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));

    const entries = unzipSync(await downloadedBytes(download));
    expect(entries['01 Drums.wav']).toEqual(new Uint8Array([10]));
    expect(entries['02 Bass.wav']).toEqual(new Uint8Array([30]));
  });

  it('writes eligible WAV mixdowns from streamed PCM blocks without calling the one-shot encoder', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([99]));
    const { download } = mountDialog(control, {
      encoders: [{ id: 'wav', label: 'WAV', extension: '.wav', mime: 'audio/wav', encode }],
    });
    await clickExport();

    await control.emitMixdown([new Float32Array([0.25]), new Float32Array([-0.25])], 0, 2);
    await control.emitMixdown([new Float32Array([0.5]), new Float32Array([-0.5])], 1, 2);
    control.resolve(makeResult({ channels: [new Float32Array(0), new Float32Array(0)] }));

    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(encode).not.toHaveBeenCalled();
    expect(await downloadedBytes(download)).toEqual(
      encodeWav([new Float32Array([0.25, 0.5]), new Float32Array([-0.25, -0.5])], 48_000, {
        bitDepth: 16,
      }),
    );
  });

  it('exports stems at unity even when normalization is on, preserving mix balance', async () => {
    const control = makeRender();
    const encode = vi.fn(() => new Uint8Array([1]));
    mountDialog(control, {
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
    await checkRadio('.mode-stems');
    q('.normalize-loudness')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    await clickExport();

    control.resolve(
      makeResult({
        stems: [
          {
            trackIndex: 0,
            name: 'Drums',
            channels: [new Float32Array([0.25]), new Float32Array([0.5])] as [
              Float32Array,
              Float32Array,
            ],
            report: { peakDb: -6, truePeakDb: -5.5, lufs: -20 },
          },
          {
            trackIndex: 1,
            name: 'Bass',
            channels: [new Float32Array([0.5]), new Float32Array([0.25])] as [
              Float32Array,
              Float32Array,
            ],
            report: { peakDb: -6, lufs: -10 },
          },
          {
            trackIndex: 2,
            name: 'No Meter',
            channels: [new Float32Array([0.125]), new Float32Array([0.125])] as [
              Float32Array,
              Float32Array,
            ],
            report: { peakDb: -18 },
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(3));

    // Every stem keeps its raw level: independent per-stem normalization would
    // apply a different gain to each, breaking the balance so they no longer
    // sum back to the mix.
    const first = encode.mock.calls[0][0] as readonly [Float32Array, Float32Array];
    const second = encode.mock.calls[1][0] as readonly [Float32Array, Float32Array];
    const third = encode.mock.calls[2][0] as readonly [Float32Array, Float32Array];
    expect(first[0][0]).toBeCloseTo(0.25, 6);
    expect(first[1][0]).toBeCloseTo(0.5, 6);
    expect(second[0][0]).toBeCloseTo(0.5, 6);
    expect(second[1][0]).toBeCloseTo(0.25, 6);
    expect(third[0][0]).toBeCloseTo(0.125, 6);
  });

  it('explains that stem exports skip loudness normalization', async () => {
    const control = makeRender();
    mountDialog(control);
    expect(q('.stem-normalization-note')).toBeNull();
    await checkRadio('.mode-stems');
    q('.normalize-loudness')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(q('.stem-normalization-note')).not.toBeNull();
    // The note is specific to stems mode; mixdown normalization is unaffected.
    await checkRadio('.mode-mixdown');
    await nextTick();
    expect(q('.stem-normalization-note')).toBeNull();
  });

  it('can disable bus return stems in stems mode', async () => {
    const control = makeRender();
    mountDialog(control);
    await checkRadio('.mode-stems');
    const includeBusStems = q('.include-bus-stems');
    expect(includeBusStems?.getAttribute('aria-pressed')).toBe('true');
    includeBusStems?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(includeBusStems?.getAttribute('aria-pressed')).toBe('false');
    await clickExport();

    expect(control.options()).toMatchObject({
      stems: true,
      busStems: false,
    });
  });

  it('can disable the final master stem in stems mode', async () => {
    const control = makeRender();
    mountDialog(control);
    await checkRadio('.mode-stems');
    const includeMasterStem = q('.include-master-stem');
    expect(includeMasterStem?.getAttribute('aria-pressed')).toBe('true');
    includeMasterStem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(includeMasterStem?.getAttribute('aria-pressed')).toBe('false');
    await clickExport();

    expect(control.options()).toMatchObject({
      stems: true,
      masterStem: false,
    });
  });

  it('surfaces an error when stems mode returns no stems', async () => {
    const control = makeRender();
    const { download } = mountDialog(control);
    await checkRadio('.mode-stems');
    await clickExport();
    control.resolve(makeResult());
    await flushPromises();
    expect(download).not.toHaveBeenCalled();
    expect(q('.dialog-error')?.textContent).toContain('No stems were rendered');
  });

  it('cancel during render rejects quietly with a cancelled note', async () => {
    const control = makeRender();
    const { wrapper, download } = mountDialog(control);
    await clickExport();
    q('.cancel-render')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(control.cancel).toHaveBeenCalledTimes(1);
    control.reject(new MixdownCancelledError());
    await flushPromises();

    expect(q('.export-cancelled')).not.toBeNull();
    expect(q('.dialog-error')).toBeNull();
    expect(wrapper.emitted('exported')).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    // The dialog is usable again.
    expect(q<HTMLButtonElement>('.export-button')?.disabled).toBe(false);
  });

  it('cancels an in-flight encoder after rendering has completed', async () => {
    const control = makeRender();
    const encode = vi.fn(
      (_channels, _sampleRate, options?: Record<string, unknown>) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          const signal = options?.['signal'] as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { download } = mountDialog(control, {
      encoders: [{ id: 'wav', label: 'WAV', extension: '.wav', mime: 'audio/wav', encode }],
    });
    await clickExport();
    control.resolve(makeResult());
    await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce());

    q('.cancel-render')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();

    expect(q('.export-cancelled')).not.toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('shows render errors inline and re-enables the form', async () => {
    const control = makeRender();
    const { wrapper } = mountDialog(control);
    await clickExport();
    control.reject(new Error('asset missing'));
    await flushPromises();
    expect(q('.dialog-error')?.textContent).toBe('asset missing');
    expect(wrapper.emitted('exported')).toBeUndefined();
    expect(q<HTMLButtonElement>('.export-button')?.disabled).toBe(false);
  });

  it('blocks Close while busy and emits close when idle', async () => {
    const control = makeRender();
    const { wrapper } = mountDialog(control);
    await clickExport();
    expect(q<HTMLButtonElement>('.close-button')?.disabled).toBe(true);
    q('.close-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toBeUndefined();

    control.resolve(makeResult());
    await flushPromises();
    q('.close-button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('emits close from Escape and the overlay when idle', async () => {
    const { wrapper } = mountDialog(makeRender());
    q('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();
    q('.modal-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('close')).toHaveLength(2);
  });

  it('reseeds the filename from the project name when reopened', async () => {
    const { wrapper } = mountDialog(makeRender());
    const filename = q<HTMLInputElement>('.filename-input');
    if (!filename) throw new Error('filename input not found');
    filename.value = 'custom name';
    filename.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect(q<HTMLInputElement>('.filename-input')?.value).toBe('My Song');
  });
});
