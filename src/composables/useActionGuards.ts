import type { Ref } from 'vue';
import type { useAppSettings } from '@/composables/useAppSettings';
import { confirmDialog } from '@/composables/useDialogs';
import { describeError } from '@/lib/errors';

type AppSettings = ReturnType<typeof useAppSettings>;

export interface ActionGuardsOptions {
  appSettings: AppSettings;
  busy: Ref<boolean>;
  errorMessage: Ref<string>;
}

export function useActionGuards(options: ActionGuardsOptions) {
  const { appSettings, busy, errorMessage } = options;

  function confirmAction(
    message: string,
    opts?: { danger?: boolean; confirmLabel?: string; title?: string },
  ): Promise<boolean> {
    if (!appSettings.settings.confirmDestructive) return Promise.resolve(true);
    return confirmDialog({
      title: opts?.title,
      message,
      danger: opts?.danger ?? true,
      confirmLabel: opts?.confirmLabel ?? 'Continue',
    });
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    errorMessage.value = '';
    try {
      await action();
    } catch (err) {
      errorMessage.value = describeError(err);
    } finally {
      busy.value = false;
    }
  }

  return {
    confirmAction,
    runAction,
  };
}
