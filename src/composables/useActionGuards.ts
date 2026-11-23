import type { Ref } from 'vue';
import { confirmDestructive, confirmDialog } from '@/composables/useDialogs';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/ui/i18n';

export interface ActionGuardsOptions {
  busy: Ref<boolean>;
  errorMessage: Ref<string>;
}

export function useActionGuards(options: ActionGuardsOptions) {
  const { busy, errorMessage } = options;
  const { t } = useI18n();

  function confirmAction(
    message: string,
    opts?: { danger?: boolean; confirmLabel?: string; title?: string },
  ): Promise<boolean> {
    return confirmDestructive({
      title: opts?.title,
      message,
      danger: opts?.danger,
      confirmLabel: opts?.confirmLabel,
    });
  }

  /** Confirms a lossy format operation even when destructive confirmations are off. */
  function confirmLossAction(
    message: string,
    opts?: { danger?: boolean; confirmLabel?: string; title?: string },
  ): Promise<boolean> {
    return confirmDialog({
      title: opts?.title,
      message,
      danger: opts?.danger ?? false,
      confirmLabel: opts?.confirmLabel,
    });
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    if (busy.value) {
      errorMessage.value = t.value.reasons.busy;
      return;
    }
    busy.value = true;
    errorMessage.value = '';
    try {
      await action();
    } catch (err) {
      errorMessage.value = describeError(err, t.value.notices.errors);
    } finally {
      busy.value = false;
    }
  }

  return {
    confirmAction,
    confirmLossAction,
    runAction,
  };
}
