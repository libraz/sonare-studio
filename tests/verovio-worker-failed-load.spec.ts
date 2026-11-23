import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerovioRequest, VerovioResponse } from '@/workers/verovio.worker';

const workerMocks = vi.hoisted(() => ({
  createModule: vi.fn(),
  VerovioToolkit: vi.fn(),
}));

vi.mock('verovio/wasm', () => ({ default: workerMocks.createModule }));
vi.mock('verovio/esm', () => ({ VerovioToolkit: workerMocks.VerovioToolkit }));

describe('Verovio worker after a failed load', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('refuses to render the previous score when setting the new options throws', async () => {
    let rejectOptions = false;
    const toolkit = {
      setOptions() {
        if (rejectOptions) throw new Error('bad option');
      },
      loadData: () => 1,
      getPageCount: () => 1,
      renderToSVG: () => '<svg>previous</svg>',
      getLog: () => '',
    };
    workerMocks.createModule.mockResolvedValue({});
    workerMocks.VerovioToolkit.mockImplementation(
      class {
        constructor() {
          Object.assign(this, toolkit);
        }
      },
    );
    const scope = {
      onmessage: null as ((event: MessageEvent<VerovioRequest>) => void) | null,
      postMessage: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal('self', scope);
    await import('@/workers/verovio.worker');
    const send = async (data: VerovioRequest): Promise<VerovioResponse> => {
      scope.postMessage.mockClear();
      scope.onmessage?.({ data } as MessageEvent<VerovioRequest>);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return scope.postMessage.mock.calls[0][0] as VerovioResponse;
    };

    expect(await send({ id: 1, sessionId: 1, type: 'load', musicXml: '<a/>' })).toMatchObject({
      type: 'load',
    });
    rejectOptions = true;
    expect((await send({ id: 2, sessionId: 1, type: 'load', musicXml: '<b/>' })).type).toBe(
      'error',
    );
    const render = await send({ id: 3, sessionId: 1, type: 'renderPage', page: 1 });
    expect(render.type).toBe('error');
  });
});
