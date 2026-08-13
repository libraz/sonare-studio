import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AboutDialog from '@/components/shell/AboutDialog.vue';
import { formatBuildTime } from '@/lib/build-info';
import { formatTimestamp } from '@/lib/date-format';

// The build stamp is injected by Vite defines, which are absent under Vitest,
// so the dialog reads it through a module the test replaces.
vi.mock('@/lib/build-info', async () => {
  const actual = await vi.importActual<typeof import('@/lib/build-info')>('@/lib/build-info');
  return {
    ...actual,
    APP_VERSION: '1.2.3',
    BUILD_COMMIT: 'abc1234',
    BUILD_TIME: '2026-08-05T04:30:00.000Z',
  };
});

// AppModal teleports its content to <body>, so the dialog is queried through
// the document rather than the wrapper.
let wrapper: VueWrapper | null = null;

function open(): void {
  wrapper = mount(AboutDialog, {
    props: { open: true, version: '0.9.5', isolated: true },
    attachTo: document.body,
  });
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('formatBuildTime', () => {
  it('renders the stamp in the viewer time zone for the active locale', () => {
    const formatted = formatBuildTime('2026-08-05T04:30:00.000Z', 'en');
    expect(formatted).not.toBe('');
    expect(formatted).toBe(
      formatTimestamp(new Date('2026-08-05T04:30:00.000Z'), 'en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    );
  });

  it('reports nothing for a missing or unparseable stamp', () => {
    expect(formatBuildTime('', 'en')).toBe('');
    expect(formatBuildTime('not-a-date', 'en')).toBe('');
  });
});

describe('About dialog build stamp', () => {
  it('shows the app version, its commit, and the build time', () => {
    open();
    const text = document.body.textContent ?? '';
    expect(text).toContain('1.2.3');
    expect(text).toContain('abc1234');
    // The stamp is localized, so only its year is stable across languages.
    expect(text).toContain('2026');
  });
});

describe('build stamp wiring', () => {
  it('injects the version, commit, and build time from the Vite config', async () => {
    const config = await readFile(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    expect(config).toContain('__SONARE_APP_VERSION__');
    expect(config).toContain('__SONARE_BUILD_COMMIT__');
    expect(config).toContain('__SONARE_BUILD_TIME__');
    // Cloudflare Pages is the deploy path, and it exposes only the full SHA.
    expect(config).toContain('CF_PAGES_COMMIT_SHA');
  });
});
