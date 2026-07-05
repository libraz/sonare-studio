import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectiveBinding } from 'vue';
import { vTooltip } from '@/ui/tooltip';

function binding(value: unknown): DirectiveBinding<unknown> {
  return { value } as DirectiveBinding<unknown>;
}

describe('vTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('cancels a pending hover timer when the target unmounts', () => {
    const el = document.createElement('button');
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 100, bottom: 124, width: 40, height: 24 }) as DOMRect;
    document.body.appendChild(el);

    vTooltip.mounted?.(el, binding('Quantize'));
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vTooltip.beforeUnmount?.(el, binding('Quantize'));

    vi.advanceTimersByTime(400);

    expect(document.querySelector('.app-tooltip')).toBeNull();
  });

  it('removes target listeners on unmount', () => {
    const el = document.createElement('button');
    const removeEventListener = vi.spyOn(el, 'removeEventListener');
    vTooltip.mounted?.(el, binding('Play'));

    vTooltip.beforeUnmount?.(el, binding('Play'));

    expect(removeEventListener).toHaveBeenCalledWith('pointerenter', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('pointerleave', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function), true);
    expect(removeEventListener).toHaveBeenCalledWith('blur', expect.any(Function), true);
  });
});
