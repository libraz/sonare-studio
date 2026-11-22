/**
 * Copy and paste of whole insert slots through the slot context menu, backed
 * by a rack-local clipboard.
 */

import type { ComputedRef, Ref } from 'vue';
import { describeError } from '@/lib/errors';
import { cloneJson } from '@/project/clone-json';
import type { MixerStripTarget } from '@/project/commands';
import { replaceInsert } from '@/project/commands';
import type { InsertSlot, MixerStrip } from '@/project/mixer';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { openContextMenu } from '@/ui/menu/context-menu';

/** Configuration for {@link useInsertClipboard}. */
export interface UseInsertClipboardOptions {
  /** Rack props: the strip target a paste replaces into. */
  props: {
    readonly target: MixerStripTarget;
  };
  /** The strip whose inserts the rack shows. */
  strip: ComputedRef<MixerStrip>;
  /** Expanded slot index; a paste expands the replaced slot. */
  expandedIndex: Ref<number | null>;
  /** The rack's error banner, set when a paste is rejected. */
  error: Ref<string>;
}

/** Slot context-menu action returned by {@link useInsertClipboard}. */
export interface InsertClipboard {
  /** Opens the copy/paste context menu for a slot. */
  onSlotContextMenu(index: number, event: MouseEvent): void;
}

/**
 * Creates the copy/paste slot actions of one insert rack.
 *
 * @param options - The rack props, the strip, the expanded slot and the error banner.
 * @returns The slot context-menu opener.
 */
export function useInsertClipboard(options: UseInsertClipboardOptions): InsertClipboard {
  const { props, strip, expandedIndex, error } = options;
  const { t } = useI18n();

  /** Process-local insert clipboard; copied settings are detached from the source slot. */
  let insertClipboard: Omit<InsertSlot, 'id'> | null = null;

  function copySlot(index: number): void {
    const slot = strip.value.inserts[index];
    if (!slot) return;
    const { id: _id, ...copy } = slot;
    insertClipboard = cloneJson(copy);
  }

  function pasteSlot(index: number): void {
    if (!insertClipboard) return;
    try {
      replaceInsert(props.target, index, insertClipboard);
      expandedIndex.value = index;
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  function onSlotContextMenu(index: number, event: MouseEvent): void {
    openContextMenu(event.clientX, event.clientY, [
      { id: 'copy-insert', label: t.value.shell.inserts.copy, run: () => copySlot(index) },
      {
        id: 'paste-insert',
        label: t.value.shell.inserts.paste,
        disabledReason: firstBlock([
          insertClipboard === null,
          t.value.shell.mixer.reasons.noInsertCopied,
        ]),
        run: () => pasteSlot(index),
      },
    ]);
  }

  return { onSlotContextMenu };
}
