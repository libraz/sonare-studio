import { describe, expect, it } from 'vitest';
import { createPainter } from '@/ui/canvas/painter';

function manualPainter() {
  let pending: FrameRequestCallback | null = null;
  const painter = createPainter({
    requestFrame: (callback) => {
      pending = callback;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
  });
  const flush = (): void => {
    const callback = pending;
    pending = null;
    callback?.(0);
  };
  return { painter, flush };
}

describe('painter flush isolates layers', () => {
  it('draws every other layer when one throws, then rethrows that error', () => {
    const { painter, flush } = manualPainter();
    const drawn: string[] = [];
    const failure = new Error('layer b failed');
    painter.schedule('a', () => drawn.push('a'));
    painter.schedule('b', () => {
      throw failure;
    });
    painter.schedule('c', () => drawn.push('c'));
    expect(flush).toThrow(failure);
    expect(drawn).toEqual(['a', 'c']);
  });

  it('reports every failing layer together', () => {
    const { painter, flush } = manualPainter();
    painter.schedule('a', () => {
      throw new Error('a failed');
    });
    painter.schedule('b', () => {
      throw new Error('b failed');
    });
    let thrown: unknown;
    try {
      flush();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      'a failed',
      'b failed',
    ]);
  });

  it('keeps scheduling after a failed frame', () => {
    const { painter, flush } = manualPainter();
    painter.schedule('a', () => {
      throw new Error('once');
    });
    expect(flush).toThrow('once');
    let drawn = false;
    painter.schedule('a', () => {
      drawn = true;
    });
    flush();
    expect(drawn).toBe(true);
  });
});
