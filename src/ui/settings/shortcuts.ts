/**
 * Shortcut action registry, binding resolution, conflict detection and the
 * event matcher used by the shell's keydown handlers.
 *
 * Every keyboard command in the app is declared here once; the shell looks
 * actions up by id instead of hard-coding key tests. User overrides replace
 * an action's default keys wholesale (an empty list unbinds the action).
 */

import { comboMatchesEvent, normalizeComboString } from './key-combo';

/**
 * Where a shortcut is active. 'global' fires regardless of focus; the other
 * scopes correspond to the shell's focus zones (arrangement lane vs editor
 * dock).
 */
export type ShortcutScope = 'global' | 'arrangement' | 'editor';

/** A registered shortcut action. */
export interface ShortcutActionDef {
  /** Stable action id ('edit.undo'). */
  id: string;
  /** Human-readable command name. */
  label: string;
  /** Default key combos in canonical form; multiple combos all trigger the action. */
  defaultKeys: ReadonlyArray<string>;
  /** Scope the shortcut is active in. */
  when: ShortcutScope;
  /** Display group for the cheatsheet/settings table. */
  group: string;
  /** False for fixed, display-only entries (excluded from matching, overrides and conflicts). */
  customizable: boolean;
  /** Free-form key display for non-customizable entries (music typing rows). */
  keysLabel?: string;
}

/** Map of action id to bound combos (after overrides are applied). */
export type ShortcutBindings = ReadonlyMap<string, ReadonlyArray<string>>;

/** Persisted user overrides: action id to replacement combos. */
export type ShortcutOverrides = Readonly<Record<string, ReadonlyArray<string>>>;

/** A binding collision: one combo reachable by several actions at once. */
export interface ShortcutConflict {
  /** The colliding combo in canonical form. */
  keys: string;
  /** Ids of all actions bound to the combo in overlapping scopes. */
  actionIds: ReadonlyArray<string>;
}

/**
 * The full shortcut registry. Order matters: the matcher breaks ties between
 * same-scope candidates by registry order.
 */
