import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VelocityLane from '@/components/piano-roll/VelocityLane.vue';
import type { EditorNote } from '@/project/types';
import type { Painter } from '@/ui/canvas/painter';
import { TimelineRange } from '@/ui/canvas/timeline-range';

const commands = vi.hoisted(() => ({ setSelection: vi.fn(), updateNotes: vi.fn() }));

vi.mock('@/project/commands', () => commands);

const range = new TimelineRange({ widthPx: 800, heightPx: 100, pxPerPpq: 100 });

const painter: Painter = { dispose: vi.fn(), flush: vi.fn(), schedule: vi.fn() };
const notes: EditorNote[] = [
  { id: 1, pitch: 60, velocity: 96, startPpq: 1, durationPpq: 1, channel: 0 },
];

class ResizeObserverStub {
  disconnect(): void {}
  observe(): void {}
}

describe('VelocityLane', () => {
  beforeEach(() => {
    commands.setSelection.mockReset();
    commands.updateNotes.mockReset();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not start a note mutation gesture when read-only', async () => {
    const wrapper = mount(VelocityLane, {
      props: { range, revision: 0, painter, notes, readOnly: true, selection: new Set<number>() },
    });
    const lane = wrapper.get('.velocity-lane');
    Object.assign(lane.element, { setPointerCapture: vi.fn() });

    lane.element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 10 }),
    );

    expect(commands.setSelection).not.toHaveBeenCalled();
    expect(commands.updateNotes).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
