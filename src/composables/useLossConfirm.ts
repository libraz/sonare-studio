import { confirmDialog } from '@/composables/useDialogs';
import { formatLossItems, type LossReport } from '@/export/loss-descriptor';
import { formatMessage } from '@/ui/i18n';

/** Localized copy for one format's loss dialog; `message` takes `{items}`. */
export interface LossDialogCopy<K extends string> {
  title: string;
  message: string;
  confirm: string;
  items: Readonly<Record<K, string>>;
}

/** Confirm seam matching the shell's lossy-operation guard. */
export type LossConfirm = (
  message: string,
  opts: { title: string; confirmLabel: string },
) => Promise<boolean>;

const confirmLossDialog: LossConfirm = (message, opts) =>
  confirmDialog({ message, title: opts.title, confirmLabel: opts.confirmLabel, danger: false });

/**
 * The one pre-confirm loss dialog every export and import goes through. An
 * empty report resolves true without asking.
 *
 * @returns Whether the user accepted the listed losses.
 */
export function confirmLossReport<K extends string>(
  report: LossReport<K>,
  copy: LossDialogCopy<K>,
  confirm: LossConfirm = confirmLossDialog,
): Promise<boolean> {
  if (report.entries.length === 0) return Promise.resolve(true);
  const items = formatLossItems(report, copy.items)
    .map((item) => `• ${item}`)
    .join('\n');
  return confirm(formatMessage(copy.message, { items }), {
    title: copy.title,
    confirmLabel: copy.confirm,
  });
}
