import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/wasm', () => ({
  ensureWasm: vi.fn(async () => ({
    decomposeStemsLinked: () => {
      throw new Error('wasm failure');
    },
  })),
}));

type Listener = (event: { data: unknown }) => void;

/** Loads a worker module against a fake worker scope and returns a request driver. */
async function loadWorker(path: string) {
  const posted: unknown[] = [];
  let listener: Listener | null = null;
  const scope = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listener = fn;
    },
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('postMessage', scope.postMessage);
  vi.resetModules();
  await import(/* @vite-ignore */ path);
  if (!listener) throw new Error('worker did not register a message listener');
  const send = async (data: unknown): Promise<void> => {
    (listener as Listener)({ data });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
  };
  return { posted, send };
}

describe('one-shot worker request validation', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('sample-ops replies with a typed error for an unknown operation', async () => {
    const { posted, send } = await loadWorker('@/workers/sample-ops.worker');
    await send({
      type: 'bogus',
      channels: [new Float32Array(4)],
      range: { startFrame: 0, endFrame: 4 },
    });
    expect(posted[0]).toEqual({
      type: 'error',
      error: 'Sample operation worker received an invalid request',
    });
  });

  it('sample-ops replies with a typed error for a null request', async () => {
    const { posted, send } = await loadWorker('@/workers/sample-ops.worker');
    await send(null);
    expect(posted[0]).toMatchObject({ type: 'error' });
  });

  it('decompose-stems replies with a typed error for a null request', async () => {
    const { posted, send } = await loadWorker('@/workers/decompose-stems.worker');
    await send(null);
    expect(posted[0]).toEqual({
      type: 'error',
      error: 'Component split worker received an invalid request',
    });
  });

  it('decompose-stems still reports a failure raised while working', async () => {
    const { posted, send } = await loadWorker('@/workers/decompose-stems.worker');
    await send({ channels: [new Float32Array(4)], sampleRate: 44100, nComponents: 2 });
    expect(posted[0]).toEqual({ type: 'error', error: 'wasm failure' });
  });

  it('audio-encode replies with a typed error for a mismatched request type', async () => {
    const { posted, send } = await loadWorker('@/workers/audio-encode.worker');
    await send({ type: 'other' });
    expect(posted[0]).toEqual({
      type: 'error',
      error: 'Audio encode worker received an invalid request',
    });
  });

  it('audio-encode replies with a typed error for an unsupported encoder', async () => {
    const { posted, send } = await loadWorker('@/workers/audio-encode.worker');
    await send({
      type: 'encode',
      encoderId: 'ogg',
      channels: [new Float32Array(4)],
      sampleRate: 44100,
      options: {},
    });
    expect(posted[0]).toMatchObject({ type: 'error' });
  });

  it('musicxml-import replies with a typed error for a mismatched request type', async () => {
    const { posted, send } = await loadWorker('@/workers/musicxml-import.worker');
    await send({ type: 'other' });
    expect(posted[0]).toEqual({
      type: 'error',
      error: { message: 'MusicXML import worker received an invalid request', kind: 'unknown' },
    });
  });

  it('musicxml-import replies with a typed error for a null request', async () => {
    const { posted, send } = await loadWorker('@/workers/musicxml-import.worker');
    await send(null);
    expect(posted[0]).toMatchObject({ type: 'error' });
  });

  it('audio-analysis and transcribe keep their typed invalid-request reply', async () => {
    const analysis = await loadWorker('@/workers/audio-analysis.worker');
    await analysis.send({ kind: 'nope' });
    expect(analysis.posted[0]).toEqual({
      type: 'error',
      error: 'Audio analysis worker received an invalid request',
    });
    const transcribe = await loadWorker('@/workers/transcribe.worker');
    await transcribe.send({});
    expect(transcribe.posted[0]).toEqual({
      type: 'error',
      error: 'Transcription worker received an invalid request',
    });
  });
});
