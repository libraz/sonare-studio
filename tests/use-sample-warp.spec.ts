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
          warp: { enabled: true, sourceBpm: 100, anchors: [{ ppq: 2, sourceSeconds: 1.2 }] },
        }),
      ],
    });

    expect(warp.warpBpmInput.value).toBe('100');
    warp.warpBpmInput.value = '96';
    warp.onWarpBpmChange();

    expect(setClipWarp).toHaveBeenCalledWith(7, {
      enabled: true,
      sourceBpm: 96,
      anchors: [{ ppq: 2, sourceSeconds: 1.2 }],
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
});
