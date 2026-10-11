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

  it('renders text, the bound shortcut key and the unavailable reason', () => {
    const el = document.createElement('button');
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 100, bottom: 124, width: 40, height: 24 }) as DOMRect;
    document.body.appendChild(el);

    vTooltip.mounted?.(
      el,
      binding({ text: 'Undo', shortcut: 'edit.undo', reason: 'Nothing to undo yet' }),
    );
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vi.advanceTimersByTime(400);

    const chip = document.querySelector('.app-tooltip');
    expect(chip?.querySelector('.app-tooltip__text')?.firstChild?.textContent).toBe('Undo');
    expect(chip?.querySelector('.app-tooltip__keys')?.textContent).not.toBe('');
    expect(chip?.querySelector('.app-tooltip__reason')?.textContent).toBe('Nothing to undo yet');
    expect(el.getAttribute('aria-label')).toMatch(/^Undo \(.+\)$/);
    expect(el.getAttribute('aria-description')).toBe('Nothing to undo yet');

    vTooltip.updated?.(el, binding({ text: 'Undo', shortcut: 'edit.undo', reason: null }));
    expect(el.hasAttribute('aria-description')).toBe(false);
    expect(chip?.querySelector('.app-tooltip__reason')).toBeNull();
    vTooltip.beforeUnmount?.(el, binding(null));
  });

  it('shows a reason-only tooltip and leaves an existing name alone', () => {
    const el = document.createElement('button');
    el.setAttribute('aria-label', 'Open');
    el.getBoundingClientRect = () =>
      ({ left: 100, top: 100, bottom: 124, width: 40, height: 24 }) as DOMRect;
    document.body.appendChild(el);

    vTooltip.mounted?.(el, binding({ reason: 'Browser storage is unavailable' }));
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vi.advanceTimersByTime(400);

    expect(document.querySelector('.app-tooltip')?.textContent).toBe(
      'Browser storage is unavailable',
    );
    expect(el.getAttribute('aria-label')).toBe('Open');
    vTooltip.beforeUnmount?.(el, binding(null));
  });

  it('keeps a visible-text name and describes the control instead', () => {
    const el = document.createElement('button');
    el.textContent = 'Quantize';
    document.body.appendChild(el);

    vTooltip.mounted?.(
      el,
      binding({ text: 'Move selected note starts onto the grid', reason: 'Select notes first' }),
    );

    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(el.getAttribute('aria-description')).toBe(
      'Move selected note starts onto the grid. Select notes first.',
    );
    vTooltip.beforeUnmount?.(el, binding(null));
  });
});
