import { describe, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import { useSampleWarp } from '@/ui/sample-editor/use-sample-warp';

const setClipWarp = vi.hoisted(() => vi.fn());

vi.mock('@/project/commands', () => ({
  setClipWarp: (...args: unknown[]) => setClipWarp(...args),
}));

function audioClip(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    kind: 'audio',
    assetId: 'asset-1',
    lengthPpq: 8,
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    notes: [],
    trackId: 1,
    startPpq: 0,
    ...overrides,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  setClipWarp.mockClear();
  const project = reactive({
    clips: [audioClip()],
    clipId: 7,
    tempoBpm: 120,
    tempoSegments: [],
    ...overrides,
  });
  const errors: string[] = [];
  const scope = effectScope();
  const warp = scope.run(() =>
    useSampleWarp({
      project: project as never,
      assetId: () => 'asset-1',
      setError: (message) => errors.push(message),
    }),
  );
  if (!warp) throw new Error('effect scope did not run');
  return { project, scope, warp, errors };
}

function loadedAsset() {
  return {
    meta: {
      id: 'asset-1',
      name: 'clip.wav',
      sampleRate: 48_000,
      numChannels: 1,
      numFrames: 96_000,
    },
    channels: [new Float32Array(96_000).fill(0.5)],
  };
}

function sourceWindowAsset() {
  return {
    meta: {
      id: 'asset-1',
      name: 'window.wav',
      sampleRate: 1,
      numChannels: 1,
      numFrames: 12,
    },
    channels: [Float32Array.from({ length: 12 }, (_, index) => index)],
  };
}

/** Creates a manually-settled promise for async race tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSampleWarp', () => {
  it('toggles tempo-follow by committing a full warp state', () => {
    const { scope, warp } = setup();

    expect(warp.warpEnabled.value).toBe(false);
    warp.onToggleWarp();

    expect(setClipWarp).toHaveBeenCalledWith(7, {
      enabled: true,
      sourceBpm: 120,
      anchors: [],
    });
    scope.stop();
  });

  it('edits source BPM and keeps existing anchors', () => {
    const { scope, warp } = setup({
      clips: [
        audioClip({
          warp: {
            enabled: true,
            sourceBpm: 100,
            sourceStartSeconds: 2,
            sourceEndSeconds: 8,
            anchors: [{ ppq: 2, sourceSeconds: 1.2 }],
          },
        }),
      ],
    });

    expect(warp.warpBpmInput.value).toBe('100');
    warp.warpBpmInput.value = '96';
    warp.onWarpBpmChange();

    expect(setClipWarp).toHaveBeenCalledWith(7, {
      enabled: true,
      sourceBpm: 96,
      sourceStartSeconds: 2,
      sourceEndSeconds: 8,
      anchors: [{ ppq: 2, sourceSeconds: 1.2 }],
    });
    scope.stop();
  });

  it('preserves trimmed nonlinear source bounds on toggle and anchor edits', () => {
    const { scope, warp } = setup({
      clips: [
        audioClip({
          warp: {
            enabled: true,
            sourceBpm: 90,
            sourceStartSeconds: 3,
            sourceEndSeconds: 9,
            anchors: [
              { ppq: 2, sourceSeconds: 1 },
              { ppq: 6, sourceSeconds: 4 },
            ],
          },
        }),
      ],
    });

    warp.onToggleWarp();
    expect(setClipWarp).toHaveBeenLastCalledWith(7, {
      enabled: false,
      sourceBpm: 90,
      sourceStartSeconds: 3,
      sourceEndSeconds: 9,
      anchors: [
        { ppq: 2, sourceSeconds: 1 },
        { ppq: 6, sourceSeconds: 4 },
      ],
    });

    setClipWarp.mockClear();
    warp.onAnchorEdit(0, 'sourceSeconds', {
      target: { value: '2' },
    } as unknown as Event);
    expect(setClipWarp).toHaveBeenLastCalledWith(7, {
      enabled: true,
      sourceBpm: 90,
      sourceStartSeconds: 3,
      sourceEndSeconds: 9,
      anchors: [
        { ppq: 2, sourceSeconds: 2 },
        { ppq: 6, sourceSeconds: 4 },
      ],
    });
    scope.stop();
  });

  it('does not commit invalid BPM edits and resets the field', () => {
    const { scope, warp } = setup({
      clips: [audioClip({ warp: { enabled: false, sourceBpm: 88 } })],
    });

    warp.warpBpmInput.value = 'nope';
    warp.onWarpBpmChange();

    expect(setClipWarp).not.toHaveBeenCalled();
    expect(warp.warpBpmInput.value).toBe('88');
    scope.stop();
  });

  it('surfaces command errors through the shared editor error callback', () => {
    const { scope, warp, errors } = setup();
    setClipWarp.mockImplementationOnce(() => {
      throw new Error('bad warp');
    });

    warp.onToggleWarp();

    expect(errors).toEqual(['bad warp']);
    scope.stop();
  });

  it('auto-warps the clip from detected beat times', async () => {
    setClipWarp.mockClear();
    const project = reactive({
      clips: [audioClip({ lengthPpq: 8 })],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
    });
    const errors: string[] = [];
    const scope = effectScope();
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: async () => loadedAsset() as never,
          detectBeats: () => [0, 0.5, 1.1, 1.7],
          detectDownbeats: () => [0],
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    await warp.onAutoWarp();

    expect(errors).toEqual([]);
    expect(setClipWarp).toHaveBeenCalledWith(7, {
      enabled: true,
      sourceBpm: expect.closeTo(100, 4),
      anchors: [
        { ppq: 1, sourceSeconds: 0.5 },
        { ppq: 2, sourceSeconds: 1.1 },
        { ppq: 3, sourceSeconds: 1.7 },
      ],
    });
    scope.stop();
  });

  it('auto-warps from the clip source BPM window instead of the project tempo', async () => {
    setClipWarp.mockClear();
    const project = reactive({
      clips: [
        audioClip({
          sourceOffsetPpq: 2,
          lengthPpq: 4,
          warp: {
            enabled: true,
            sourceBpm: 60,
            sourceStartSeconds: 2,
            sourceEndSeconds: 6,
            anchors: [{ ppq: 2, sourceSeconds: 1 }],
          },
        }),
      ],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
    });
    const errors: string[] = [];
    let observedWindow: Float32Array | undefined;
    const scope = effectScope();
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: async () => sourceWindowAsset() as never,
          detectBeats: (samples) => {
            observedWindow = samples;
            return [0, 1, 2, 3];
          },
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    await warp.onAutoWarp();

    expect(errors).toEqual([]);
    expect(observedWindow).toEqual(new Float32Array([2, 3, 4, 5]));
    expect(setClipWarp).toHaveBeenCalledWith(7, {
      enabled: true,
      sourceBpm: 60,
      sourceStartSeconds: 2,
      sourceEndSeconds: 6,
      anchors: [
        { ppq: 1, sourceSeconds: 1 },
        { ppq: 2, sourceSeconds: 2 },
        { ppq: 3, sourceSeconds: 3 },
      ],
    });
    scope.stop();
  });

  it('surfaces auto-warp detector failures', async () => {
    setClipWarp.mockClear();
    const project = reactive({
      clips: [audioClip()],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
    });
    const errors: string[] = [];
    const scope = effectScope();
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: async () => loadedAsset() as never,
          detectBeats: () => [],
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    await warp.onAutoWarp();

    expect(setClipWarp).not.toHaveBeenCalled();
    expect(errors).toEqual(['Auto-Warp could not detect enough beats']);
    scope.stop();
  });

  it('ignores auto-warp results when the clip asset changes while loading', async () => {
    setClipWarp.mockClear();
    const pending = deferred<ReturnType<typeof loadedAsset>>();
    const project = reactive({
      clips: [audioClip()],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
    });
    const errors: string[] = [];
    const scope = effectScope();
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: () => pending.promise as never,
          detectBeats: () => [0, 0.5, 1.1, 1.7],
          detectDownbeats: () => [0],
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    const run = warp.onAutoWarp();
    project.clips = [audioClip({ assetId: 'asset-2' })];
    pending.resolve(loadedAsset());
    await run;

    expect(setClipWarp).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    scope.stop();
  });

  it('ignores auto-warp results after the document generation changes', async () => {
    setClipWarp.mockClear();
    const pending = deferred<ReturnType<typeof loadedAsset>>();
    const project = reactive({
      clips: [audioClip()],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
      documentGeneration: 1,
    });
    const errors: string[] = [];
    const scope = effectScope();
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: () => pending.promise as never,
          detectBeats: () => [0, 0.5, 1.1, 1.7],
          detectDownbeats: () => [0],
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    const run = warp.onAutoWarp();
    project.documentGeneration += 1;
    pending.resolve(loadedAsset());
    await run;

    expect(setClipWarp).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    scope.stop();
  });

  it('ignores late auto-warp failures after scope dispose', async () => {
    setClipWarp.mockClear();
    const pending = deferred<ReturnType<typeof loadedAsset>>();
    const project = reactive({
      clips: [audioClip()],
      clipId: 7,
      tempoBpm: 120,
      tempoSegments: [],
    });
    const errors: string[] = [];
    const scope = effectScope();
    const warp = scope.run(() =>
      useSampleWarp({
        project: project as never,
        assetId: () => 'asset-1',
        setError: (message) => errors.push(message),
        autoWarp: {
          loadAudioAsset: () => pending.promise as never,
          detectBeats: () => [0, 0.5, 1.1, 1.7],
        },
      }),
    );
    if (!warp) throw new Error('effect scope did not run');

    const run = warp.onAutoWarp();
    await Promise.resolve();
    scope.stop();
    pending.reject(new Error('late load failed'));
    await run;

    expect(setClipWarp).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});
