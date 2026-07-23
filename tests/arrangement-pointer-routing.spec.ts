import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePointerRouting } from '@/ui/arrangement/use-pointer-routing';
import { useTakeInteractions } from '@/ui/arrangement/use-take-interactions';

describe('usePointerRouting double-clicks', () => {
  it('does not pass an expanded take sub-row through to clip creation', () => {
    const onDoubleClick = vi.fn();
    const takes = useTakeInteractions({
      view: {
        ppqToX: (ppq) => ppq,
        xToPpq: (x) => x,
        takeRowAt: (point) => (point.y === 80 ? { trackId: 1, takeIndex: 0 } : null),
      },
      getClips: () => [],
      commands: { setActiveTake: vi.fn(), setCompSegments: vi.fn() },
    });
    const routing = usePointerRouting({
      wrapper: ref({ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLElement),
      range: () => ({ xToPpq: (x: number) => x }) as never,
      automation: {
        cursor: ref(null),
        onDoubleClick: vi.fn(() => false),
      } as never,
      takes,
      interactions: { cursor: ref('default'), onDoubleClick } as never,
      onRulerSeek: vi.fn(),
      onRulerContext: vi.fn(),
      onClipContext: vi.fn(),
    });

    routing.onDoubleClick({ clientX: 20, clientY: 80 } as MouseEvent);

    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});
