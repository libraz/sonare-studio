import { beforeEach, describe, expect, it } from 'vitest';
import { SHORTCUTS_STORAGE_KEY, useShortcuts } from '@/composables/useShortcuts';
import {
  findConflicts,
  getShortcutAction,
  matchShortcut,
  resolveBindings,
  SHORTCUT_ACTIONS,
} from '@/ui/settings/shortcuts';

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('shortcut registry', () => {
  it('covers the shell inventory', () => {
    const ids = SHORTCUT_ACTIONS.map((action) => action.id);
    for (const expected of [
      'transport.togglePlayback',
      'transport.toggleLoop',
      'project.save',
      'edit.undo',
      'edit.redo',
      'edit.selectAllNotes',
      'edit.quantizeSelection',
      'edit.deleteSelectedNotes',
      'arrange.duplicateClip',
      'arrange.splitClipAtPlayhead',
      'arrange.deleteClip',
      'view.toggleSnap',
      'view.toggleScorePanel',
      'app.settings',
      'help.shortcuts',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('has unique action ids', () => {
    const ids = SHORTCUT_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('binds the project and locator commands to conflict-free defaults', () => {
    const bindings = resolveBindings();
    expect(bindings.get('project.open')).toEqual(['mod+o']);
    expect(bindings.get('project.saveAs')).toEqual(['mod+shift+s']);
    expect(bindings.get('transport.setLeftLocator')).toEqual(['[']);
    expect(bindings.get('transport.setRightLocator')).toEqual([']']);
    expect(findConflicts(bindings)).toEqual([]);
  });

  it('matches the new project and locator combos', () => {
    const bindings = resolveBindings();
    expect(matchShortcut(keydown({ key: 'o', metaKey: true }), 'editor', bindings)).toBe(
      'project.open',
    );
    expect(
      matchShortcut(keydown({ key: 's', metaKey: true, shiftKey: true }), 'editor', bindings),
    ).toBe('project.saveAs');
    expect(matchShortcut(keydown({ key: '[' }), 'arrangement', bindings)).toBe(
      'transport.setLeftLocator',
    );
    expect(matchShortcut(keydown({ key: ']' }), 'editor', bindings)).toBe(
      'transport.setRightLocator',
    );
  });

  it('looks actions up by id', () => {
    expect(getShortcutAction('edit.undo')?.defaultKeys).toEqual(['mod+z']);
    expect(getShortcutAction('nope')).toBeUndefined();
  });
});

describe('resolveBindings', () => {
  it('returns defaults without overrides', () => {
    const bindings = resolveBindings();
    expect(bindings.get('arrange.duplicateClip')).toEqual(['mod+d']);
    expect(bindings.get('edit.deleteSelectedNotes')).toEqual(['backspace', 'delete']);
  });

  it('applies overrides wholesale and normalizes combos', () => {
    const bindings = resolveBindings({ 'edit.undo': ['Ctrl+Shift+U'] });
    expect(bindings.get('edit.undo')).toEqual(['mod+shift+u']);
  });

  it('drops unparseable override combos and supports unbinding', () => {
    const bindings = resolveBindings({ 'edit.undo': ['garbage+key'], 'edit.redo': [] });
    expect(bindings.get('edit.undo')).toEqual([]);
    expect(bindings.get('edit.redo')).toEqual([]);
  });

  it('ignores overrides for non-customizable actions', () => {
    const bindings = resolveBindings({ 'editor.cancelGesture': ['x'] });
    expect(bindings.get('editor.cancelGesture')).toEqual(['escape']);
  });
});

describe('findConflicts', () => {
  it('reports no conflicts for the default bindings', () => {
    // Backspace/Delete exist in both arrangement and editor scopes, but those
    // scopes are disjoint, so the defaults are conflict-free.
    expect(findConflicts(resolveBindings())).toEqual([]);
  });

  it('reports a global combo colliding with a scoped one', () => {
    const bindings = resolveBindings({ 'arrange.duplicateClip': ['q'] });
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].keys).toBe('q');
    expect([...conflicts[0].actionIds].sort()).toEqual([
      'arrange.duplicateClip',
      'edit.quantizeSelection',
    ]);
  });

  it('reports two global actions on the same combo', () => {
    const bindings = resolveBindings({ 'project.save': ['mod+z'] });
    const conflicts = findConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect([...conflicts[0].actionIds].sort()).toEqual(['edit.undo', 'project.save']);
  });

  it('does not report disjoint-scope sharing', () => {
    // Editor delete and arrangement delete share keys by design.
    const bindings = resolveBindings({
      'arrange.splitClipAtPlayhead': ['n'],
    });
    const conflicts = findConflicts(bindings);
    expect(conflicts.find((c) => c.keys === 'backspace')).toBeUndefined();
  });

  it('reports shifted punctuation that collides under runtime matching', () => {
    const bindings = resolveBindings({
      'help.shortcuts': [],
      'project.open': ['?'],
      'project.save': ['shift+?'],
    });

    const conflicts = findConflicts(bindings);

    expect(conflicts).toHaveLength(1);
    expect([...conflicts[0].actionIds].sort()).toEqual(['project.open', 'project.save']);
  });
});

describe('matchShortcut', () => {
  const bindings = resolveBindings();

  it('matches global actions in any scope', () => {
    expect(matchShortcut(keydown({ key: ' ' }), 'editor', bindings)).toBe(
      'transport.togglePlayback',
    );
    expect(matchShortcut(keydown({ key: 's', metaKey: true }), 'arrangement', bindings)).toBe(
      'project.save',
    );
  });

  it('matches scoped actions only in their scope', () => {
    const event = keydown({ key: 'd', metaKey: true });
    expect(matchShortcut(event, 'arrangement', bindings)).toBe('arrange.duplicateClip');
    expect(matchShortcut(event, 'editor', bindings)).toBeNull();
  });

  it('resolves the same key to different actions per scope', () => {
    const event = keydown({ key: 'Backspace' });
    expect(matchShortcut(event, 'arrangement', bindings)).toBe('arrange.deleteClip');
    expect(matchShortcut(event, 'editor', bindings)).toBe('edit.deleteSelectedNotes');
  });

  it('prefers a scope-specific match over a global one', () => {
    const conflicted = resolveBindings({ 'arrange.duplicateClip': ['q'] });
    expect(matchShortcut(keydown({ key: 'q' }), 'arrangement', conflicted)).toBe(
      'arrange.duplicateClip',
    );
    expect(matchShortcut(keydown({ key: 'q' }), 'editor', conflicted)).toBe(
      'edit.quantizeSelection',
    );
  });

  it('distinguishes undo from redo by shift', () => {
    expect(matchShortcut(keydown({ key: 'z', ctrlKey: true }), 'editor', bindings)).toBe(
      'edit.undo',
    );
    expect(
      matchShortcut(keydown({ key: 'z', ctrlKey: true, shiftKey: true }), 'editor', bindings),
    ).toBe('edit.redo');
  });

  it('returns null for unbound keys and modifier-only events', () => {
    expect(matchShortcut(keydown({ key: 'F9' }), 'editor', bindings)).toBeNull();
    expect(matchShortcut(keydown({ key: 'Shift', shiftKey: true }), 'editor', bindings)).toBeNull();
  });
});

describe('useShortcuts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useShortcuts().resetAll();
  });

  it('persists overrides and reports them', () => {
    const shortcuts = useShortcuts();
    expect(shortcuts.isOverridden('edit.undo')).toBe(false);
    shortcuts.setKeys('edit.undo', ['ctrl+u']);
    expect(shortcuts.keysFor('edit.undo')).toEqual(['mod+u']);
    expect(shortcuts.isOverridden('edit.undo')).toBe(true);
    const stored = JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) ?? '{}');
    expect(stored.overrides['edit.undo']).toEqual(['mod+u']);
  });

  it('matches through user overrides', () => {
    const shortcuts = useShortcuts();
    shortcuts.setKeys('edit.undo', ['mod+u']);
    expect(shortcuts.match(keydown({ key: 'u', metaKey: true }), 'editor')).toBe('edit.undo');
    expect(shortcuts.match(keydown({ key: 'z', metaKey: true }), 'editor')).toBeNull();
  });

  it('resets a single action and all actions', () => {
    const shortcuts = useShortcuts();
    shortcuts.setKeys('edit.undo', ['mod+u']);
    shortcuts.setKeys('edit.redo', ['mod+shift+u']);
    shortcuts.resetKeys('edit.undo');
    expect(shortcuts.keysFor('edit.undo')).toEqual(['mod+z']);
    expect(shortcuts.keysFor('edit.redo')).toEqual(['mod+shift+u']);
    shortcuts.resetAll();
    expect(shortcuts.keysFor('edit.redo')).toEqual(['mod+shift+z']);
  });

  it('exposes reactive conflicts', () => {
    const shortcuts = useShortcuts();
    expect(shortcuts.conflicts.value).toEqual([]);
    shortcuts.setKeys('project.save', ['mod+z']);
    expect(shortcuts.conflicts.value).toHaveLength(1);
  });

  it('ignores setKeys for unknown or fixed actions', () => {
    const shortcuts = useShortcuts();
    shortcuts.setKeys('nope', ['x']);
    shortcuts.setKeys('editor.cancelGesture', ['x']);
    expect(shortcuts.keysFor('editor.cancelGesture')).toEqual(['escape']);
    const stored = JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) ?? '{}');
    expect(stored.overrides ?? {}).toEqual({});
  });

  it('reloads overrides from storage and drops invalid payloads', () => {
    const shortcuts = useShortcuts();
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: {
          'edit.undo': ['ctrl+y', 42, 'garbage+key'],
          unknown: ['x'],
          'editor.cancelGesture': ['x'],
        },
      }),
    );
    shortcuts.reload();
    expect(shortcuts.keysFor('edit.undo')).toEqual(['mod+y']);
    expect(shortcuts.keysFor('editor.cancelGesture')).toEqual(['escape']);

    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, 'not json');
    shortcuts.reload();
    expect(shortcuts.keysFor('edit.undo')).toEqual(['mod+z']);
  });
});
