import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createScopeBridge } from '@/engine/scope';
import type { SonareWorkletScopeSnapshot } from '@/wasm/worklet.js';

/** One scope snapshot with overridable fields. */
function makeSnapshot(
  overrides: Partial<SonareWorkletScopeSnapshot> = {},
): SonareWorkletScopeSnapshot {
  return {
    type: 'scope',
    targetId: 0,
    frame: 256,
    bands: new Float32Array([-30, -20, -10]),
    points: new Float32Array([0.5, 0.5, -0.5, 0.5]),
    ...overrides,
  };
}

/** EngineHandle stub capturing the onScope callback and pollScope calls. */
function makeHandle(
  capabilities: { mode?: 'sab' | 'postMessage'; runtimeTarget?: 'embind' | 'sonare-rt' } = {},
): {
  handle: EngineHandle;
  emit: (snapshot: SonareWorkletScopeSnapshot) => void;
  pollScope: ReturnType<typeof vi.fn>;
  onScope: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((snapshot: SonareWorkletScopeSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  const pollScope = vi.fn(() => [] as SonareWorkletScopeSnapshot[]);
  const onScope = vi.fn((cb: (snapshot: SonareWorkletScopeSnapshot) => void) => {
    captured = cb;
    return unsubscribe;
  });
  const engine = { onScope, pollScope };
  const handle = {
    engine,
    ctx: { sampleRate: 48000 },
    capabilities: {
      mode: capabilities.mode ?? 'sab',
      runtimeTarget: capabilities.runtimeTarget ?? 'embind',
    },
  } as unknown as EngineHandle;
  return { handle, emit: (snapshot) => captured?.(snapshot), pollScope, onScope, unsubscribe };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createScopeBridge', () => {
  it('is available only in SAB mode on the embind runtime', () => {
    expect(
      createScopeBridge(makeHandle({ mode: 'sab', runtimeTarget: 'embind' }).handle).available,
    ).toBe(true);
    expect(createScopeBridge(makeHandle({ mode: 'postMessage' }).handle).available).toBe(false);
    expect(
      createScopeBridge(makeHandle({ mode: 'sab', runtimeTarget: 'sonare-rt' }).handle).available,
    ).toBe(false);
  });

  it('does not subscribe to the engine when scope is unavailable', () => {
    const { handle, onScope } = makeHandle({ mode: 'postMessage' });
    const bridge = createScopeBridge(handle);
    expect(onScope).not.toHaveBeenCalled();
    expect(bridge.latest).toBeNull();
    // Subscribing is still safe (just never fires).
    const stop = bridge.subscribe(() => undefined);
    expect(() => stop()).not.toThrow();
  });

  it('exposes the audio sample rate for band-frequency mapping', () => {
    const bridge = createScopeBridge(makeHandle().handle);
    expect(bridge.sampleRate).toBe(48000);
    expect(bridge.forTarget(1).sampleRate).toBe(48000);
  });

  it('routes polled frames by target id; the bridge itself is the master source', () => {
    // Scope is available only in SAB mode, where the poll loop is the sole
    // delivery path (an onScope push would double every frame).
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { handle, pollScope } = makeHandle();
    const bridge = createScopeBridge(handle);
    const lane = bridge.forTarget(1);

    const masterFrames: number[] = [];
    const laneFrames: number[] = [];
    bridge.subscribe((frame) => masterFrames.push(frame.frame));
    lane.subscribe((frame) => laneFrames.push(frame.frame));

    pollScope.mockReturnValueOnce([
      makeSnapshot({ targetId: 0, frame: 10 }),
      makeSnapshot({ targetId: 1, frame: 20 }),
    ]);
    frames.at(-1)?.(performance.now());

    expect(masterFrames).toEqual([10]);
    expect(laneFrames).toEqual([20]);
    expect(bridge.latest?.frame).toBe(10);
    expect(lane.latest?.frame).toBe(20);
    expect([...(bridge.latest?.bands ?? [])]).toEqual([-30, -20, -10]);
  });

  it('does not double-publish when an onScope push also fires in SAB mode', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { handle, emit, pollScope } = makeHandle();
    const bridge = createScopeBridge(handle);
    const seen: number[] = [];
    bridge.subscribe((frame) => seen.push(frame.frame));

    // A push must not publish; only the poll drain does.
    emit(makeSnapshot({ targetId: 0, frame: 64 }));
    expect(seen).toEqual([]);
    pollScope.mockReturnValueOnce([makeSnapshot({ targetId: 0, frame: 64 })]);
    frames.at(-1)?.(performance.now());
    expect(seen).toEqual([64]);
  });

  it('drains pollScope on the animation frame loop in SAB mode', () => {
    let frameCb: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameCb = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { handle, pollScope } = makeHandle({ mode: 'sab' });
    pollScope.mockReturnValueOnce([makeSnapshot({ targetId: 0, frame: 99 })]);
    const bridge = createScopeBridge(handle);

    expect(frameCb).not.toBeNull();
    frameCb?.(0);
    expect(pollScope).toHaveBeenCalled();
    expect(bridge.latest?.frame).toBe(99);
  });

  it('stops the poll loop and delivers nothing after dispose', () => {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { handle, pollScope } = makeHandle();
    const bridge = createScopeBridge(handle);
    const seen: number[] = [];
    bridge.subscribe((frame) => seen.push(frame.frame));

    bridge.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
    // A frame that still fires after dispose must not drain or deliver.
    pollScope.mockReturnValueOnce([makeSnapshot({ frame: 42 })]);
    frames.at(-1)?.(performance.now());
    expect(pollScope).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
