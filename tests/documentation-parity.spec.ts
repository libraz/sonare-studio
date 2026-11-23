import { describe, expect, it } from 'vitest';
import { en } from '@/ui/i18n/en';
import { normalizeComboString } from '@/ui/settings/key-combo';
import { LAYOUT_PRESETS } from '@/ui/settings/layouts';
import { SHORTCUT_ACTIONS, type ShortcutScope } from '@/ui/settings/shortcuts';
import { readSource } from './helpers/source-text';

const shortcutsDocs = ['en', 'ja'].map((locale) => ({
  locale,
  text: readSource(`docs/${locale}/shortcuts.md`),
}));
const settingsGuide = readSource('docs/en/offline-and-settings.md');
const filesGuide = readSource('docs/en/files-and-formats.md');
const appMenu = readSource('src/composables/useAppShortcutsMenu.ts');

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
  グローバル: 'global',
  アレンジ: 'arrangement',
  エディタードック: 'editor',
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
  it.each(shortcutsDocs)(
    'documents every customizable shortcut with a default key ($locale)',
    ({ text: shortcutsDoc }) => {
      const expected = SHORTCUT_ACTIONS.filter(
        (action) => action.customizable && action.defaultKeys.length > 0,
      ).map((action) => action.id);
      const documented = documentedShortcutActionIds(shortcutsDoc);

      expect(new Set(documented).size).toBe(documented.length);
      expect(documented.sort()).toEqual(expected.sort());
      expect(shortcutsDoc).not.toContain('falls back to deleting selected notes');
    },
  );

  it.each(shortcutsDocs)(
    'documents the default key combos and scope of every shortcut ($locale)',
    ({ text: shortcutsDoc }) => {
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
    },
  );

  it('names only real layout presets and file commands in the guides', () => {
    const layoutSection = settingsGuide.split('## Workspace layouts')[1]?.split('\n## ')[0] ?? '';
    const layoutNames = [...layoutSection.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(
      (match) => match[1],
    );
    expect(layoutNames.length).toBeGreaterThan(0);
    const presetNames = LAYOUT_PRESETS.map((preset) => preset.name);
    for (const name of layoutNames) expect(presetNames).toContain(name);

    const fileCommands = [
      { commandId: 'file.exportSmf', label: en.shell.project.exportSmf },
      { commandId: 'file.exportMidi2', label: en.shell.project.exportMidi2 },
    ];
    for (const { commandId, label } of fileCommands) {
      expect(appMenu).toContain(`commandItem('${commandId}'`);
      expect(filesGuide).toContain(`**File** > **${label}**`);
    }
  });
});
