import { describe, expect, it, type Mock, vi } from 'vitest';
import type { ExportRenderOptions } from '@/export/client';
import {
  MixdownCancelledError,
  type MixdownProgressFn,
  type MixdownResult,
} from '@/export/mixdown';
import type { ProjectDocument } from '@/project/serialization';
import {
  createMasteringPreviewController,
  type MasteringPreviewState,
  previewCacheKey,
  stripMasteringChain,
} from '@/ui/mastering/preview';

function makeDoc(withChain = true): ProjectDocument {
  const doc: ProjectDocument = {
    schemaVersion: 3,
    name: 'Preview test',
    sampleRate: 48000,
    tempoSegments: [{ startPpq: 0, bpm: 120 }],
    timeSignatures: [],
    tracks: [],
    markers: [],
    sections: [],
  };
  if (withChain) {
    doc.mixer = {
      master: { gainDb: 0, pan: 0, inserts: [], sends: [] },
      buses: [],
      masteringChain: {
        preset: 'pop',
        processors: [{ processor: 'eq.tilt', params: { tiltDb: 1 }, enabled: true }],
      },
    };
  }
  return doc;
}

function makeResult(value: number): MixdownResult {
  return {
    channels: [new Float32Array([value]), new Float32Array([value])],
    sampleRate: 48000,
    totalFrames: 1,
    report: { peakDb: -6, truePeakDbtp: -5.5, lufs: -14 },
  };
}

interface FakeRenderCall {
  doc: ProjectDocument;
  options: ExportRenderOptions;
  onProgress?: MixdownProgressFn;
  cancel: Mock<() => void>;
  resolve: (result: MixdownResult) => void;
  reject: (error: Error) => void;
}

/** Render-function double exposing each call's settle hooks. */
function makeFakeRender() {
  const calls: FakeRenderCall[] = [];
  const render = (
    doc: ProjectDocument,
    options: ExportRenderOptions,
    onProgress?: MixdownProgressFn,
  ) => {
    let resolve!: (result: MixdownResult) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<MixdownResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: FakeRenderCall = { doc, options, cancel: vi.fn<() => void>(), resolve, reject };
    if (onProgress) call.onProgress = onProgress;
    calls.push(call);
    return { result, cancel: call.cancel };
  };
  return { calls, render };
}