export const SHORTCUT_ACTIONS: ReadonlyArray<ShortcutActionDef> = [
  // Transport
  {
    id: 'transport.togglePlayback',
    label: 'Play / Stop',
    defaultKeys: ['space'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.toggleLoop',
    label: 'Toggle loop',
    defaultKeys: ['l'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.toggleRecord',
    label: 'Record',
    defaultKeys: ['r'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.toStart',
    label: 'Go to start',
    defaultKeys: ['home'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.toEnd',
    label: 'Go to end',
    defaultKeys: ['end'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.nudgeBack',
    label: 'Nudge back one bar',
    defaultKeys: [','],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.nudgeForward',
    label: 'Nudge forward one bar',
    defaultKeys: ['.'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.setLeftLocator',
    label: 'Set left locator',
    defaultKeys: ['['],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  {
    id: 'transport.setRightLocator',
    label: 'Set right locator',
    defaultKeys: [']'],
    when: 'global',
    group: 'Transport',
    customizable: true,
  },
  // Project
  {
    id: 'project.save',
    label: 'Save project',
    defaultKeys: ['mod+s'],
    when: 'global',
    group: 'Project',
    customizable: true,
  },
  {
    id: 'project.saveAs',
    label: 'Save project as…',
    defaultKeys: ['mod+shift+s'],
    when: 'global',
    group: 'Project',
    customizable: true,
  },
  {
    id: 'project.open',
    label: 'Open project',
    defaultKeys: ['mod+o'],
    when: 'global',
    group: 'Project',
    customizable: true,
  },
  // Editing
  {
    id: 'edit.undo',
    label: 'Undo',
    defaultKeys: ['mod+z'],
    when: 'global',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    defaultKeys: ['mod+shift+z'],
    when: 'global',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.selectAllNotes',
    label: 'Select all notes',
    defaultKeys: ['mod+a'],
    when: 'global',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.quantizeSelection',
    label: 'Quantize selection',
    defaultKeys: ['q'],
    when: 'global',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.deleteSelectedNotes',
    label: 'Delete selected notes',
    defaultKeys: ['backspace', 'delete'],
    when: 'editor',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.transposeUp',
    label: 'Transpose up a semitone',
    defaultKeys: ['shift+arrowup'],
    when: 'editor',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.transposeDown',
    label: 'Transpose down a semitone',
    defaultKeys: ['shift+arrowdown'],
    when: 'editor',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.transposeOctaveUp',
    label: 'Transpose up an octave',
    defaultKeys: ['mod+shift+arrowup'],
    when: 'editor',
    group: 'Editing',
    customizable: true,
  },
  {
    id: 'edit.transposeOctaveDown',
    label: 'Transpose down an octave',
    defaultKeys: ['mod+shift+arrowdown'],
    when: 'editor',
    group: 'Editing',
    customizable: true,
  },
  // Arrangement
  {
    id: 'arrange.duplicateClip',
    label: 'Duplicate clip',
    defaultKeys: ['mod+d'],
    when: 'arrangement',
    group: 'Arrangement',
    customizable: true,
  },
  {
    id: 'arrange.splitClipAtPlayhead',
    label: 'Split clip at playhead',
    defaultKeys: ['b'],
    when: 'arrangement',
    group: 'Arrangement',
    customizable: true,
  },
  {
    id: 'arrange.deleteClip',
    label: 'Delete clip',
    defaultKeys: ['backspace', 'delete'],
    when: 'arrangement',
    group: 'Arrangement',
    customizable: true,
  },
  // View
  {
    id: 'view.toggleSnap',
    label: 'Toggle snap',
    defaultKeys: ['mod+g'],
    when: 'global',
    group: 'View',
    customizable: true,
  },
  {
    id: 'view.toggleScorePanel',
    label: 'Toggle score panel',
    defaultKeys: ['mod+e'],
    when: 'global',
    group: 'View',
    customizable: true,
  },
  // Tools
  {
    id: 'tool.select',
    label: 'Select tool',
    defaultKeys: ['1'],
    when: 'global',
    group: 'Tools',
    customizable: true,
  },
  {
    id: 'tool.draw',
    label: 'Draw tool',
    defaultKeys: ['2'],
    when: 'global',
    group: 'Tools',
    customizable: true,
  },
  {
    id: 'tool.split',
    label: 'Split tool',
    defaultKeys: ['3'],
    when: 'global',
    group: 'Tools',
    customizable: true,
  },
  {
    id: 'tool.erase',
    label: 'Erase tool',
    defaultKeys: ['4'],
    when: 'global',
    group: 'Tools',
    customizable: true,
  },
  // App
  {
    id: 'app.settings',
    label: 'Open settings',
    defaultKeys: ['mod+,'],
    when: 'global',
    group: 'Application',
    customizable: true,
  },
  {
    id: 'help.shortcuts',
    label: 'Show shortcut help',
    defaultKeys: ['?'],
    when: 'global',
    group: 'Application',
    customizable: true,
  },
  // Fixed, display-only entries (shown in the cheatsheet, never remapped).
  {
    id: 'editor.cancelGesture',
    label: 'Cancel drag gesture',
    defaultKeys: ['escape'],
    when: 'editor',
    group: 'Editing',
    customizable: false,
  },
  {
    id: 'typing.notes',
    label: 'Music typing: play notes (C and up)',
    defaultKeys: [],
    when: 'global',
    group: 'Music typing',
    customizable: false,
    keysLabel: 'A W S E D F T G Y H U J K',
  },
  {
    id: 'typing.octave',
    label: 'Music typing: octave down / up',
    defaultKeys: [],
    when: 'global',
    group: 'Music typing',
    customizable: false,
    keysLabel: 'Z / X',
  },
  {
    id: 'typing.velocity',
    label: 'Music typing: velocity down / up',
    defaultKeys: [],
    when: 'global',
    group: 'Music typing',
    customizable: false,
    keysLabel: 'C / V',
  },
  {
    id: 'typing.rest',
    label: 'Music typing: insert rest (step input)',
    defaultKeys: [],
    when: 'global',
    group: 'Music typing',
    customizable: false,
    keysLabel: 'Tab',
  },
];

/** Looks up a registry entry by id. */
export function getShortcutAction(id: string): ShortcutActionDef | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id);
}

/**
 * Resolves effective bindings from user overrides.
 *
 * Combos are normalized to canonical form; unparseable combos and overrides
 * for unknown or non-customizable actions are dropped.
 *
 * @param overrides Persisted user overrides (may be empty).
 * @returns Action id to effective combo list, in registry order.
 */
export function resolveBindings(overrides: ShortcutOverrides = {}): ShortcutBindings {
  const bindings = new Map<string, ReadonlyArray<string>>();
  for (const action of SHORTCUT_ACTIONS) {
    const override = action.customizable ? overrides[action.id] : undefined;
    const source = override ?? action.defaultKeys;
    const keys: string[] = [];
    for (const text of source) {
      const canonical = normalizeComboString(text);
      if (canonical !== null && !keys.includes(canonical)) keys.push(canonical);
    }
    bindings.set(action.id, keys);
  }
  return bindings;
}

/** True when two scopes can both be active for one event. */
function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === b || a === 'global' || b === 'global';
}

/**
 * Finds combos bound to more than one action in overlapping scopes.
 *
 * Disjoint scopes (arrangement vs editor) may legitimately share a combo and
 * are not reported. Non-customizable entries never participate.
 *
 * @param bindings Effective bindings from {@link resolveBindings}.
 * @returns One entry per colliding combo, with every involved action id.
 */
export function findConflicts(bindings: ShortcutBindings): ShortcutConflict[] {
  const byCombo = new Map<string, { id: string; when: ShortcutScope }[]>();
  for (const action of SHORTCUT_ACTIONS) {
    if (!action.customizable) continue;
    for (const keys of bindings.get(action.id) ?? []) {
      const list = byCombo.get(keys) ?? [];
      list.push({ id: action.id, when: action.when });
      byCombo.set(keys, list);
    }
  }
  const conflicts: ShortcutConflict[] = [];
  for (const [keys, owners] of byCombo) {
    if (owners.length < 2) continue;
    const ids = new Set<string>();
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        if (scopesOverlap(owners[i].when, owners[j].when)) {
          ids.add(owners[i].id);
          ids.add(owners[j].id);
        }
      }
    }
    if (ids.size >= 2) conflicts.push({ keys, actionIds: [...ids] });
  }
  return conflicts;
}

/**
 * Matches a keydown event against the bindings for a focus scope.
 *
 * Candidates are customizable actions whose scope is `scope` or 'global';
 * a scope-specific match wins over a global one, and ties within the same
 * scope resolve in registry order. The caller decides preventDefault and may
 * re-match with another scope to implement fall-through (e.g. delete falls
 * back from clip to notes).
 *
 * @param event The keydown event.
 * @param scope The currently focused zone.
 * @param bindings Effective bindings from {@link resolveBindings}.
 * @returns The matched action id, or null.
 */
export function matchShortcut(
  event: KeyboardEvent,
  scope: ShortcutScope,
  bindings: ShortcutBindings,
): string | null {
  let globalMatch: string | null = null;
  for (const action of SHORTCUT_ACTIONS) {
    if (!action.customizable) continue;
    if (action.when !== scope && action.when !== 'global') continue;
    const keys = bindings.get(action.id) ?? [];
    if (!keys.some((combo) => comboMatchesEvent(combo, event))) continue;
    if (action.when === scope) return action.id;
    if (globalMatch === null) globalMatch = action.id;
  }
  return globalMatch;
}
