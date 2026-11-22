import type { Directive, DirectiveBinding } from 'vue';
import { shortcutHint } from '@/ui/settings/shortcut-hint';

/**
 * `v-tooltip` — a native-app replacement for the browser's `title` tooltip.
 *
 * Bind a string: `v-tooltip="'Quantize selection'"` or `v-tooltip="someRef"`,
 * or a {@link TooltipSpec} to add the live key binding of a shortcut action and
 * the reason a control is unavailable:
 * `v-tooltip="{ text: t.quantize, shortcut: 'edit.quantize', reason: blocked }"`.
 * A single floating chip is shared across the whole app (created lazily and
 * reused), so thousands of tooltip targets cost one DOM node. The chip shows
 * after a short hover/focus delay, is positioned above its anchor (flipping
 * below when there is no room) and reads the frosted-glass tokens. It hides on
 * leave, blur, pointer-down, scroll and Escape.
 *
 * Accessibility: when the anchor has no accessible name of its own (no
 * `aria-label` / `aria-labelledby`), the directive mirrors the text into
 * `aria-label` so the information is not lost for assistive tech; anchors that
 * are already named (including by visible text or a `<label>`) keep their name
 * and get the text as `aria-description`. A reason is mirrored into
 * `aria-description` too, since a disabled control cannot take focus to reveal it.
 */

/** Structured tooltip content. */
export interface TooltipSpec {
  /** What the control does. */
  text?: string | null;
  /** Shortcut action id whose current key binding is shown beside the text. */
  shortcut?: string | null;
  /** Why the control is unavailable right now; empty or null when it is usable. */
  reason?: string | null;
  /** 'end' places the chip beside the anchor, for rows in a menu or list. Default 'top'. */
  placement?: 'top' | 'end';
}

interface TooltipContent {
  text: string;
  shortcut: string;
  reason: string;
  placement: 'top' | 'end';
}

const EMPTY: TooltipContent = { text: '', shortcut: '', reason: '', placement: 'top' };

function normalize(value: unknown): TooltipContent {
  if (value == null) return EMPTY;
  if (typeof value === 'object') {
    const spec = value as TooltipSpec;
    return {
      text: spec.text ?? '',
      shortcut: spec.shortcut ?? '',
      reason: spec.reason ?? '',
      placement: spec.placement ?? 'top',
    };
  }
  return { ...EMPTY, text: String(value) };
}

/** First effective key binding of a shortcut action, formatted for display. */
function keyLabel(actionId: string): string {
  return actionId ? (shortcutHint(actionId) ?? '') : '';
}

/** Plain-text form of the content, used for the accessible name. */
function plainText(content: TooltipContent): string {
  const keys = keyLabel(content.shortcut);
  return keys && content.text ? `${content.text} (${keys})` : content.text;
}

function isEmpty(content: TooltipContent): boolean {
  return !content.text && !content.reason;
}

/** Delay before a hovered/focused tooltip appears, in ms. */
const SHOW_DELAY_MS = 400;

/** Minimum distance between the chip and the viewport edge. */
const VIEWPORT_MARGIN_PX = 4;

interface TooltipState {
  content: TooltipContent;
  /** True when the directive set aria-label itself (so it can clean it up). */
  ownsAriaLabel: boolean;
  /** True when the directive set aria-description itself. */
  ownsAriaDescription: boolean;
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
  if (chip?.isConnected) return chip;
  const node = document.createElement('div');
  node.className = 'app-tooltip';
  node.setAttribute('role', 'tooltip');
  node.setAttribute('aria-hidden', 'true');
  document.body.appendChild(node);
  chip = node;
  return node;
}

/**
 * Positions the chip above (or below) the anchor, or beside it for 'end'
 * (flipping to the start side when there is no room), clamped to the viewport.
 */
