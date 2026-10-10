import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import StartScreen from '@/components/shell/StartScreen.vue';
import { dismissPwaUpdateNotice, requestPwaAssetRecovery } from '@/pwa';

let wrapper: VueWrapper | null = null;

function open(extra: { booting?: boolean } = {}): VueWrapper {
  wrapper = mount(StartScreen, {
    props: {
      ...extra,
      open: true,
      opfsAvailable: true,
      hasAutosave: false,
      storedProjects: [{ name: 'Song', size: 1024, lastModified: 0 }],
    },
    attachTo: document.body,
  });
  return wrapper;
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

afterEach(() => {
  dismissPwaUpdateNotice();
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('StartScreen', () => {
  it('keeps the version recovery controls inside the launcher focus trap', async () => {
    requestPwaAssetRecovery();
    open();
    await nextTick();
    const dialog = q('[role="dialog"]');
    const notice = dialog?.querySelector('.pwa-update');
    expect(notice?.textContent).toContain('Reload');
    const buttons = notice?.querySelectorAll('button');
    expect(buttons?.[0].disabled).toBe(false);
    buttons?.[1].click();
    await nextTick();
    expect(dialog?.querySelector('.pwa-update')).toBeNull();
  });

  it('keeps the actions in place but inert while the app boots', async () => {
    const w = open({ booting: true });
    const body = (): HTMLElement | null => q('.ss-body');
    expect(body()?.hasAttribute('inert')).toBe(true);
    expect(q('.ss-busy')).not.toBeNull();
    await w.setProps({ booting: false });
    expect(body()?.hasAttribute('inert')).toBe(false);
  });

  it('renders through the shared modal shell', () => {
    open();
    const dialog = q('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('Start screen');
  });

  it('does not dismiss itself on Escape or overlay click', async () => {
    const w = open();
    q('[role="dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    q('.modal-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(w.emitted('close')).toBeUndefined();
    expect(q('[role="dialog"]')).not.toBeNull();
  });

  it('exposes bulk backup actions when OPFS is available', async () => {
    const w = open();

    await q('[data-testid="start-import-backup"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await q('[data-testid="start-export-backup"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    expect(w.emitted('importBackup')).toHaveLength(1);
    expect(w.emitted('exportBackup')).toHaveLength(1);
  });
});
