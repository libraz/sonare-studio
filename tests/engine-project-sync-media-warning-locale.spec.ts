import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useEngineProjectSync } from '@/composables/useEngineProjectSync';
import type { StripSync } from '@/engine/strip-sync';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import { DEFAULT_APP_SETTINGS } from '@/ui/settings/app-settings';
import { fakeMidiSync, fakeMixerSync } from './fakes/engine';

vi.mock('@/lib/wasm', async () => {
  const { createFakeWasmModule } = await import('./fake-wasm');
  return { ensureWasm: async () => createFakeWasmModule() };
});

describe('useEngineProjectSync media warning', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAppSettings().set('language', 'ja');
  });

  afterEach(() => {
    useAppSettings().set('language', DEFAULT_APP_SETTINGS.language);
  });

  it('introduces the missing-media report in the active language', async () => {
    const store = useProjectStore();
    store.dispose();
    await store.init();
    store.tracks = [
      {
        id: 7,
        name: 'Track 7',
        color: '#60a5fa',
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        order: 7,
        instrument: { kind: 'sf2', fontId: 'missing-font' },
      },
    ];
    const midiSync = fakeMidiSync({
      sync: vi.fn(async () => undefined),
      mediaIssues: () => [
        {
          kind: 'soundfont',
          mediaId: 'missing-font',
          role: 'instrument',
          reason: 'unreadable',
          trackId: 7,
        },
      ],
    });
    const mediaWarning = ref('');
    const scope = effectScope();
    const projectSync = scope.run(() =>
      useEngineProjectSync({
        bridge: shallowRef(null),
        scope: shallowRef(null),
        errorMessage: ref(''),
        mediaWarning,
        handle: shallowRef(null),
        transport: { setTempoMap: vi.fn(), setTempo: vi.fn() } as never,
      }),
    );
    if (!projectSync) throw new Error('effect scope did not run');
    projectSync.setEngineSyncHandles({
      mixerSync: fakeMixerSync({ sync: vi.fn(), laneTrackIds: () => [7] }),
      stripSync: { sync: vi.fn(), sceneGeneration: () => 0 } as unknown as StripSync,
      automationSync: null,
      midiSync,
      transportSync: null,
      webMidiOutput: null,
    });

    await projectSync.syncMidiState();

    expect(mediaWarning.value.startsWith(useI18n().t.value.shell.media.missingWarning)).toBe(true);
    expect(mediaWarning.value).toContain('missing-font');
    scope.stop();
  });
});
