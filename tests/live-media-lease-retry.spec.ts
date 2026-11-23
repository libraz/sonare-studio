import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useLiveMediaLeases } from '@/composables/useLiveMediaLeases';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

const leases = vi.hoisted(() => ({
  assetFailures: 0,
  assetHeld: new Set<string>(),
  fontHeld: new Set<string>(),
}));

vi.mock('@/persistence/asset-leases', () => ({
  leaseAudioAssets: () => ({
    update: (ids: Iterable<string>) => {
      if (leases.assetFailures > 0) {
        leases.assetFailures -= 1;
        throw new Error('asset is being deleted by another tab');
      }
      leases.assetHeld = new Set(ids);
    },
    release: vi.fn(),
  }),
  leaseFonts: () => ({
    update: (ids: Iterable<string>) => {
      leases.fontHeld = new Set(ids);
    },
    release: vi.fn(),
  }),
}));

function sf2Track(fontId: string): EditorTrack {
  return {
    id: 1,
    name: 'Track 1',
    color: '#60a5fa',
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    order: 1,
    instrument: { kind: 'sf2', fontId },
  };
}

describe('useLiveMediaLeases', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    leases.assetFailures = 0;
    leases.fontHeld = new Set();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failed live lease update without waiting for the next document change', async () => {
    vi.useFakeTimers();
    const store = useProjectStore();
    store.dispose();
    await store.init();
    const errorMessage = ref('');
    const scope = effectScope();
    scope.run(() => useLiveMediaLeases({ errorMessage }));

    leases.assetFailures = 1;
    store.tracks = [sf2Track('font-a')];
    await nextTick();
    expect(errorMessage.value).toContain('being deleted');
    expect(leases.fontHeld.has('font-a')).toBe(false);

    await vi.advanceTimersByTimeAsync(1_100);
    expect(leases.fontHeld.has('font-a')).toBe(true);
    scope.stop();
  });
});
