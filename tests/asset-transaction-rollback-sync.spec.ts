import { afterEach, describe, expect, it, vi } from 'vitest';
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
        for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>);
      });
    }
  }

  close(): void {
    FakeBroadcastChannel.instances.delete(this);
  }
}

const CHANNEL = 'sonare-studio:audio-asset-leases:v1';

async function loadModules() {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.resetModules();
  installMockOpfs();
  return {
    transaction: await import('@/persistence/asset-transaction'),
    assets: await import('@/persistence/assets'),
  };
}

describe('audio asset transaction rollback lease synchronization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances.clear();
    vi.resetModules();
    uninstallMockOpfs();
  });

  it('synchronizes peer leases once and announces one intent for the whole rollback', async () => {
    const { transaction, assets } = await loadModules();
    const tx = transaction.createAudioAssetTransaction();
    for (const value of [1, 2, 3]) {
      await tx.save({ name: `Take ${value}`, sampleRate: 48000 }, [new Float32Array([value])]);
    }
    const remote = new FakeBroadcastChannel(CHANNEL);
    const seen: Array<{ type?: string; assetIds?: string[] }> = [];
    remote.addEventListener('message', (event) =>
      seen.push(event.data as { type?: string; assetIds?: string[] }),
    );

    await tx.rollback();
    await Promise.resolve();

    expect(seen.filter((message) => message.type === 'hello')).toHaveLength(1);
    const intents = seen.filter((message) => message.type === 'delete-intent');
    expect(intents).toHaveLength(1);
    expect(intents[0].assetIds).toHaveLength(3);
    expect(await assets.listAssets()).toEqual([]);
    remote.close();
  });

  it('keeps an asset that a peer reports as leased and removes the rest', async () => {
    const { transaction, assets } = await loadModules();
    const tx = transaction.createAudioAssetTransaction();
    const kept = await tx.save({ name: 'Kept', sampleRate: 48000 }, [new Float32Array([1])]);
    await tx.save({ name: 'Dropped', sampleRate: 48000 }, [new Float32Array([2])]);
    const remote = new FakeBroadcastChannel(CHANNEL);
    remote.addEventListener('message', (event) => {
      if ((event.data as { type?: string }).type !== 'hello') return;
      remote.postMessage({ type: 'leases', sessionId: 'peer', assetIds: [kept.id], fontIds: [] });
    });

    await tx.rollback();

    expect((await assets.listAssets()).map((meta) => meta.id)).toEqual([kept.id]);
    remote.close();
  });

  it('skips assets the caller still references', async () => {
    const { transaction, assets } = await loadModules();
    const tx = transaction.createAudioAssetTransaction();
    const referenced = await tx.save({ name: 'Ref', sampleRate: 48000 }, [new Float32Array([1])]);
    await tx.save({ name: 'Free', sampleRate: 48000 }, [new Float32Array([2])]);

    await tx.rollback((id) => id === referenced.id);

    expect((await assets.listAssets()).map((meta) => meta.id)).toEqual([referenced.id]);
  });
});
