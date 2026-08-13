import { type Ref, ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useLayouts } from '@/composables/useLayouts';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type LayoutBindings, localizedLayoutName } from '@/ui/settings/layouts';

interface TourHandle {
  open: () => void;
}

export interface ShellPanelsOptions {
  errorMessage: Ref<string>;
  layoutBindings: LayoutBindings;
  persistArrangeHeight: () => void;
  persistDeviceRackOpen: () => void;
  persistDockCollapsed: () => void;
}

export function useShellPanels(options: ShellPanelsOptions) {
  const settingsOpen = ref(false);
  const aboutOpen = ref(false);
  const diagnosticsOpen = ref(false);
  const helpOpen = ref(false);
  const helpMenuOpen = ref(false);
  const helpMenuRoot = ref<HTMLElement | null>(null);
  const layoutMenuOpen = ref(false);
  const layoutMenuRoot = ref<HTMLElement | null>(null);
  const tourRef = ref<TourHandle | null>(null);
  const namedLayouts = useLayouts();
  const { t } = useI18n();

  function applyNamedLayout(name: string): void {
    layoutMenuOpen.value = false;
    if (!namedLayouts.apply(name, options.layoutBindings)) return;
    options.persistArrangeHeight();
    options.persistDockCollapsed();
    options.persistDeviceRackOpen();
  }

  function saveCurrentLayoutAction(): void {
    layoutMenuOpen.value = false;
    void (async () => {
      const name = await promptDialog({
        title: t.value.dialogs.prompts.saveLayoutTitle,
        message: t.value.dialogs.prompts.saveLayoutMessage,
        placeholder: t.value.dialogs.prompts.layoutNamePlaceholder,
        confirmLabel: t.value.dialogs.prompts.save,
      });
      if (!name) return;
      if (!namedLayouts.saveCurrent(name, options.layoutBindings)) {
        const trimmedName = name.trim();
        options.errorMessage.value = namedLayouts.isPreset(trimmedName)
          ? formatMessage(t.value.dialogs.prompts.builtInLayoutName, {
              name: localizedLayoutName(trimmedName, t.value.settings?.layouts?.presetNames ?? {}),
            })
          : t.value.dialogs.prompts.layoutSaveFailed;
      }
    })();
  }

  function openShortcutsHelp(): void {
    helpMenuOpen.value = false;
    helpOpen.value = true;
  }

  function openWelcomeTour(): void {
    helpMenuOpen.value = false;
    tourRef.value?.open();
  }

  function openAbout(): void {
    helpMenuOpen.value = false;
    aboutOpen.value = true;
  }

  function openDiagnostics(): void {
    helpMenuOpen.value = false;
    diagnosticsOpen.value = true;
  }

  return {
    aboutOpen,
    diagnosticsOpen,
    helpMenuOpen,
    helpMenuRoot,
    helpOpen,
    layoutMenuOpen,
    layoutMenuRoot,
    namedLayouts,
    settingsOpen,
    tourRef,
    applyNamedLayout,
    openAbout,
    openDiagnostics,
    openShortcutsHelp,
    openWelcomeTour,
    saveCurrentLayoutAction,
  };
}
