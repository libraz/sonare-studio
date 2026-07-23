import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  bindAudioContextState,
  canRestoreTrackInsertAutomationParam,
  resetEngineTransportState,
  restoreEngineTransportState,
} from '@/composables/useEngineLifecycle';

describe('useEngineLifecycle automation restore helpers', () => {
  it('skips track insert parameter restore while a track is frozen', () => {
    expect(canRestoreTrackInsertAutomationParam(undefined)).toBe(true);
    expect(canRestoreTrackInsertAutomationParam({ frozen: undefined })).toBe(true);
    expect(canRestoreTrackInsertAutomationParam({ frozen: { assetId: 'baked-1' } })).toBe(false);
  });

  it('removes AudioContext state listeners on dispose', () => {
    let listener: (() => void) | null = null;
    const ctx = {
      state: 'suspended',
      addEventListener: (_type: 'statechange', next: () => void) => {
        listener = next;
      },
      removeEventListener: (_type: 'statechange', next: () => void) => {
        if (listener === next) listener = null;
      },
    };
    const state = ref('');
    const dispose = bindAudioContextState(ctx, state);

    expect(state.value).toBe('suspended');
    expect(listener).toEqual(expect.any(Function));

    ctx.state = 'running';
    listener?.();
    expect(state.value).toBe('running');

    dispose();
    expect(listener).toBeNull();

    ctx.state = 'closed';
    listener?.();
    expect(state.value).toBe('running');
  });

  it('replays loop and metronome state after an engine rebuild', () => {
    const setLoop = vi.fn();
    const toggleMetronome = vi.fn();
    restoreEngineTransportState({
      loopEnabled: ref(true),
      loopStartPpq: ref(4),
      loopEndPpq: ref(12),
      metronomeEnabled: ref(true),
      setLoop,
      toggleMetronome,
    } as never);

    expect(setLoop).toHaveBeenCalledWith(4, 12, true);
    expect(toggleMetronome).toHaveBeenCalledWith(true);
  });

  it('clears stale playing state while an engine is torn down', () => {
    const isPlaying = ref(true);
    resetEngineTransportState({ isPlaying } as never);
    expect(isPlaying.value).toBe(false);
  });
});
