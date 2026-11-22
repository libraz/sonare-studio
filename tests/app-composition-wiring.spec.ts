import { describe, expect, it } from 'vitest';
import { readSource } from './helpers/source-text';

const app = readSource('src/App.vue');
const main = readSource('src/main.ts');

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
      'exportMxlAction',
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
    expect(app).toMatch(/\}\s*=\s*useAppShortcutsMenu\(\{/);
    expect(app).toContain(':layout-menu="layoutMenu"');
  });

  it('connects startup, update durability, global input cleanup, and start-screen actions', () => {
    expect(app).toContain('installPwaReloadPreparation(flushBeforeUpdate)');
    expect(app).toContain('hasLiveDocument: () => store.initialized && !startScreenOpen.value');
    expect(app).toContain('flushAutosave: flushOnExit');
    expect(app).toContain('useAppLifecycle({');
    expect(app).toContain('onGlobalKeyDown,');
    expect(app).toContain('onWindowPointerDown,');
    expect(app).toContain('@import-backup="importBrowserBackupAction"');
    expect(app).toContain('@export-backup="exportBrowserBackupAction"');
    expect(app).toContain('@import-midi="importMidiAction"');
  });

  it('keeps the shared error surface persistent so autosave data-loss warnings remain visible', () => {
    expect(app).toContain("const autosaveErrorMessage = ref('');");
    expect(app).toContain('watch(autosave.lastError, (error) => {');
    expect(app).toContain('if (error) autosaveErrorMessage.value = t.value.shell.autosaveFailed;');
    expect(app).toContain(':message="autosaveErrorMessage"');
    expect(app).toContain(':auto-dismiss-ms="0"');
    expect(app).toContain('@dismiss="autosaveErrorMessage = \'\'"');
  });

  it('routes header undo and redo failures into the same visible error surface', () => {
    expect(app).toContain('function onUndo(): void {');
    expect(app).toContain('function onRedo(): void {');
    expect(app).toContain('errorMessage.value = describeError(error, t.value.notices.errors);');
    expect(app).toContain('@undo="onUndo"');
    expect(app).toContain('@redo="onRedo"');
  });

  it('gives the control surface the session state its lamps and buttons need', () => {
    expect(app).toContain('rewind: () => seekToStart(),');
    expect(app).toContain('toggleTrackArm: (trackId: number) => {');
    expect(app).toContain('selectTrack: (trackId: number) => {');
    expect(app).toContain('recordingActive: isRecording,');
    expect(app).toContain('isRecording,');
    expect(app).toContain('isLooping: loopEnabled,');
    expect(app).toContain('armedTrackIds,');
    expect(app).toContain(':surface="controlSurface"');
  });
});
