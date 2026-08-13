import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerovioRequest, VerovioResponse } from '@/workers/verovio.worker';

const workerMocks = vi.hoisted(() => ({
  createModule: vi.fn(),
  VerovioToolkit: vi.fn(),
}));

vi.mock('verovio/wasm', () => ({ default: workerMocks.createModule }));
vi.mock('verovio/esm', () => ({ VerovioToolkit: workerMocks.VerovioToolkit }));

interface WorkerScopeDouble {
  onmessage: ((event: MessageEvent<VerovioRequest>) => void) | null;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function createScope(): WorkerScopeDouble {
  return {
    onmessage: null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
}

describe('Verovio worker bootstrap protocol', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    workerMocks.createModule.mockReset();
    workerMocks.VerovioToolkit.mockReset();
  });

  it('reports toolkit initialization rejection as a typed fatal response', async () => {
    const scope = createScope();
    const cause = new Error('wasm bootstrap rejected');
    let rejectModule: (reason: unknown) => void = () => {};
    const modulePromise = new Promise<never>((_resolve, reject) => {
      rejectModule = reject;
    });
    workerMocks.createModule.mockReturnValue(modulePromise);
    vi.stubGlobal('self', scope);

    await import('@/workers/verovio.worker');
    rejectModule(cause);
    scope.onmessage?.({
      data: { id: 7, sessionId: 1, type: 'load', musicXml: '<score-partwise/>' },
    } as MessageEvent<VerovioRequest>);

    // The request queue and toolkit promise each settle on their own turn.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const [response] = scope.postMessage.mock.calls.map(([message]) => message as VerovioResponse);
    expect(response).toEqual({
      id: 7,
      type: 'fatal',
      error: 'Verovio toolkit initialization failed: wasm bootstrap rejected',
    });
  });
});
