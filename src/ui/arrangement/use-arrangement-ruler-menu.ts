/**
 * Right-click menu of the arrangement ruler: add a marker, and ripple insert or
 * delete time at the clicked position.
 */

import type { Ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { describeError } from '@/lib/errors';
import { deleteTime, insertTime, setMarker } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { barRangeAt } from '@/ui/arrangement/ruler';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';

/** Configuration for {@link useArrangementRulerMenu}. */
export interface UseArrangementRulerMenuOptions {
  /** Error line shown above the view; actions set it. */
  error: Ref<string>;
}

/** Ruler context-menu handler returned by {@link useArrangementRulerMenu}. */
export interface ArrangementRulerMenu {
  /** Builds and opens the right-click menu for the bar/beat ruler. */
  onRulerContext(payload: { x: number; y: number; ppq: number }): void;
}

/**
 * Creates the right-click ruler menu for one arrangement view.
 *
 * @param options - The shared error line.
 * @returns The context-menu handler.
 */
export function useArrangementRulerMenu(
  options: UseArrangementRulerMenuOptions,
): ArrangementRulerMenu {
  const { error } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  /** Builds and opens the right-click menu for the bar/beat ruler. */
  function onRulerContext(payload: { x: number; y: number; ppq: number }): void {
    const items: ContextMenuItem[] = [
      {
        id: 'marker',
        label: t.value.shell.arrangement.clipActions.addMarker,
        run: () => addMarkerFromPrompt(payload.ppq),
      },
      { id: 'sep-ripple', separator: true },
      {
        id: 'insert-time',
        label: t.value.shell.arrangement.clipActions.insertTime,
        run: () => rippleTimeFromPrompt('insert', payload.ppq),
      },
      {
        id: 'delete-time',
        label: t.value.shell.arrangement.clipActions.deleteTime,
        danger: true,
        run: () => rippleTimeFromPrompt('delete', payload.ppq),
      },
    ];
    openContextMenu(payload.x, payload.y, items);
  }

  /** Adds a marker at a position via a prompt for its name. */
  function addMarkerFromPrompt(ppq: number): void {
    void (async () => {
      const name = await promptDialog({
        title: t.value.shell.arrangement.clipActions.addMarkerTitle,
        message: t.value.shell.arrangement.clipActions.addMarkerMessage,
        defaultValue: t.value.shell.arrangement.clipActions.markerDefaultName,
        placeholder: t.value.shell.arrangement.clipActions.markerName,
        confirmLabel: t.value.shell.arrangement.clipActions.addMarkerConfirm,
      });
      if (name) setMarker(null, ppq, name);
    })();
  }

  /** Prompts for a PPQ duration and performs a ripple insert or delete at the ruler point. */
  function rippleTimeFromPrompt(mode: 'insert' | 'delete', ppq: number): void {
    void (async () => {
      const range = barRangeAt(store.timeSignatures, ppq);
      const defaultLength = String(range.lengthPpq);
      const isInsert = mode === 'insert';
      const lengthText = await promptDialog({
        title: isInsert
          ? t.value.shell.arrangement.clipActions.insertTimeTitle
          : t.value.shell.arrangement.clipActions.deleteTimeTitle,
        message: isInsert
          ? t.value.shell.arrangement.clipActions.insertTimeMessage
          : t.value.shell.arrangement.clipActions.deleteTimeMessage,
        defaultValue: defaultLength,
        placeholder: t.value.shell.arrangement.clipActions.timeLength,
        confirmLabel: isInsert
          ? t.value.shell.arrangement.clipActions.insertTimeConfirm
          : t.value.common.delete,
      });
      if (lengthText === null) return;
      const lengthPpq = Number(lengthText);
      if (!Number.isFinite(lengthPpq) || lengthPpq <= 0) {
        error.value = t.value.shell.arrangement.clipActions.invalidTimeLength;
        return;
      }
      try {
        if (isInsert) insertTime(ppq, lengthPpq);
        else deleteTime(ppq, ppq + lengthPpq);
      } catch (err) {
        error.value = describeError(err, t.value.notices.errors);
      }
    })();
  }

  return { onRulerContext };
}
