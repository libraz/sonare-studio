/**
 * Promise-based replacement for window.alert / confirm / prompt.
 *
 * A single module-level queue holds pending requests; `DialogHost.vue` (mounted
 * once in the shell) renders the front request as a frosted-glass modal and
 * settles its promise on the user's choice. Any module can therefore ask the
 * user a question with `await confirmDialog(...)` without importing a component
 * or threading state through the tree.
 */

import { reactive } from 'vue';
import { useI18n } from '@/ui/i18n';

/** Shared option bag for the confirm / alert variants. */
export interface ConfirmOptions {
  /** Heading shown at the top of the dialog. */
  title?: string;
  /** Body message (plain text; rendered with preserved line breaks). */
  message: string;
  /** Label for the confirming action. */
  confirmLabel?: string;
  /** Label for the cancelling action. */
  cancelLabel?: string;
  /** Render the confirm button as a destructive (red) action. */
  danger?: boolean;
}

/** Options for the text-input prompt variant. */
export interface PromptOptions {
  title?: string;
  message: string;
  /** Pre-filled value. */
  defaultValue?: string;
  /** Greyed-out hint shown when the field is empty. */
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

type Resolver = (value: boolean | string | null) => void;

/** Internal queued request as consumed by the host. */
export interface DialogRequest {
  id: number;
  kind: 'alert' | 'confirm' | 'prompt';
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  defaultValue: string;
  placeholder: string;
  resolve: Resolver;
}

/** Reactive FIFO queue; the host renders `queue[0]`. */
export const dialogQueue = reactive<DialogRequest[]>([]);

let nextId = 1;

function enqueue(partial: Omit<DialogRequest, 'id'>): void {
  dialogQueue.push({ ...partial, id: nextId++ });
}

/**
 * Asks the user to confirm an action.
 *
 * @returns Promise resolving true when confirmed, false when cancelled.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const { t } = useI18n();
  return new Promise((resolve) => {
    enqueue({
      kind: 'confirm',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? t.value.dialogs.common.ok,
      cancelLabel: options.cancelLabel ?? t.value.dialogs.common.cancel,
      danger: options.danger ?? false,
      defaultValue: '',
      placeholder: '',
      resolve: (value) => resolve(value === true),
    });
  });
}

/**
 * Shows an informational message with a single dismiss button.
 */
export function alertDialog(options: ConfirmOptions): Promise<void> {
  const { t } = useI18n();
  return new Promise((resolve) => {
    enqueue({
      kind: 'alert',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? t.value.dialogs.common.ok,
      cancelLabel: '',
      danger: options.danger ?? false,
      defaultValue: '',
      placeholder: '',
      resolve: () => resolve(),
    });
  });
}

/**
 * Asks the user for a line of text.
 *
 * @returns Promise resolving the entered string, or null if cancelled.
 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  const { t } = useI18n();
  return new Promise((resolve) => {
    enqueue({
      kind: 'prompt',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? t.value.dialogs.common.ok,
      cancelLabel: options.cancelLabel ?? t.value.dialogs.common.cancel,
      danger: false,
      defaultValue: options.defaultValue ?? '',
      placeholder: options.placeholder ?? '',
      resolve: (value) => resolve(typeof value === 'string' ? value : null),
    });
  });
}

/** Settles the front request and removes it from the queue. */
export function resolveDialog(id: number, value: boolean | string | null): void {
  const index = dialogQueue.findIndex((request) => request.id === id);
  if (index === -1) return;
  const [request] = dialogQueue.splice(index, 1);
  request.resolve(value);
}
