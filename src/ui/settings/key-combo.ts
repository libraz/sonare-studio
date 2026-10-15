/**
 * Key-combo parsing, formatting and matching for the shortcut system.
 *
 * Combos are stored as canonical lower-case strings like `mod+shift+z` where
 * `mod` is the platform command key (Cmd on macOS, Ctrl elsewhere). Matching
 * maps `mod` to Cmd on macOS and Ctrl everywhere else. In particular, the
 * Windows key (`metaKey`) is never treated as a command modifier on Windows.
 */

/** Platform flavor used for combo display (and for documentation of `mod`). */
export type Platform = 'mac' | 'other';

/** A parsed key combination. */
export interface KeyCombo {
  /** Normalized key name: lower-case letter, digit, punctuation char, or a named key like 'space', 'arrowup', 'backspace'. */
  key: string;
  /** Command modifier (Cmd on macOS, Ctrl elsewhere). */
  mod: boolean;
  /** Shift modifier. */
  shift: boolean;
  /** Alt/Option modifier. */
  alt: boolean;
}

/** Modifier token aliases accepted by {@link parseKeyCombo}. */
const MODIFIER_ALIASES: Record<string, keyof Pick<KeyCombo, 'mod' | 'shift' | 'alt'>> = {
  mod: 'mod',
  cmd: 'mod',
  meta: 'mod',
  ctrl: 'mod',
  control: 'mod',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
};

/** Key-name aliases mapped to their canonical form. */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

/** Named keys with a dedicated display label. */
const KEY_DISPLAY: Record<string, string> = {
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/** Keys that are modifiers on their own and never form a combo. */
const MODIFIER_KEYS = new Set(['shift', 'control', 'meta', 'alt', 'os']);

/**
 * Detects the current platform from the browser environment.
 *
 * @returns 'mac' for macOS/iOS user agents, 'other' otherwise (including
 *   non-browser environments such as tests).
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const signature = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(signature) ? 'mac' : 'other';
}

/** Normalizes a raw key token (from text or KeyboardEvent.key). */
function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Parses a combo string like 'mod+shift+z' into a {@link KeyCombo}.
 *
 * Accepted modifier tokens: mod/cmd/meta/ctrl/control, shift, alt/option.
 * The final token is the key; '+' itself is a valid key ('mod++').
 *
 * @param text Combo text, case-insensitive.
 * @returns The parsed combo, or null when the text is empty, contains an
 *   unknown modifier, or has no key.
 */
export function parseKeyCombo(text: string): KeyCombo | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return null;
  const parts = trimmed.split('+');
  let key = parts.pop() ?? '';
  if (key === '' && parts.length > 0) {
    // Trailing '+' means the key itself is '+'; drop the split artifact.
    key = '+';
    if (parts[parts.length - 1] === '') parts.pop();
  }
  if (key === '' || /\s/.test(key)) return null;
  const combo: KeyCombo = { key: normalizeKey(key), mod: false, shift: false, alt: false };
  if (MODIFIER_KEYS.has(combo.key)) return null;
  for (const part of parts) {
    const flag = MODIFIER_ALIASES[part];
    if (flag === undefined) return null;
    combo[flag] = true;
  }
  return combo;
}

/**
 * Serializes a combo to its canonical storage string ('mod+shift+z').
 * Modifier order is fixed: mod, alt, shift, key.
 */
export function comboToString(combo: KeyCombo): string {
  let out = '';
  if (combo.mod) out += 'mod+';
  if (combo.alt) out += 'alt+';
  if (combo.shift) out += 'shift+';
  return out + combo.key;
}

/**
 * Re-serializes a combo string to canonical form.
 *
 * @returns The canonical string, or null when the input does not parse.
 */
export function normalizeComboString(text: string): string | null {
  const combo = parseKeyCombo(text);
  return combo === null ? null : comboToString(combo);
}

/** Returns the display label for a normalized key name. */
function keyDisplay(key: string): string {
  const named = KEY_DISPLAY[key];
  if (named !== undefined) return named;
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Formats a combo for display.
 *
 * macOS uses the conventional symbols in system order ('⌥⇧⌘Z');
 * other platforms use 'Ctrl+Alt+Shift+Z'.
 *
 * @param combo Parsed combo or a combo string (unparseable strings are
 *   returned verbatim).
 * @param platform Display platform.
 */
export function formatKeyCombo(combo: KeyCombo | string, platform: Platform): string {
  const parsed = typeof combo === 'string' ? parseKeyCombo(combo) : combo;
  if (parsed === null) return typeof combo === 'string' ? combo : '';
  if (platform === 'mac') {
    let out = '';
    if (parsed.alt) out += '⌥';
    if (parsed.shift) out += '⇧';
    if (parsed.mod) out += '⌘';
    return out + keyDisplay(parsed.key);
  }
  const parts: string[] = [];
  if (parsed.mod) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(keyDisplay(parsed.key));
  return parts.join('+');
}

/**
 * Resolves the key of an Alt-modified event. Option on macOS composes
 * `event.key` into another character ('mu', 'ß', a dead key), so a letter or
 * digit is taken from the physical `event.code` whenever the composed key is
 * not itself a plain letter or digit.
 */
function altKeyFromEvent(event: KeyboardEvent, key: string): string {
  if (!event.altKey || /^[a-z0-9]$/.test(key)) return key;
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code ?? '');
  return physical === null ? key : (physical[1] ?? physical[2]).toLowerCase();
}

/**
 * Builds a combo from a keyboard event. This is the single place where event
 * modifiers are read, so matching and capture agree on the platform table.
 *
 * `mod` is the command modifier of the supplied platform: Cmd on macOS and
 * Ctrl everywhere else. The other platform's command key (Ctrl on macOS, the
 * Windows key elsewhere) has no combo representation, so an event carrying it
 * resolves to no combo instead of matching the bare key.
 *
 * @returns The combo, or null when the pressed key is itself a modifier or a
 *   foreign command modifier is held.
 */
export function comboFromEvent(event: KeyboardEvent, platform = detectPlatform()): KeyCombo | null {
  const key = normalizeKey(event.key);
  if (MODIFIER_KEYS.has(key)) return null;
  const mac = platform === 'mac';
  if (mac ? event.ctrlKey : event.metaKey) return null;
  return {
    key: altKeyFromEvent(event, key),
    mod: mac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/**
 * True when the key is a shift-produced punctuation character ('?', '+', …)
 * whose physical Shift state is layout-dependent; matching ignores Shift for
 * these so a '?' binding fires regardless of how the layout produces it.
 */
function isShiftAmbiguous(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

/** Structural equality of two combos (Shift relaxed for shifted punctuation). */
export function combosMatch(a: KeyCombo, b: KeyCombo): boolean {
  if (a.key !== b.key || a.mod !== b.mod || a.alt !== b.alt) return false;
  return a.shift === b.shift || isShiftAmbiguous(a.key);
}
