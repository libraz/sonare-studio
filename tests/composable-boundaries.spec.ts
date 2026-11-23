import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const downloadMocks = vi.hoisted(() => ({
  downloadBlob: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn<(options: unknown) => Promise<boolean>>(),
  confirmDestructive: vi.fn<(options: unknown) => Promise<boolean>>(),
  promptDialog: vi.fn<(options: unknown) => Promise<string | null>>(),
}));

const layoutMocks = vi.hoisted(() => ({
  apply: vi.fn<(name: string, bindings: unknown) => boolean>(),
  isPreset: vi.fn<(name: string) => boolean>(),
  saveCurrent: vi.fn<(name: string, bindings: unknown) => boolean>(),
}));

vi.mock('@/lib/download', () => downloadMocks);
vi.mock('@/composables/useDialogs', () => dialogMocks);
vi.mock('@/composables/useLayouts', () => ({
  useLayouts: () => layoutMocks,
}));
vi.mock('@/ui/i18n', () => ({
  formatMessage: (message: string, values: { name: string }) => `${message}:${values.name}`,
  useI18n: () => ({
    t: {
      value: {
        dialogs: {
          prompts: {
            builtInLayoutName: 'built-in',
            layoutNamePlaceholder: 'layout name',
            layoutSaveFailed: 'save failed',
            save: 'Save',
            saveLayoutMessage: 'Save this layout',
            saveLayoutTitle: 'Save layout',
          },
        },
        reasons: { busy: 'busy' },
        notices: { errors: { engineRejected: 'engine rejected {code}', memoryLimit: {} } },
      },
    },
  }),
}));

import { useActionGuards } from '@/composables/useActionGuards';
import { useFileDownloads } from '@/composables/useFileDownloads';
import { useOutsidePopovers } from '@/composables/useOutsidePopovers';
import { useShellPanels } from '@/composables/useShellPanels';

beforeEach(() => {
  vi.stubEnv('DEV', true);
  downloadMocks.downloadBlob.mockReset();
  dialogMocks.confirmDialog.mockReset();
  dialogMocks.confirmDestructive.mockReset();
  dialogMocks.promptDialog.mockReset();
  layoutMocks.apply.mockReset();
  layoutMocks.isPreset.mockReset();
  layoutMocks.saveCurrent.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useFileDownloads', () => {
  it('delegates the browser download and retains the development inspection value', () => {
    const downloads = useFileDownloads();
    const blob = new Blob(['sonare'], { type: 'text/plain' });

    downloads.downloadBlobFile(blob, 'project.txt');

    expect(downloadMocks.downloadBlob).toHaveBeenCalledWith(blob, 'project.txt');
    expect(downloads.lastDownload()).toEqual({ blob, filename: 'project.txt' });
  });
});

describe('useOutsidePopovers', () => {
  it('closes only open popovers whose roots do not contain the pointer target', () => {
    const root = document.createElement('div');
    const inside = document.createElement('button');
    root.append(inside);
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const popovers = useOutsidePopovers([
      { close: closeFirst, open: ref(true), root: ref(root) },
      { close: closeSecond, open: ref(false), root: ref(document.createElement('div')) },
      { close: vi.fn(), open: ref(true), root: ref(null) },
    ]);

    const pointerDownOn = (target: HTMLElement): void => {
      target.addEventListener('pointerdown', popovers.onWindowPointerDown, { once: true });
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    };

    pointerDownOn(document.createElement('button'));
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeSecond).not.toHaveBeenCalled();

    closeFirst.mockClear();
    inside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    pointerDownOn(inside);
    expect(closeFirst).not.toHaveBeenCalled();
  });
});

describe('useActionGuards', () => {
  it('routes destructive confirmations through the shared gate and reports failed actions', async () => {
    const busy = ref(false);
    const errorMessage = ref('old error');
    dialogMocks.confirmDestructive.mockResolvedValue(true);
    const guards = useActionGuards({ busy, errorMessage });

    await expect(guards.confirmAction('Delete', { confirmLabel: 'Remove' })).resolves.toBe(true);
    expect(dialogMocks.confirmDestructive).toHaveBeenCalledWith({
      title: undefined,
      message: 'Delete',
      danger: undefined,
      confirmLabel: 'Remove',
    });
    expect(dialogMocks.confirmDialog).not.toHaveBeenCalled();

    await guards.runAction(async () => {
      throw new Error('write failed');
    });
    expect(errorMessage.value).toContain('write failed');
    expect(busy.value).toBe(false);

    dialogMocks.confirmDialog.mockResolvedValue(true);
    await expect(guards.confirmLossAction('Explain a lossy export')).resolves.toBe(true);
    expect(dialogMocks.confirmDialog).toHaveBeenLastCalledWith({
      title: undefined,
      message: 'Explain a lossy export',
      danger: false,
      confirmLabel: undefined,
    });
  });

  it('does not start a second action while the first one is busy', async () => {
    const busy = ref(true);
    const action = vi.fn(async () => {});
    const errorMessage = ref('');
    const guards = useActionGuards({ busy, errorMessage });

    await guards.runAction(action);
    expect(action).not.toHaveBeenCalled();
    // The refusal is reported instead of being dropped silently.
    expect(errorMessage.value).toBe('busy');
  });
});

describe('useShellPanels', () => {
  it('closes the layout menu and applies the named layout', () => {
    const panels = useShellPanels({ errorMessage: ref(''), layoutBindings: {} as never });
    panels.layoutMenuOpen.value = true;
    layoutMocks.apply.mockReturnValue(true);

    panels.applyNamedLayout('Wide');
    expect(panels.layoutMenuOpen.value).toBe(false);
    expect(layoutMocks.apply).toHaveBeenLastCalledWith('Wide', expect.anything());
  });

  it('surfaces a localized error when saving a layout is rejected', async () => {
    const errorMessage = ref('');
    const panels = useShellPanels({
      errorMessage,
      layoutBindings: {} as never,
    });
    dialogMocks.promptDialog.mockResolvedValue('Built in');
    layoutMocks.saveCurrent.mockReturnValue(false);
    layoutMocks.isPreset.mockReturnValue(true);

    panels.saveCurrentLayoutAction();
    await Promise.resolve();
    await Promise.resolve();

    expect(layoutMocks.saveCurrent).toHaveBeenCalledWith('Built in', expect.anything());
    expect(errorMessage.value).toBe('built-in:Built in');
  });
});