/** Lets queued promise continuations run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const range = { startPpq: 0, endPpq: 32 };

describe('previewCacheKey / stripMasteringChain', () => {
  it('keys on document content, range and sample rate', () => {
    const key = previewCacheKey(makeDoc(), range);
    expect(previewCacheKey(makeDoc(), range)).toBe(key);
    expect(previewCacheKey(makeDoc(), { startPpq: 0, endPpq: 16 })).not.toBe(key);
    expect(previewCacheKey(makeDoc(), range, 44100)).not.toBe(key);
    expect(previewCacheKey(makeDoc(false), range)).not.toBe(key);
  });

  it('strips the mastering chain without mutating the source document', () => {
    const doc = makeDoc();
    const stripped = stripMasteringChain(doc);
    expect(stripped.mixer?.masteringChain).toBeUndefined();
    expect(doc.mixer?.masteringChain?.preset).toBe('pop');
    expect(stripped.mixer?.master).toEqual(doc.mixer?.master);
  });

  it('returns chainless documents unchanged', () => {
    const doc = makeDoc(false);
    expect(stripMasteringChain(doc)).toBe(doc);
  });
});

describe('createMasteringPreviewController', () => {
  it('renders processed then bypassed variants and lands in ready', async () => {
    const fake = makeFakeRender();
    const states: MasteringPreviewState[] = [];
    const controller = createMasteringPreviewController({
      render: fake.render,
      onChange: (state) => states.push(state),
    });
    expect(controller.state().status).toBe('idle');

    const doc = makeDoc();
    const requestPromise = controller.request(doc, range);
    expect(controller.state().status).toBe('rendering');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].doc.mixer?.masteringChain).toBeDefined();
    expect(fake.calls[0].options).toEqual({ range });

    // First-variant progress maps onto the 0..0.5 window.
    fake.calls[0].onProgress?.(0.5, 'eq.tilt');
    expect(controller.state().progress).toBeCloseTo(0.25);
    expect(controller.state().stage).toBe('eq.tilt');

    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].doc.mixer?.masteringChain).toBeUndefined();

    fake.calls[1].onProgress?.(0.5, 'clip:0:0');
    expect(controller.state().progress).toBeCloseTo(0.75);

    fake.calls[1].resolve(makeResult(0.25));
    await expect(requestPromise).resolves.toBe(true);
    const state = controller.state();
    expect(state.status).toBe('ready');
    expect(state.progress).toBe(1);
    expect(state.processed?.channels[0][0]).toBeCloseTo(0.5);
    expect(state.bypassed?.channels[0][0]).toBeCloseTo(0.25);
    expect(state.key).toBe(previewCacheKey(doc, range));
    expect(states.some((entry) => entry.status === 'rendering')).toBe(true);
  });

  it('renders from a detached document/range snapshot', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const doc = makeDoc();
    const mutableRange = { startPpq: 0, endPpq: 32 };
    void controller.request(doc, mutableRange);

    doc.name = 'Mutated after request';
    doc.mixer?.masteringChain?.processors.push({
      processor: 'limiter.peak',
      params: {},
      enabled: true,
    });
    mutableRange.endPpq = 4;

    expect(fake.calls[0].doc).not.toBe(doc);
    expect(fake.calls[0].doc.name).toBe('Preview test');
    expect(fake.calls[0].doc.mixer?.masteringChain?.processors).toHaveLength(1);
    expect(fake.calls[0].options.range).toEqual({ startPpq: 0, endPpq: 32 });
  });

  it('renders only once when the document has no mastering chain', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const requestPromise = controller.request(makeDoc(false), range);
    expect(fake.calls).toHaveLength(1);
    fake.calls[0].resolve(makeResult(0.5));
    await expect(requestPromise).resolves.toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(controller.state().bypassed).toBe(controller.state().processed);
  });

  it('serves repeated requests for the same content from the cache', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const first = controller.request(makeDoc(), range);
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await expect(first).resolves.toBe(true);

    await expect(controller.request(makeDoc(), range)).resolves.toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it('discards results of a superseded render (generation guard)', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const first = controller.request(makeDoc(), range);
    const second = controller.request(makeDoc(), { startPpq: 0, endPpq: 16 });
    // Superseding cancels the first render's handle.
    expect(fake.calls[0].cancel).toHaveBeenCalled();
    expect(fake.calls).toHaveLength(2);

    // A late first-render result must not leak into the state.
    fake.calls[0].resolve(makeResult(0.9));
    await expect(first).resolves.toBe(false);
    expect(controller.state().status).toBe('rendering');

    fake.calls[1].resolve(makeResult(0.5));
    await flush();
    fake.calls[2].resolve(makeResult(0.25));
    await expect(second).resolves.toBe(true);
    expect(controller.state().processed?.channels[0][0]).toBeCloseTo(0.5);
  });

  it('returns to idle on cancel before any preview exists', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const requestPromise = controller.request(makeDoc(), range);
    controller.cancel();
    expect(fake.calls[0].cancel).toHaveBeenCalled();
    expect(controller.state().status).toBe('idle');

    fake.calls[0].reject(new MixdownCancelledError());
    await expect(requestPromise).resolves.toBe(false);
    expect(controller.state().status).toBe('idle');
  });

  it('keeps the last ready results when a newer render is cancelled', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const first = controller.request(makeDoc(), range);
    fake.calls[0].resolve(makeResult(0.5));
    await flush();
    fake.calls[1].resolve(makeResult(0.25));
    await expect(first).resolves.toBe(true);

    const second = controller.request(makeDoc(), { startPpq: 0, endPpq: 16 });
    controller.cancel();
    fake.calls[2].reject(new MixdownCancelledError());
    await expect(second).resolves.toBe(false);
    const state = controller.state();
    expect(state.status).toBe('ready');
    expect(state.processed?.channels[0][0]).toBeCloseTo(0.5);
  });

  it('reports render failures as an error state', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const requestPromise = controller.request(makeDoc(), range);
    fake.calls[0].reject(new Error('asset missing'));
    await expect(requestPromise).resolves.toBe(false);
    const state = controller.state();
    expect(state.status).toBe('error');
    expect(state.error).toBe('asset missing');
  });

  it('treats an in-flight cancellation rejection as a cancel, not an error', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    const requestPromise = controller.request(makeDoc(), range);
    fake.calls[0].reject(new MixdownCancelledError());
    await expect(requestPromise).resolves.toBe(false);
    expect(controller.state().status).toBe('idle');
    expect(controller.state().error).toBeNull();
  });

  it('passes the sample-rate override to the render options', async () => {
    const fake = makeFakeRender();
    const controller = createMasteringPreviewController({ render: fake.render });
    void controller.request(makeDoc(false), range, 44100);
    expect(fake.calls[0].options).toEqual({ range, sampleRate: 44100 });
  });

  it('rejects requests after dispose and stops change notifications', async () => {
    const fake = makeFakeRender();
    const onChange = vi.fn();
    const controller = createMasteringPreviewController({ render: fake.render, onChange });
    controller.dispose();
    onChange.mockClear();
    await expect(controller.request(makeDoc(), range)).resolves.toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});
