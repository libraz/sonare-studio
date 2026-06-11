import { afterEach, describe, expect, it } from 'vitest';
import { createFocusTrap, getFocusableElements, wrapTabFocus } from '@/ui/settings/focus-trap';

/** Creates one element with attributes and appends it to a parent. */
function el(
  parent: HTMLElement,
  tag: string,
  attrs: Record<string, string | boolean> = {},
): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === 'boolean') {
      if (value) node.setAttribute(name, '');
    } else {
      node.setAttribute(name, value);
    }
  }
  parent.appendChild(node);
  return node;
}

/** Creates an attached container div (tabindex=-1, like a dialog root). */
function makeContainer(): HTMLElement {
  const container = document.createElement('div');
  container.tabIndex = -1;
  document.body.appendChild(container);
  return container;
}

function tab(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true });
}

afterEach(() => {
  document.body.textContent = '';
});

describe('getFocusableElements', () => {
  it('lists focusable elements in DOM order', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    el(container, 'a', { id: 'b', href: '#' });
    el(container, 'input', { id: 'c' });
    el(container, 'select', { id: 'd' });
    el(container, 'textarea', { id: 'e' });
    el(container, 'div', { id: 'f', tabindex: '0' });
    expect(getFocusableElements(container).map((node) => node.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('skips disabled, hidden, aria-hidden, hidden-ancestor and tabindex=-1 elements', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a', disabled: true });
    el(container, 'button', { id: 'b', hidden: true });
    el(container, 'button', { id: 'c', 'aria-hidden': 'true' });
    const hiddenWrap = el(container, 'div', { hidden: true });
    el(hiddenWrap, 'button', { id: 'd' });
    el(container, 'div', { id: 'e', tabindex: '-1' });
    el(container, 'a', { id: 'f' }); // Anchor without href is not focusable.
    el(container, 'button', { id: 'g' });
    expect(getFocusableElements(container).map((node) => node.id)).toEqual(['g']);
  });
});

describe('wrapTabFocus', () => {
  it('ignores non-Tab keys', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    expect(wrapTabFocus(new KeyboardEvent('keydown', { key: 'a' }), container)).toBe(false);
  });

  it('wraps forward from the last element to the first', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    const last = el(container, 'button', { id: 'b' });
    last.focus();
    const event = tab();
    expect(wrapTabFocus(event, container)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('a');
  });

  it('wraps backward from the first element to the last', () => {
    const container = makeContainer();
    const first = el(container, 'button', { id: 'a' });
    el(container, 'button', { id: 'b' });
    first.focus();
    expect(wrapTabFocus(tab(true), container)).toBe(true);
    expect(document.activeElement?.id).toBe('b');
  });

  it('lets Tab proceed between interior elements', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    const middle = el(container, 'button', { id: 'b' });
    el(container, 'button', { id: 'c' });
    middle.focus();
    expect(wrapTabFocus(tab(), container)).toBe(false);
    expect(wrapTabFocus(tab(true), container)).toBe(false);
  });

  it('pulls focus inside when it is outside the container', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    const outside = el(document.body, 'button', { id: 'outside' });
    outside.focus();
    expect(wrapTabFocus(tab(), container)).toBe(true);
    expect(document.activeElement?.id).toBe('a');
  });

  it('pins focus on the container when nothing inside is focusable', () => {
    const container = makeContainer();
    el(container, 'p');
    const event = tab();
    expect(wrapTabFocus(event, container)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container);
  });
});

describe('createFocusTrap', () => {
  it('focuses the first focusable child on activate', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    el(container, 'button', { id: 'b' });
    const trap = createFocusTrap(container);
    expect(trap.isActive()).toBe(false);
    trap.activate();
    expect(trap.isActive()).toBe(true);
    expect(document.activeElement?.id).toBe('a');
    trap.deactivate();
  });

  it('falls back to the container itself when empty', () => {
    const container = makeContainer();
    el(container, 'p');
    const trap = createFocusTrap(container);
    trap.activate();
    expect(document.activeElement).toBe(container);
    trap.deactivate();
  });

  it('wraps Tab while active', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    const last = el(container, 'button', { id: 'b' });
    const trap = createFocusTrap(container);
    trap.activate();
    last.focus();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true }),
    );
    expect(document.activeElement?.id).toBe('a');
    trap.deactivate();
  });

  it('restores focus to the previously focused element on deactivate', () => {
    const trigger = el(document.body, 'button', { id: 'trigger' });
    trigger.focus();
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    const trap = createFocusTrap(container);
    trap.activate();
    expect(document.activeElement?.id).toBe('a');
    trap.deactivate();
    expect(trap.isActive()).toBe(false);
    expect(document.activeElement?.id).toBe('trigger');
  });

  it('activate and deactivate are idempotent', () => {
    const container = makeContainer();
    el(container, 'button', { id: 'a' });
    const trap = createFocusTrap(container);
    trap.activate();
    trap.activate();
    trap.deactivate();
    trap.deactivate();
    expect(trap.isActive()).toBe(false);
  });
});
