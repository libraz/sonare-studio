import { type Ref, ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useLayouts } from '@/composables/useLayouts';
import type { LayoutBindings } from '@/ui/settings/layouts';

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
  const helpOpen = ref(false);
  const helpMenuOpen = ref(false);
  const helpMenuRoot = ref<HTMLElement | null>(null);
  const layoutMenuOpen = ref(false);
  const layoutMenuRoot = ref<HTMLElement | null>(null);
  const tourRef = ref<TourHandle | null>(null);
  const namedLayouts = useLayouts();

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
        title: 'Save layout',
        message: 'Save the current panel arrangement under a name.',
        placeholder: 'Layout name',
        confirmLabel: 'Save',
      });
      if (!name) return;
      if (!namedLayouts.saveCurrent(name, options.layoutBindings)) {
        options.errorMessage.value = namedLayouts.isPreset(name)
          ? `"${name}" is a built-in preset name; choose another.`
          : 'Could not save the layout (too many saved layouts).';
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

  return {
    aboutOpen,
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
    openShortcutsHelp,
    openWelcomeTour,
    saveCurrentLayoutAction,
  };
}
