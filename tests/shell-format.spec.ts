import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RevisionsDialog from '@/components/project/RevisionsDialog.vue';
import AppHeader from '@/components/shell/AppHeader.vue';
import StartScreen from '@/components/shell/StartScreen.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { formatSize, formatTimestamp } from '@/ui/shell/format';

const timestamp = new Date('2026-08-05T04:30:00.000Z');

let wrappers: VueWrapper[] = [];
let previousLanguage: ReturnType<typeof useAppSettings>['settings']['language'];

beforeEach(() => {
  previousLanguage = useAppSettings().settings.language;
  // The test intentionally uses an app locale different from the browser's
  // usual English locale. Display helpers must follow this setting.
  useAppSettings().set('language', 'ja');
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers = [];
  useAppSettings().set('language', previousLanguage);
  document.body.innerHTML = '';
});

describe('shell formatting helpers', () => {
  it('uses the largest binary unit through GB', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 ** 2)).toBe('1.0 MB');
    expect(formatSize(1024 ** 3)).toBe('1.0 GB');
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  it('formats a timestamp with the supplied app locale', () => {
    expect(formatTimestamp(timestamp, 'ja')).toBe(timestamp.toLocaleString('ja'));
    expect(formatTimestamp(timestamp, 'ja')).not.toBe(timestamp.toLocaleString('en-US'));
  });
});

describe('locale-aware timestamp surfaces', () => {
  it('uses the app locale for the start-screen project date', () => {
    const wrapper = mount(StartScreen, {
      props: {
        open: true,
        opfsAvailable: true,
        hasAutosave: false,
        storedProjects: [{ name: 'Song', size: 1024, lastModified: timestamp.getTime() }],
      },
      attachTo: document.body,
    });
    wrappers.push(wrapper);

    const meta = document.body.querySelector('.ss-project-meta')?.textContent ?? '';
    expect(meta).toContain(timestamp.toLocaleDateString('ja'));
    expect(meta).not.toContain(timestamp.toLocaleDateString('en-US'));
  });

  it('uses the app locale for the autosave clock', () => {
    const wrapper = mount(AppHeader, {
      props: {
        autosaveLastSavedAt: timestamp,
        canRedo: false,
        canUndo: false,
        canInstallPwa: false,
        deviceRackOpen: false,
        dirty: false,
        menus: [],
        projectName: 'Song',
        resolvedTheme: 'light',
      },
      attachTo: document.body,
    });
    wrappers.push(wrapper);

    const savedAt = document.body.querySelector('.autosave-state')?.textContent ?? '';
    expect(savedAt).toContain(formatTimestamp(timestamp, 'ja', 'time'));
    expect(savedAt).not.toContain(formatTimestamp(timestamp, 'en-US', 'time'));
  });

  it('uses the app locale for revision timestamps', () => {
    const wrapper = mount(RevisionsDialog, {
      props: {
        open: true,
        revisions: [
          {
            slot: 'revision-one',
            projectName: 'Song',
            label: 'First pass',
            savedAt: timestamp.getTime(),
            size: 1024 ** 2,
          },
        ],
      },
      attachTo: document.body,
    });
    wrappers.push(wrapper);

    const sizes = document.body.querySelectorAll('.stored-size');
    expect(sizes[0]?.textContent).toContain(formatTimestamp(timestamp, 'ja'));
    expect(sizes[0]?.textContent).not.toContain(formatTimestamp(timestamp, 'en-US'));
    expect(sizes[1]?.textContent).toBe('1.0 MB');
  });
});
