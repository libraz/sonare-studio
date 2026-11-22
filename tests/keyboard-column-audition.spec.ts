import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KeyboardColumn from '@/components/piano-roll/KeyboardColumn.vue';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

class ResizeObserverStub {
  disconnect(): void {}
  observe(): void {}
}

const painter: Painter = { dispose: vi.fn(), flush: vi.fn(), schedule: vi.fn() };
const range = new TimelineRange({ widthPx: 800, heightPx: 1280, pxPerPpq: 100, rowHeight: 10 });

describe('KeyboardColumn', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', ResizeObserverStub));
  afterEach(() => vi.unstubAllGlobals());

  it('auditions the key at the pointer position without editing notes', () => {
    const audition = vi.fn();
    const wrapper = mount(KeyboardColumn, { props: { audition, painter, range, revision: 0 } });
    const column = wrapper.get('.keyboard-column');
    vi.spyOn(column.element, 'getBoundingClientRect').mockReturnValue({ top: 20 } as DOMRect);

    column.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 290 }),
    );

    expect(audition).toHaveBeenCalledWith(100, 96);
    wrapper.unmount();
  });
});
