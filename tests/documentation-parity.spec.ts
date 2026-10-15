import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeComboString } from '@/ui/settings/key-combo';
import { LAYOUT_PRESETS } from '@/ui/settings/layouts';
import { SHORTCUT_ACTIONS, type ShortcutScope } from '@/ui/settings/shortcuts';

const shortcutsDoc = readFileSync(resolve(process.cwd(), 'docs/shortcuts.md'), 'utf8');
const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
const appMenu = readFileSync(
  resolve(process.cwd(), 'src/composables/useAppShortcutsMenu.ts'),
  'utf8',
);

function documentedShortcutActionIds(markdown: string): string[] {
  return [...markdown.matchAll(/<!-- shortcut-action: ([\w.]+) -->/g)].map((match) => match[1]);
}

interface DocumentedBinding {
  id: string;
  keys: string[];
  scope: string;
}

const DOC_SCOPE_TO_SCOPE: Record<string, ShortcutScope> = {
  global: 'global',
  arrangement: 'arrangement',
  'editor dock': 'editor',
};

/** Reads each table row that carries action markers into per-action key lists and a scope. */
function documentedBindings(markdown: string): DocumentedBinding[] {
  const result: DocumentedBinding[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|') || !line.includes('<!-- shortcut-action:')) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const [, keyCell, actionCell, scope] = cells;
    const ids = documentedShortcutActionIds(actionCell);
    const keys = [...keyCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    if (ids.length > 1 && keys.length !== ids.length) {
      throw new Error(`Row key count does not match action count: ${line}`);
    }
    ids.forEach((id, index) => {
      result.push({ id, keys: ids.length === 1 ? keys : [keys[index]], scope });
    });
  }
  return result;
}

describe('documentation parity', () => {
  it('documents every customizable shortcut with a default key', () => {
    const expected = SHORTCUT_ACTIONS.filter(
      (action) => action.customizable && action.defaultKeys.length > 0,
    ).map((action) => action.id);
    const documented = documentedShortcutActionIds(shortcutsDoc);

    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(expected.sort());
    expect(shortcutsDoc).not.toContain('falls back to deleting selected notes');
  });

  it('documents the default key combos and scope of every shortcut', () => {
    const rows = documentedBindings(shortcutsDoc);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === row.id);
      expect(action, row.id).toBeDefined();
      const documentedKeys = row.keys.map((key) => normalizeComboString(key));
      const codeKeys = action?.defaultKeys.map((key) => normalizeComboString(key));
      expect(
        documentedKeys.every((key) => key !== null),
        `${row.id} keys parse`,
      ).toBe(true);
      expect([...documentedKeys].sort(), `${row.id} keys`).toEqual([...(codeKeys ?? [])].sort());
      expect(DOC_SCOPE_TO_SCOPE[row.scope], `${row.id} scope "${row.scope}"`).toBe(action?.when);
    }
  });

  it('keeps README layout and named file capabilities current', () => {
    const layoutLine = readme.split('\n').find((line) => line.includes('workspace layouts'));
    expect(layoutLine).toBeDefined();
    for (const preset of LAYOUT_PRESETS) {
      expect(layoutLine).toContain(preset.name);
    }

    const namedCapabilities = [
      { commandId: 'file.importBackup', readmeText: 'browser backup import/export' },
      { commandId: 'file.exportBackup', readmeText: 'browser backup import/export' },
      { commandId: 'file.exportMidi2', readmeText: 'MIDI 2.0 clip files' },
    ];
    for (const capability of namedCapabilities) {
      expect(appMenu).toContain(`commandItem('${capability.commandId}'`);
      expect(readme.toLowerCase()).toContain(capability.readmeText.toLowerCase());
    }
  });
});
