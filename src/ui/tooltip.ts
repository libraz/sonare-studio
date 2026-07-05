import type { Directive, DirectiveBinding } from 'vue';

/**
 * `v-tooltip` — a native-app replacement for the browser's `title` tooltip.
 *
 * Bind a string: `v-tooltip="'Quantize selection'"` or `v-tooltip="someRef"`.
 * A single floating chip is shared across the whole app (created lazily and
 * reused), so thousands of tooltip targets cost one DOM node. The chip shows
 * after a short hover/focus delay, is positioned above its anchor (flipping
 * below when there is no room) and reads the frosted-glass tokens. It hides on
 * leave, blur, pointer-down, scroll and Escape.
 *
 * Accessibility: when the anchor has no accessible name of its own (no
 * `aria-label` / `aria-labelledby`), the directive mirrors the text into
 * `aria-label` so the information is not lost for assistive tech; anchors that
 * are already named are left untouched.
 */

/** Delay before a hovered/focused tooltip appears, in ms. */
const SHOW_DELAY_MS = 400;

interface TooltipState {
  text: string;
  /** True when the directive set aria-label itself (so it can clean it up). */
  ownsAriaLabel: boolean;
  onEnter: (event: Event) => void;
  onLeave: () => void;
  onFocus: () => void;
}

const states = new WeakMap<HTMLElement, TooltipState>();

let chip: HTMLDivElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let timerAnchor: HTMLElement | null = null;
let anchor: HTMLElement | null = null;

/** Lazily creates the shared tooltip chip. */
function ensureChip(): HTMLDivElement {
  if (chip) return chip;
  const node = document.createElement('div');
  node.className = 'app-tooltip';
  node.setAttribute('role', 'tooltip');
  node.setAttribute('aria-hidden', 'true');
  document.body.appendChild(node);
  chip = node;
  return node;
}

/** Positions the chip above (or below) the anchor, clamped to the viewport. */
function reposition(el: HTMLElement): void {
  const node = ensureChip();
  const rect = el.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const gap = 8;
  let top = rect.top - box.height - gap;
  if (top < 4) top = rect.bottom + gap;
  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - box.width - 4));
  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;
}

/** Hides and detaches the shared chip from the current anchor. */
function hide(): void {
  clearTimeout(showTimer);
  showTimer = undefined;
  timerAnchor = null;
  anchor = null;
  if (!chip) return;
  chip.classList.remove('is-visible');
  chip.setAttribute('aria-hidden', 'true');
}

/** Shows the chip for `el` with the given text (already debounced). */
function show(el: HTMLElement, text: string): void {
  if (!text) return;
  // Never cover a popover/menu the anchor has just opened.
  if (el.getAttribute('aria-expanded') === 'true') return;
  const node = ensureChip();
  node.textContent = text;
  // Make it measurable before positioning, then reveal.
  node.classList.add('is-visible');
  node.setAttribute('aria-hidden', 'false');
  reposition(el);
  anchor = el;
}

function onScroll(): void {
  hide();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') hide();
}

// Window-level listeners are registered once; they no-op while idle.
let globalsBound = false;
function bindGlobals(): void {
  if (globalsBound) return;
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('pointerdown', hide, true);
  globalsBound = true;
}

/** Mirrors the text into aria-label when the anchor has no name of its own. */
function syncAria(el: HTMLElement, text: string, state: TooltipState): void {
  const hasName = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
  if (!hasName && text) {
    el.setAttribute('aria-label', text);
    state.ownsAriaLabel = true;
  } else if (state.ownsAriaLabel) {
    // The anchor gained its own name, or the text cleared.
    if (text) el.setAttribute('aria-label', text);
    else {
      el.removeAttribute('aria-label');
      state.ownsAriaLabel = false;
    }
  }
}

function setup(el: HTMLElement, value: unknown): void {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  bindGlobals();

  const onEnter = (): void => {
    const current = states.get(el);
    if (!current?.text) return;
    clearTimeout(showTimer);
    timerAnchor = el;
    showTimer = setTimeout(() => {
      showTimer = undefined;
      timerAnchor = null;
      show(el, current.text);
    }, SHOW_DELAY_MS);
  };
  const onLeave = (): void => {
    if (anchor === el || showTimer) hide();
  };
  const onFocus = (): void => {
    const current = states.get(el);
    if (!current?.text) return;
    // Only reveal on KEYBOARD focus. A pointer click that focuses the anchor
    // (e.g. opening a menu) is not :focus-visible, so the tooltip never pops up
    // to cover what the click just opened. Guard matches() for engines that do
    // not understand the pseudo-class (treat as "not keyboard focus").
    let keyboardFocus = false;
    try {
      keyboardFocus = el.matches(':focus-visible');
    } catch {
      keyboardFocus = false;
    }
    if (keyboardFocus) show(el, current.text);
  };

  const state: TooltipState = { text, ownsAriaLabel: false, onEnter, onLeave, onFocus };
  states.set(el, state);
  syncAria(el, text, state);

  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('focus', onFocus, true);
  el.addEventListener('blur', onLeave, true);
}

function update(el: HTMLElement, value: unknown): void {
  const state = states.get(el);
  if (!state) {
    setup(el, value);
    return;
  }
  state.text = typeof value === 'string' ? value : value == null ? '' : String(value);
  syncAria(el, state.text, state);
  if (anchor === el) {
    if (state.text) show(el, state.text);
    else hide();
  }
}

function teardown(el: HTMLElement): void {
  const state = states.get(el);
  if (!state) return;
  el.removeEventListener('pointerenter', state.onEnter);
  el.removeEventListener('pointerleave', state.onLeave);
  el.removeEventListener('focus', state.onFocus, true);
  el.removeEventListener('blur', state.onLeave, true);
  if (anchor === el || timerAnchor === el) hide();
  states.delete(el);
}

/** The `v-tooltip` directive. Register globally in main.ts. */
export const vTooltip: Directive<HTMLElement, unknown> = {
  mounted(el, binding: DirectiveBinding<unknown>) {
    setup(el, binding.value);
  },
  updated(el, binding: DirectiveBinding<unknown>) {
    update(el, binding.value);
  },
  beforeUnmount(el) {
    teardown(el);
  },
};
