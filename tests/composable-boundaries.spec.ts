import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const downloadMocks = vi.hoisted(() => ({
  downloadBlob: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn<(options: unknown) => Promise<boolean>>(),
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

    popovers.onWindowPointerDown({ target: document.createElement('button') } as PointerEvent);
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeSecond).not.toHaveBeenCalled();

    closeFirst.mockClear();
    inside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    popovers.onWindowPointerDown({ target: inside } as PointerEvent);
    expect(closeFirst).not.toHaveBeenCalled();
  });
});

describe('useActionGuards', () => {
  it('honors the destructive-action preference and reports failed actions', async () => {
    const busy = ref(false);
    const errorMessage = ref('old error');
    const appSettings = { settings: { confirmDestructive: true } };
    dialogMocks.confirmDialog.mockResolvedValue(true);
    const guards = useActionGuards({ appSettings: appSettings as never, busy, errorMessage });

    await expect(guards.confirmAction('Delete', { confirmLabel: 'Remove' })).resolves.toBe(true);
    expect(dialogMocks.confirmDialog).toHaveBeenCalledWith({
      title: undefined,
      message: 'Delete',
      danger: true,
      confirmLabel: 'Remove',
    });

    await guards.runAction(async () => {
      throw new Error('write failed');
    });
    expect(errorMessage.value).toContain('write failed');
    expect(busy.value).toBe(false);

    (appSettings.settings as { confirmDestructive: boolean }).confirmDestructive = false;
    await expect(guards.confirmAction('Skip dialog')).resolves.toBe(true);
    expect(dialogMocks.confirmDialog).toHaveBeenCalledTimes(1);
  });

  it('does not start a second action while the first one is busy', async () => {
    const busy = ref(true);
    const action = vi.fn(async () => {});
    const guards = useActionGuards({
      appSettings: { settings: { confirmDestructive: false } } as never,
      busy,
      errorMessage: ref(''),
    });

    await guards.runAction(action);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('useShellPanels', () => {
  function createPanels() {
    const persistArrangeHeight = vi.fn();
    const persistDeviceRackOpen = vi.fn();
    const persistDockCollapsed = vi.fn();
    const panels = useShellPanels({
      errorMessage: ref(''),
      layoutBindings: {} as never,
      persistArrangeHeight,
      persistDeviceRackOpen,
      persistDockCollapsed,
    });
    return { panels, persistArrangeHeight, persistDeviceRackOpen, persistDockCollapsed };
  }

  it('persists only successfully applied named layouts', () => {
    const { panels, persistArrangeHeight, persistDeviceRackOpen, persistDockCollapsed } =
      createPanels();
    panels.layoutMenuOpen.value = true;
    layoutMocks.apply.mockReturnValue(false);

    panels.applyNamedLayout('missing');
    expect(panels.layoutMenuOpen.value).toBe(false);
    expect(layoutMocks.apply).toHaveBeenCalledWith('missing', expect.anything());
    expect(persistArrangeHeight).not.toHaveBeenCalled();

    layoutMocks.apply.mockReturnValue(true);
    panels.applyNamedLayout('Wide');
    expect(layoutMocks.apply).toHaveBeenLastCalledWith('Wide', expect.anything());
    expect(persistArrangeHeight).toHaveBeenCalledTimes(1);
    expect(persistDeviceRackOpen).toHaveBeenCalledTimes(1);
    expect(persistDockCollapsed).toHaveBeenCalledTimes(1);
  });

  it('surfaces a localized error when saving a layout is rejected', async () => {
    const errorMessage = ref('');
    const panels = useShellPanels({
      errorMessage,
      layoutBindings: {} as never,
      persistArrangeHeight: vi.fn(),
      persistDeviceRackOpen: vi.fn(),
      persistDockCollapsed: vi.fn(),
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
