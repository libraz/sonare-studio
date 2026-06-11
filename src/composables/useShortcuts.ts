import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { normalizeComboString } from '@/ui/settings/key-combo';
import {
  findConflicts,
  getShortcutAction,
  matchShortcut,
  resolveBindings,
  SHORTCUT_ACTIONS,
  type ShortcutActionDef,
  type ShortcutBindings,
  type ShortcutConflict,
  type ShortcutOverrides,
  type ShortcutScope,
} from '@/ui/settings/shortcuts';

/** localStorage key holding the versioned overrides envelope. */
export const SHORTCUTS_STORAGE_KEY = 'sonare-studio.shortcuts';

/** Storage schema version of the overrides envelope. */
export const SHORTCUT_OVERRIDES_VERSION = 1;

/** Reactive shortcut registry state and actions returned by {@link useShortcuts}. */
export interface UseShortcutsReturn {
  /** The full action registry (definition order = matcher tie-break order). */
  actions: ReadonlyArray<ShortcutActionDef>;
  /** Effective bindings (defaults with user overrides applied). */
  bindings: ComputedRef<ShortcutBindings>;
  /** Current binding collisions across overlapping scopes. */
  conflicts: ComputedRef<ShortcutConflict[]>;
  /** Effective combos for one action ([] when unbound or unknown). */
  keysFor(actionId: string): ReadonlyArray<string>;
  /** True when the action's keys differ from its defaults. */
  isOverridden(actionId: string): boolean;
  /**
   * Replaces an action's keys ([] unbinds; invalid combos are dropped) and
   * persists. Ignored for unknown or non-customizable actions.
   */
  setKeys(actionId: string, keys: ReadonlyArray<string>): void;
  /** Removes the override so the action returns to its defaults. */
  resetKeys(actionId: string): void;
  /** Removes every override. */
  resetAll(): void;
  /** Matches a keydown against the effective bindings for a scope. */
  match(event: KeyboardEvent, scope: ShortcutScope): string | null;
  /** Re-reads overrides from storage. */
  reload(): void;
}

/** Reads stored overrides; invalid payloads yield no overrides. */
function readStored(): ShortcutOverrides {
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const raw = (parsed as { overrides?: unknown }).overrides;
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string[]> = {};
  for (const [actionId, value] of Object.entries(raw as Record<string, unknown>)) {
    const action = getShortcutAction(actionId);
    if (action === undefined || !action.customizable || !Array.isArray(value)) continue;
    const keys: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const canonical = normalizeComboString(item);
      if (canonical !== null && !keys.includes(canonical)) keys.push(canonical);
    }
    out[actionId] = keys;
  }
  return out;
}

/** Best-effort write; storage failures are ignored. */
function writeStored(overrides: ShortcutOverrides): void {
  try {
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({ version: SHORTCUT_OVERRIDES_VERSION, overrides }),
    );
  } catch {
    // Overrides stay in memory for the session.
  }
}

// Single shared override state so the dialog, help overlay and the shell's
// keydown handler always agree.
const overrides: Ref<ShortcutOverrides> = ref(readStored());

const bindings = computed<ShortcutBindings>(() => resolveBindings(overrides.value));
const conflicts = computed<ShortcutConflict[]>(() => findConflicts(bindings.value));

/**
 * Vue composable exposing the shortcut registry with user remapping.
 *
 * Overrides persist to localStorage; the shell's keydown handlers call
 * `match(event, scope)` to translate key presses into action ids. Safe to
 * call outside a component scope.
 */
export function useShortcuts(): UseShortcutsReturn {
  const keysFor = (actionId: string): ReadonlyArray<string> => bindings.value.get(actionId) ?? [];

  const isOverridden = (actionId: string): boolean => overrides.value[actionId] !== undefined;

  const setKeys = (actionId: string, keys: ReadonlyArray<string>): void => {
    const action = getShortcutAction(actionId);
    if (action === undefined || !action.customizable) return;
    const canonical: string[] = [];
    for (const text of keys) {
      const normalized = normalizeComboString(text);
      if (normalized !== null && !canonical.includes(normalized)) canonical.push(normalized);
    }
    overrides.value = { ...overrides.value, [actionId]: canonical };
    writeStored(overrides.value);
  };

  const resetKeys = (actionId: string): void => {
    if (overrides.value[actionId] === undefined) return;
    const next = { ...overrides.value } as Record<string, ReadonlyArray<string>>;
    delete next[actionId];
    overrides.value = next;
    writeStored(overrides.value);
  };

  const resetAll = (): void => {
    overrides.value = {};
    writeStored(overrides.value);
  };

  const match = (event: KeyboardEvent, scope: ShortcutScope): string | null =>
    matchShortcut(event, scope, bindings.value);

  const reload = (): void => {
    overrides.value = readStored();
  };

  return {
    actions: SHORTCUT_ACTIONS,
    bindings,
    conflicts,
    keysFor,
    isOverridden,
    setKeys,
    resetKeys,
    resetAll,
    match,
    reload,
  };
}
