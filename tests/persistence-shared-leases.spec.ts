import { afterEach, describe, expect, it, vi } from 'vitest';

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
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances.clear();
    vi.resetModules();
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
});
