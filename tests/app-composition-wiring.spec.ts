import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');

describe('application composition wiring', () => {
  it('boots the App with Pinia, the global directives, and resilient PWA registration', () => {
    expect(main).toContain('createApp(App)');
    expect(main).toContain('.use(createPinia())');
    expect(main).toContain(".directive('tooltip', vTooltip)");
    expect(main).toContain(".directive('radiogroup', vRadioGroup)");
    expect(main).toContain(".directive('tablist', vTabList)");
    expect(main).toContain(".mount('#app')");
    expect(main).toContain('void registerServiceWorker().catch');
  });

  it('connects every project import/export action to the shared shortcut/menu surface', () => {
    for (const action of [
      'exportDawprojectAction',
      'exportBrowserBackupAction',
      'exportMidi2Action',
      'exportMusicXmlAction',
      'exportSmfAction',
      'exportSzdAction',
      'importAudioAction',
      'importBrowserBackupAction',
      'importDawprojectAction',
      'importMusicXmlAction',
      'importMidiAction',
    ]) {
      expect(app).toContain(action);
    }
    expect(app).toContain('} = useAppShortcutsMenu({');
  });

  it('connects startup, update durability, global input cleanup, and start-screen actions', () => {
    expect(app).toContain('installPwaReloadPreparation(async () => {');
    expect(app).toContain('await autosave.saveNow();');
    expect(app).toContain('useAppLifecycle({');
    expect(app).toContain('onGlobalKeyDown,');
    expect(app).toContain('onWindowPointerDown,');
    expect(app).toContain('@import-backup="importBrowserBackupAction"');
    expect(app).toContain('@export-backup="exportBrowserBackupAction"');
    expect(app).toContain('@import-midi="importMidiAction"');
  });
});
