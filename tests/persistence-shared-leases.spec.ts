import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAudioAssetCache, loadAsset, saveAsset } from '@/persistence/assets';
import { installMockOpfs, uninstallMockOpfs } from './opfs-mock';

class FakeBroadcastChannel {
  static readonly instances = new Set<FakeBroadcastChannel>();
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.add(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of FakeBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => {
        for (const listener of channel.listeners) {
          listener({ data } as MessageEvent<unknown>);
        }
      });
    }
  }

  close(): void {
    FakeBroadcastChannel.instances.delete(this);
  }
}

describe('cross-tab audio asset leases', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances.clear();
    vi.resetModules();
    clearAudioAssetCache();
    uninstallMockOpfs();
  });

  it('re-queries another session immediately before destructive work', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.resetModules();
    const leases = await import('@/persistence/asset-leases');
    const remote = new FakeBroadcastChannel('sonare-studio:audio-asset-leases:v1');
    remote.addEventListener('message', (event) => {
      const message = event.data as { type?: string };
      if (message.type === 'hello') {
        remote.postMessage({
          type: 'leases',
          sessionId: 'other-tab',
          assetIds: ['remote-only-asset'],
        });
      }
    });

    await expect(leases.synchronizeAudioAssetLeases()).resolves.toContain('remote-only-asset');
    expect(leases.isAudioAssetLeased('remote-only-asset')).toBe(true);

    remote.postMessage({ type: 'closed', sessionId: 'other-tab' });
    await vi.waitFor(() => expect(leases.isAudioAssetLeased('remote-only-asset')).toBe(false));
    remote.close();
  });

  it('carries another session’s SoundFont leases across the same channel', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.resetModules();
    const leases = await import('@/persistence/asset-leases');
    const remote = new FakeBroadcastChannel('sonare-studio:audio-asset-leases:v1');
    remote.addEventListener('message', (event) => {
      const message = event.data as { type?: string };
      if (message.type === 'hello') {
        remote.postMessage({
          type: 'leases',
          sessionId: 'other-tab',
          assetIds: [],
          fontIds: ['remote-only-font'],
        });
      }
    });

    await leases.synchronizeMediaLeases();
    expect(leases.isFontLeased('remote-only-font')).toBe(true);
    expect([...leases.leasedFontIds()]).toContain('remote-only-font');

    remote.postMessage({ type: 'closed', sessionId: 'other-tab' });
    await vi.waitFor(() => expect(leases.isFontLeased('remote-only-font')).toBe(false));
    remote.close();
  });

  it('retains a known peer lease when that peer misses a later sync reply', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.resetModules();
    const leases = await import('@/persistence/asset-leases');
    const remote = new FakeBroadcastChannel('sonare-studio:audio-asset-leases:v1');

    remote.postMessage({
      type: 'leases',
      sessionId: 'paused-tab',
      assetIds: ['asset-being-imported'],
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(leases.isAudioAssetLeased('asset-being-imported')).toBe(true);

    // The peer receives hello but does not reply, as a backgrounded tab can.
    await leases.synchronizeMediaLeases();
    expect(leases.isAudioAssetLeased('asset-being-imported')).toBe(true);
    remote.close();
  });

  it('expires a crashed peer lease after its heartbeat deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.resetModules();
    const leases = await import('@/persistence/asset-leases');
    const remote = new FakeBroadcastChannel('sonare-studio:audio-asset-leases:v1');

    remote.postMessage({
      type: 'leases',
      sessionId: 'crashed-tab',
      assetIds: ['eventually-reclaimable'],
    });
    await vi.runAllTicks();
    expect(leases.isAudioAssetLeased('eventually-reclaimable')).toBe(true);

    // The production TTL is deliberately several heartbeat intervals so a
    // backgrounded but live tab stays protected; a dead tab cannot pin GC.
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(leases.isAudioAssetLeased('eventually-reclaimable')).toBe(false);

    // A tab that resumes after a long suspension advertises again and regains
    // protection; expiry must not permanently blacklist its session id.
    remote.postMessage({
      type: 'leases',
      sessionId: 'crashed-tab',
      assetIds: ['eventually-reclaimable'],
    });
    await vi.runAllTicks();
    expect(leases.isAudioAssetLeased('eventually-reclaimable')).toBe(true);
    remote.close();
  });

  it('rejects a lease acquired after another tab announces delete intent', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.resetModules();
    const leases = await import('@/persistence/asset-leases');
    const remote = new FakeBroadcastChannel('sonare-studio:audio-asset-leases:v1');

    remote.postMessage({
      type: 'delete-intent',
      sessionId: 'deleting-tab',
      assetIds: ['about-to-be-deleted'],
      fontIds: [],
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(() => leases.leaseAudioAssets(['about-to-be-deleted'])).toThrow('being deleted');

    remote.postMessage({
      type: 'delete-complete',
      sessionId: 'deleting-tab',
      assetIds: ['about-to-be-deleted'],
      fontIds: [],
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lease = leases.leaseAudioAssets(['about-to-be-deleted']);
    lease.release();
    remote.close();
  });

  it('does not delete an asset when a newly observed tab replies late to delete synchronization', async () => {
    installMockOpfs();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.resetModules();
    const leases = await import('@/persistence/asset-leases');
    await saveAsset({ id: 'late-joiner', name: 'Late joiner', sampleRate: 48000 }, [
      new Float32Array(1),
    ]);
    const remote = new FakeBroadcastChannel('sonare-studio:audio-asset-leases:v1');
    remote.addEventListener('message', (event) => {
      const message = event.data as { type?: string };
      if (message.type !== 'hello' && message.type !== 'delete-intent') return;
      // This peer had not advertised before deletion began. Its delayed reply
      // must still arrive inside the unknown-peer grace period and protect the
      // asset during the final in-lock recheck.
      setTimeout(() => {
        remote.postMessage({
          type: 'leases',
          sessionId: 'late-tab',
          assetIds: ['late-joiner'],
          fontIds: [],
        });
      }, 25);
    });

    await expect(leases.deleteAudioAssetGuarded('late-joiner', () => false)).resolves.toBe(false);
    await expect(loadAsset('late-joiner')).resolves.toBeDefined();
    remote.close();
  });
});
