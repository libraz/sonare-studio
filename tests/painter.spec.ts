import { describe, expect, it, vi } from 'vitest';
import { createPainter } from '@/ui/canvas/painter';

/** Manually steppable requestAnimationFrame double. */
function makeFrameMock() {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    requestFrame: vi.fn((cb: FrameRequestCallback): number => {
      const handle = nextHandle++;
      pending.set(handle, cb);
      return handle;
    }),
    cancelFrame: vi.fn((handle: number): void => {
      pending.delete(handle);
    }),
    /** Runs all currently pending frame callbacks (one frame tick). */
    step(): void {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb(performance.now());
    },
    get pendingCount(): number {
      return pending.size;
    },
  };
}

describe('createPainter', () => {
  it('requests a single frame for multiple layers and draws each once', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    const drawGrid = vi.fn();
    const drawNotes = vi.fn();

    painter.schedule('grid', drawGrid);
    painter.schedule('notes', drawNotes);
    expect(frames.requestFrame).toHaveBeenCalledTimes(1);
    expect(drawGrid).not.toHaveBeenCalled();

    frames.step();
    expect(drawGrid).toHaveBeenCalledTimes(1);
    expect(drawNotes).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated schedules of the same layer, keeping the latest callback', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    const stale = vi.fn();
    const latest = vi.fn();

    painter.schedule('notes', stale);
    painter.schedule('notes', latest);
    frames.step();

    expect(stale).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(frames.requestFrame).toHaveBeenCalledTimes(1);
  });

  it('invokes layers in first-scheduled order', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    const order: string[] = [];

    painter.schedule('grid', () => order.push('grid'));
    painter.schedule('notes', () => order.push('notes'));
    painter.schedule('grid', () => order.push('grid-again'));
    frames.step();

    expect(order).toEqual(['grid-again', 'notes']);
  });

  it('requests a new frame for schedules after a flush', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    const draw = vi.fn();

    painter.schedule('grid', draw);
    frames.step();
    painter.schedule('grid', draw);
    frames.step();

    expect(draw).toHaveBeenCalledTimes(2);
    expect(frames.requestFrame).toHaveBeenCalledTimes(2);
  });

  it('defers schedules made during a flush to the next frame', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    const second = vi.fn();
    const first = vi.fn(() => {
      painter.schedule('grid', second);
    });

    painter.schedule('grid', first);
    frames.step();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(frames.pendingCount).toBe(1);

    frames.step();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels the pending frame and drops dirty layers', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    const draw = vi.fn();

    painter.schedule('grid', draw);
    painter.dispose();
    expect(frames.cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.pendingCount).toBe(0);

    frames.step();
    expect(draw).not.toHaveBeenCalled();
  });

  it('ignores schedule calls after dispose', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);

    painter.dispose();
    painter.schedule('grid', vi.fn());
    expect(frames.requestFrame).not.toHaveBeenCalled();
  });

  it('is safe to dispose twice and to dispose with no pending frame', () => {
    const frames = makeFrameMock();
    const painter = createPainter(frames);
    painter.dispose();
    painter.dispose();
    expect(frames.cancelFrame).not.toHaveBeenCalled();
  });

  it('falls back to global requestAnimationFrame/cancelAnimationFrame', () => {
    const pending: FrameRequestCallback[] = [];
    const raf = vi.fn((cb: FrameRequestCallback): number => pending.push(cb));
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    try {
      const painter = createPainter();
      const draw = vi.fn();
      painter.schedule('grid', draw);
      expect(raf).toHaveBeenCalledTimes(1);

      for (const cb of pending.splice(0)) cb(0);
      expect(draw).toHaveBeenCalledTimes(1);

      painter.schedule('grid', draw);
      painter.dispose();
      expect(caf).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
