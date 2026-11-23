import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeBroadcastChannel {
  static readonly instances = new Set<FakeBroadcastChannel>();
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly sent: unknown[] = [];

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.add(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  postMessage(data: unknown): void {
    this.sent.push(data);
    for (const channel of FakeBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      queueMicrotask(() => {
        for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>);
      });
    }
  }

  close(): void {
    FakeBroadcastChannel.instances.delete(this);
  }
}

const CHANNEL = 'sonare-studio:audio-asset-leases:v1';

function flushMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadLeases() {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.resetModules();
  return import('@/persistence/asset-leases');
}

describe('asset leases across peer lifecycles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances.clear();
    vi.resetModules();
  });

  it('lets an asset be leased again once the peer deleting it closes', async () => {
    const leases = await loadLeases();
    const remote = new FakeBroadcastChannel(CHANNEL);
    remote.postMessage({
      type: 'delete-intent',
      sessionId: 'other-tab',
      assetIds: ['shared-asset'],
      fontIds: [],
    });
    await flushMessages();
    expect(() => leases.leaseAudioAssets(['shared-asset'])).toThrow(
      leases.AssetDeletionInProgressError,
    );
    remote.postMessage({ type: 'closed', sessionId: 'other-tab' });
    await flushMessages();
    leases.leaseAudioAssets(['shared-asset']).release();
  });

  it('re-advertises held leases when restored from the back/forward cache', async () => {
    const leases = await loadLeases();
    const lease = leases.leaseAudioAssets(['held-asset']);
    const local = [...FakeBroadcastChannel.instances][0];
    local.sent.length = 0;
    window.dispatchEvent(new Event('pagehide'));
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(local.sent).toContainEqual(expect.objectContaining({ type: 'closed' }));
    expect(local.sent.at(-1)).toMatchObject({ type: 'leases', assetIds: ['held-asset'] });
    lease.release();
  });
});