function reposition(el: HTMLElement, placement: 'top' | 'end'): void {
  const node = ensureChip();
  const rect = el.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const gap = 8;
  if (placement === 'end') {
    let left = rect.right + gap;
    if (left + box.width > window.innerWidth - VIEWPORT_MARGIN_PX)
      left = rect.left - box.width - gap;
    const top = rect.top + rect.height / 2 - box.height / 2;
    node.style.top = `${Math.round(Math.max(VIEWPORT_MARGIN_PX, Math.min(top, window.innerHeight - box.height - VIEWPORT_MARGIN_PX)))}px`;
    node.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN_PX, left))}px`;
    return;
  }
  let top = rect.top - box.height - gap;
  if (top < VIEWPORT_MARGIN_PX) top = rect.bottom + gap;
  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(left, window.innerWidth - box.width - VIEWPORT_MARGIN_PX),
  );
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

/** Rebuilds the chip body: text line with key chip, then the reason line. */
function render(node: HTMLDivElement, content: TooltipContent): void {
  node.replaceChildren();
  const keys = keyLabel(content.shortcut);
  if (content.text) {
    const line = document.createElement('span');
    line.className = 'app-tooltip__text';
    line.textContent = content.text;
    if (keys) {
      const kbd = document.createElement('kbd');
      kbd.className = 'app-tooltip__keys';
      kbd.textContent = keys;
      line.append(' ', kbd);
    }
    node.append(line);
  }
  if (content.reason) {
    const reason = document.createElement('span');
    reason.className = 'app-tooltip__reason';
    reason.textContent = content.reason;
    node.append(reason);
  }
}

/** Shows the chip for `el` with the given content (already debounced). */
function show(el: HTMLElement, content: TooltipContent): void {
  if (isEmpty(content)) return;
  // Never cover a popover/menu the anchor has just opened.
  if (el.getAttribute('aria-expanded') === 'true') return;
  const node = ensureChip();
  render(node, content);
  // Make it measurable before positioning, then reveal.
  node.classList.add('is-visible');
  node.setAttribute('aria-hidden', 'false');
  reposition(el, content.placement);
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

/** True when the anchor is named by markup of its own: an aria name, a <label> or visible text. */
function hasOwnName(el: HTMLElement, state: TooltipState): boolean {
  if (el.hasAttribute('aria-labelledby')) return true;
  if (!state.ownsAriaLabel && el.hasAttribute('aria-label')) return true;
  const labels = (el as Partial<HTMLInputElement>).labels;
  if (labels && labels.length > 0) return true;
  return (el.textContent ?? '').trim() !== '';
}

/**
 * Names an unnamed anchor with the tooltip text; on a named anchor the text
 * goes to aria-description instead (unless it repeats the name), with the reason.
 */
function syncAria(el: HTMLElement, state: TooltipState): void {
  const text = plainText(state.content);
  const named = hasOwnName(el, state);
  if (!named && text) {
    el.setAttribute('aria-label', text);
    state.ownsAriaLabel = true;
  } else if (state.ownsAriaLabel) {
    el.removeAttribute('aria-label');
    state.ownsAriaLabel = false;
  }
  const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
  const parts: string[] = [];
  if (named && text && text !== name) parts.push(text);
  if (state.content.reason) parts.push(state.content.reason);
  // Terminate each sentence so a joined text and reason are read as two.
  const sentences =
    parts.length > 1 ? parts.map((part) => (/[.!?。！？]$/.test(part) ? part : `${part}.`)) : parts;
  syncDescription(el, state, sentences.join(' '));
}

/** Mirrors the description into aria-description unless the anchor owns one. */
function syncDescription(el: HTMLElement, state: TooltipState, description: string): void {
  if (description && (state.ownsAriaDescription || !el.hasAttribute('aria-description'))) {
    el.setAttribute('aria-description', description);
    state.ownsAriaDescription = true;
  } else if (!description && state.ownsAriaDescription) {
    el.removeAttribute('aria-description');
    state.ownsAriaDescription = false;
  }
}

function setup(el: HTMLElement, value: unknown): void {
  const content = normalize(value);
  bindGlobals();

  const onEnter = (): void => {
    const current = states.get(el);
    if (!current || isEmpty(current.content)) return;
    clearTimeout(showTimer);
    timerAnchor = el;
    showTimer = setTimeout(() => {
      showTimer = undefined;
      timerAnchor = null;
      show(el, current.content);
    }, SHOW_DELAY_MS);
  };
  const onLeave = (): void => {
    if (anchor === el || showTimer) hide();
  };
  const onFocus = (): void => {
    const current = states.get(el);
    if (!current || isEmpty(current.content)) return;
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
    if (keyboardFocus) show(el, current.content);
  };

  const state: TooltipState = {
    content,
    ownsAriaLabel: false,
    ownsAriaDescription: false,
    onEnter,
    onLeave,
    onFocus,
  };
  states.set(el, state);
  syncAria(el, state);

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
  state.content = normalize(value);
  syncAria(el, state);
  if (anchor === el) {
    if (isEmpty(state.content)) hide();
    else show(el, state.content);
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
