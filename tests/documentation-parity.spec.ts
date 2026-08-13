import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT_PRESETS } from '@/ui/settings/layouts';
import { SHORTCUT_ACTIONS } from '@/ui/settings/shortcuts';

const shortcutsDoc = readFileSync(resolve(process.cwd(), 'docs/shortcuts.md'), 'utf8');
const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
const appMenu = readFileSync(
  resolve(process.cwd(), 'src/composables/useAppShortcutsMenu.ts'),
  'utf8',
);

function documentedShortcutActionIds(markdown: string): string[] {
  return [...markdown.matchAll(/<!-- shortcut-action: ([\w.]+) -->/g)].map((match) => match[1]);
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
