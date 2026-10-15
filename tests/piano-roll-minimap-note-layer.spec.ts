import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PianoRollMinimap from '@/components/piano-roll/PianoRollMinimap.vue';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(notes: EditorNote[]) {
  let observe!: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: typeof observe) {
        observe = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const context = {
    fillStyle: '',
    strokeStyle: '',
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const scheduled = new Map<string, () => void>();
  const painter: Painter = {
    schedule: (layer, draw) => scheduled.set(layer, draw),
    dispose: vi.fn(),
  };
  const range = new TimelineRange({ widthPx: 800, heightPx: 600, pxPerPpq: 100, rowHeight: 10 });
  wrapper = mount(PianoRollMinimap, {
    props: { range, revision: 0, painter, notes, clipLengthPpq: 4 },
  });
  observe([{ contentRect: { width: 240, height: 48 } }]);
  const draw = () => {
    for (const fn of scheduled.values()) fn();
  };
  return { context, draw, range };
}

describe('PianoRollMinimap note layer cache', () => {
  it('redraws only the viewport box when the notes are unchanged', async () => {
    const notes = Array.from({ length: 50 }, (_, id) => ({
      id,
      pitch: 60,
      velocity: 96,
      channel: 0,
      startPpq: id * 0.1,
      durationPpq: 0.1,
    })) as EditorNote[];
    const { context, draw } = setup(notes);
    draw();
    context.fillRect.mockClear();

    await wrapper?.setProps({ revision: 1 });
    draw();

    // Background fill and viewport fill; the note layer is blitted from the cache.
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenCalled();
  });

  it('rebuilds the note layer when the notes array is replaced', async () => {
    const note = { id: 1, pitch: 60, velocity: 96, channel: 0, startPpq: 0, durationPpq: 1 };
    const { context, draw } = setup([note]);
    draw();
    context.fillRect.mockClear();

    await wrapper?.setProps({ notes: [{ ...note }] });
    draw();

    expect(context.fillRect).toHaveBeenCalledTimes(3);
  });
});
