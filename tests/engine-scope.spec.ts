import type { WorkletScopeSnapshot } from '@libraz/libsonare/worklet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@/engine/engine';
import { createScopeBridge } from '@/engine/scope';
import { fakeEngineHandle } from './fakes/engine';

/** One scope snapshot with overridable fields. */
function makeSnapshot(overrides: Partial<WorkletScopeSnapshot> = {}): WorkletScopeSnapshot {
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
  capabilities: { mode?: 'sab' | 'postMessage'; runtimeTarget?: 'embind' } = {},
): {
  handle: EngineHandle;
  emit: (snapshot: WorkletScopeSnapshot) => void;
  pollScope: ReturnType<typeof vi.fn>;
  onScope: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let captured: ((snapshot: WorkletScopeSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  const pollScope = vi.fn(() => [] as WorkletScopeSnapshot[]);
  const onScope = vi.fn((cb: (snapshot: WorkletScopeSnapshot) => void) => {
    captured = cb;
    return unsubscribe;
  });
  const engine = { onScope, pollScope };
  const handle = fakeEngineHandle({
    engine,
    ctx: { sampleRate: 48000 },
    capabilities: {
      mode: capabilities.mode ?? 'sab',
      runtimeTarget: capabilities.runtimeTarget ?? 'embind',
    },
  });
  return { handle, emit: (snapshot) => captured?.(snapshot), pollScope, onScope, unsubscribe };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createScopeBridge', () => {
  it('is available only in SAB mode', () => {
    const sabBridge = createScopeBridge(
      makeHandle({ mode: 'sab', runtimeTarget: 'embind' }).handle,
    );
    const postMessageBridge = createScopeBridge(makeHandle({ mode: 'postMessage' }).handle);

    expect(sabBridge.available).toBe(true);
    expect(postMessageBridge.available).toBe(false);

    sabBridge.dispose();
    postMessageBridge.dispose();
  });

  it('does not subscribe to the engine when scope is unavailable', () => {
    const request = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { handle, onScope, pollScope } = makeHandle({ mode: 'postMessage' });
    const bridge = createScopeBridge(handle);
    expect(onScope).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(bridge.latest).toBeNull();
    // Subscribing is still safe (just never fires).
    const stop = bridge.subscribe(() => undefined);
    expect(() => stop()).not.toThrow();
    bridge.dispose();
    expect(cancel).not.toHaveBeenCalled();
    expect(pollScope).not.toHaveBeenCalled();
  });

  it('exposes the audio sample rate for band-frequency mapping', () => {
    const bridge = createScopeBridge(makeHandle().handle);
    expect(bridge.sampleRate).toBe(48000);
    expect(bridge.forTarget(1).sampleRate).toBe(48000);
    bridge.dispose();
  });

  it('routes pushed frames by target id; the bridge itself is the master source', () => {
    const { handle, emit, onScope, pollScope } = makeHandle();
    const bridge = createScopeBridge(handle);
    const lane = bridge.forTarget(1);
    expect(onScope).toHaveBeenCalledTimes(1);

    const masterFrames: number[] = [];
    const laneFrames: number[] = [];
    bridge.subscribe((frame) => masterFrames.push(frame.frame));
    lane.subscribe((frame) => laneFrames.push(frame.frame));

    emit(makeSnapshot({ targetId: 0, frame: 10 }));
    emit(makeSnapshot({ targetId: 1, frame: 20 }));

    expect(masterFrames).toEqual([10]);
    expect(laneFrames).toEqual([20]);
    expect(bridge.latest?.frame).toBe(10);
    expect(lane.latest?.frame).toBe(20);
    expect([...(bridge.latest?.bands ?? [])]).toEqual([-30, -20, -10]);
    // The facade's own ring poller owns the read index, so the bridge never drains it.
    expect(pollScope).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('unsubscribes from the engine and delivers nothing after dispose', () => {
    const { handle, emit, unsubscribe } = makeHandle();
    const bridge = createScopeBridge(handle);
    const seen: number[] = [];
    bridge.subscribe((frame) => seen.push(frame.frame));

    bridge.dispose();
    bridge.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    emit(makeSnapshot({ frame: 42 }));
    expect(seen).toEqual([]);
  });
});
