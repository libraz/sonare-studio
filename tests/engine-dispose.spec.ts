import { describe, expect, it, vi } from 'vitest';
import { createEngineResourceDisposer, EngineDisposalError } from '@/engine/engine';

function resources() {
  let contextState = 'running';
  const destroy = vi.fn();
  const disconnect = vi.fn();
  const close = vi.fn(async () => {
    contextState = 'closed';
  });
  const engine = {
    destroy,
    node: { onprocessorerror: vi.fn() as ((event?: Event) => void) | null, disconnect },
  };
  const ctx = {
    get state() {
      return contextState;
    },
    close,
  };
  return { close, destroy, disconnect, engine, ctx };
}

describe('engine resource disposal', () => {
  it('closes the context and detaches the node even when destroy throws, then retries only destroy', async () => {
    const value = resources();
    value.destroy.mockImplementationOnce(() => {
      throw new Error('destroy failed');
    });
    const disposer = createEngineResourceDisposer(value.engine, value.ctx);

    await expect(disposer.dispose()).rejects.toMatchObject({
      name: 'EngineDisposalError',
      failures: [expect.objectContaining({ stage: 'engineDestroyed' })],
    });
    expect(value.disconnect).toHaveBeenCalledTimes(1);
    expect(value.close).toHaveBeenCalledTimes(1);
    expect(disposer.state()).toEqual({
      nodeDetached: true,
      engineDestroyed: false,
      contextClosed: true,
    });

    await expect(disposer.dispose()).resolves.toBeUndefined();
    expect(value.destroy).toHaveBeenCalledTimes(2);
    expect(value.disconnect).toHaveBeenCalledTimes(1);
    expect(value.close).toHaveBeenCalledTimes(1);
    expect(disposer.state().engineDestroyed).toBe(true);
  });

  it('records independent detach and close failures and retries their incomplete stages', async () => {
    const value = resources();
    value.disconnect.mockImplementationOnce(() => {
      throw new Error('disconnect failed');
    });
    value.close.mockRejectedValueOnce(new Error('close failed'));
    const disposer = createEngineResourceDisposer(value.engine, value.ctx);

    await expect(disposer.dispose()).rejects.toBeInstanceOf(EngineDisposalError);
    expect(value.destroy).toHaveBeenCalledTimes(1);
    expect(disposer.state()).toEqual({
      nodeDetached: false,
      engineDestroyed: true,
      contextClosed: false,
    });

    await expect(disposer.dispose()).resolves.toBeUndefined();
    expect(value.disconnect).toHaveBeenCalledTimes(2);
    expect(value.destroy).toHaveBeenCalledTimes(1);
    expect(value.close).toHaveBeenCalledTimes(2);
    expect(disposer.state()).toEqual({
      nodeDetached: true,
      engineDestroyed: true,
      contextClosed: true,
    });
  });
});
