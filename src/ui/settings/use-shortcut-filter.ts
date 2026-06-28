/**
 * Search/category filtering and conflict-set derivation for the shortcuts
 * settings table. Pure reactive logic over the shortcut registry and the
 * active locale; no DOM or component dependency.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import type { UseShortcutsReturn } from '@/composables/useShortcuts';
import type { Messages } from '@/ui/i18n';
import { formatKeyCombo, type Platform } from './key-combo';
import type { ShortcutActionDef } from './shortcuts';

/** Reactive label helpers and filtered views for the shortcuts table. */
export interface ShortcutFilter {
  /** The distinct action groups, in registry order, for the category picker. */
  groups: ComputedRef<string[]>;
  /** Category-filter choices: "All categories" plus each distinct group. */
  groupOptions: ComputedRef<ReadonlyArray<{ value: string; label: string }>>;
  /** Actions matching the active category and query, in registry order. */
  visible: ComputedRef<ReadonlyArray<ShortcutActionDef>>;
  /** Ids of all actions involved in a binding conflict. */
  conflictActionIds: ComputedRef<ReadonlySet<string>>;
  /** Display string for an action's current keys (or its fixed label). */
  keysText(action: ShortcutActionDef): string;
  /** Localized command name for an action. */
  actionLabel(action: ShortcutActionDef): string;
  /** Localized name for an action group. */
  groupLabel(group: string): string;
}

/**
 * Builds the reactive filtering and labelling helpers for the shortcuts table.
 *
 * @param shortcuts The shared shortcut registry composable.
 * @param t The active locale messages ref.
 * @param platform The display platform for key formatting.
 * @param query Free-text filter over label, group and current keys.
 * @param group Selected category id, or 'all' for every group.
 */
export function useShortcutFilter(
  shortcuts: UseShortcutsReturn,
  t: Ref<Messages>,
  platform: Platform,
  query: Ref<string>,
  group: Ref<string>,
): ShortcutFilter {
  function keysText(action: ShortcutActionDef): string {
    if (action.keysLabel !== undefined) return action.keysLabel;
    const keys = shortcuts.keysFor(action.id);
    if (keys.length === 0) return t.value.settings.shortcuts.emptyKeys;
    return keys.map((combo) => formatKeyCombo(combo, platform)).join(' / ');
  }

  function actionLabel(action: ShortcutActionDef): string {
    return (
      t.value.shortcuts.actions[action.id as keyof typeof t.value.shortcuts.actions] ?? action.label
    );
  }

  function groupLabel(name: string): string {
    return t.value.shortcuts.groups[name as keyof typeof t.value.shortcuts.groups] ?? name;
  }

  const groups = computed<string[]>(() => {
    const seen: string[] = [];
    for (const action of shortcuts.actions) {
      if (!seen.includes(action.group)) seen.push(action.group);
    }
    return seen;
  });

  const groupOptions = computed(() => [
    { value: 'all', label: t.value.settings.shortcuts.allCategories },
    ...groups.value.map((name) => ({ value: name, label: groupLabel(name) })),
  ]);

  const visible = computed<ReadonlyArray<ShortcutActionDef>>(() => {
    const needle = query.value.trim().toLowerCase();
    const selected = group.value;
    return shortcuts.actions.filter((action) => {
      if (selected !== 'all' && action.group !== selected) return false;
      if (needle === '') return true;
      const haystack =
        `${actionLabel(action)} ${groupLabel(action.group)} ${keysText(action)}`.toLowerCase();
      return haystack.includes(needle);
    });
  });

  const conflictActionIds = computed<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const conflict of shortcuts.conflicts.value) {
      for (const id of conflict.actionIds) ids.add(id);
    }
    return ids;
  });

  return {
    groups,
    groupOptions,
    visible,
    conflictActionIds,
    keysText,
    actionLabel,
    groupLabel,
  };
}
