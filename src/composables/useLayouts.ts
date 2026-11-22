import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { readLocalStorage, writeLocalStorage } from '@/lib/local-storage';
import {
  applyLayoutState,
  captureLayoutState,
  decodeUserLayouts,
  encodeUserLayouts,
  LAYOUT_PRESETS,
  type LayoutBindings,
  MAX_USER_LAYOUTS,
  type NamedLayout,
  type WorkspaceLayoutState,
} from '@/ui/settings/layouts';

/** localStorage key holding the versioned user-layouts envelope. */
export const LAYOUTS_STORAGE_KEY = 'sonare-studio.layouts';

/** Reactive named-layout state and actions returned by {@link useLayouts}. */
export interface UseLayoutsReturn {
  /** Built-in presets (fixed; never renamed or deleted). */
  presets: ReadonlyArray<NamedLayout>;
  /** User-saved layouts, in save order. */
  userLayouts: ComputedRef<ReadonlyArray<NamedLayout>>;
  /** Presets followed by user layouts (names are unique across both). */
  layouts: ComputedRef<ReadonlyArray<NamedLayout>>;
  /** True when the name belongs to a built-in preset. */
  isPreset(name: string): boolean;
  /** Reads the current layout from the shell's refs. */
  capture(bindings: LayoutBindings): WorkspaceLayoutState;
  /** Applies the named layout to the shell's refs. False when unknown. */
  apply(name: string, bindings: LayoutBindings): boolean;
  /**
   * Captures the current layout and saves it under `name` (replacing an
   * existing user layout of the same name) and persists. False when the name
   * is empty, shadows a preset, or the user-layout limit is reached.
   */
  saveCurrent(name: string, bindings: LayoutBindings): boolean;
  /** Deletes a user layout. False when unknown (presets cannot be deleted). */
  remove(name: string): boolean;
  /**
   * Renames a user layout. False when the source is unknown or the target
   * name is empty, a preset name, or an existing user layout.
   */
  rename(currentName: string, nextName: string): boolean;
  /** Re-reads user layouts from storage. */
  reload(): void;
}

/** Reads stored user layouts; corrupt or missing payloads yield none. */
function readStored(): NamedLayout[] {
  return decodeUserLayouts(readLocalStorage(LAYOUTS_STORAGE_KEY));
}

function writeStored(layouts: ReadonlyArray<NamedLayout>): void {
  writeLocalStorage(LAYOUTS_STORAGE_KEY, encodeUserLayouts(layouts));
}

// Single shared state so the settings dialog and the shell agree.
const userLayoutsState: Ref<NamedLayout[]> = ref(readStored());

const userLayouts = computed<ReadonlyArray<NamedLayout>>(() => userLayoutsState.value);
const layouts = computed<ReadonlyArray<NamedLayout>>(() => [
  ...LAYOUT_PRESETS,
  ...userLayoutsState.value,
]);

function findLayout(name: string): NamedLayout | undefined {
  return layouts.value.find((layout) => layout.name === name);
}

/**
 * Vue composable managing named workspace layouts.
 *
 * The shell owns the layout refs and passes them as {@link LayoutBindings};
 * this composable only snapshots and re-applies them. User-saved layouts
 * persist to localStorage. Safe to call outside a component scope.
 */
export function useLayouts(): UseLayoutsReturn {
  const isPreset = (name: string): boolean => LAYOUT_PRESETS.some((preset) => preset.name === name);

  const capture = (bindings: LayoutBindings): WorkspaceLayoutState => captureLayoutState(bindings);

  const apply = (name: string, bindings: LayoutBindings): boolean => {
    const layout = findLayout(name);
    if (layout === undefined) return false;
    applyLayoutState(layout.state, bindings);
    return true;
  };

  const saveCurrent = (name: string, bindings: LayoutBindings): boolean => {
    const trimmed = name.trim();
    if (trimmed === '' || isPreset(trimmed)) return false;
    const state = captureLayoutState(bindings);
    const existing = userLayoutsState.value.findIndex((layout) => layout.name === trimmed);
    if (existing >= 0) {
      const next = [...userLayoutsState.value];
      next[existing] = { name: trimmed, state };
      userLayoutsState.value = next;
    } else {
      if (userLayoutsState.value.length >= MAX_USER_LAYOUTS) return false;
      userLayoutsState.value = [...userLayoutsState.value, { name: trimmed, state }];
    }
    writeStored(userLayoutsState.value);
    return true;
  };

  const remove = (name: string): boolean => {
    const next = userLayoutsState.value.filter((layout) => layout.name !== name);
    if (next.length === userLayoutsState.value.length) return false;
    userLayoutsState.value = next;
    writeStored(userLayoutsState.value);
    return true;
  };

  const rename = (currentName: string, nextName: string): boolean => {
    const trimmed = nextName.trim();
    if (trimmed === '' || isPreset(trimmed)) return false;
    if (trimmed !== currentName && findLayout(trimmed) !== undefined) return false;
    const index = userLayoutsState.value.findIndex((layout) => layout.name === currentName);
    if (index < 0) return false;
    const next = [...userLayoutsState.value];
    next[index] = { name: trimmed, state: next[index].state };
    userLayoutsState.value = next;
    writeStored(userLayoutsState.value);
    return true;
  };

  const reload = (): void => {
    userLayoutsState.value = readStored();
  };

  return {
    presets: LAYOUT_PRESETS,
    userLayouts,
    layouts,
    isPreset,
    capture,
    apply,
    saveCurrent,
    remove,
    rename,
    reload,
  };
}
