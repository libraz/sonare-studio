/**
 * Inline rename of the arrangement track headers: which track is being
 * edited, the draft name and the commit, cancel and IME-aware enter handlers.
 */

import { onBeforeUnmount, type Ref, ref, useTemplateRef } from 'vue';
import { describeError } from '@/lib/errors';
import { renameTrack } from '@/project/commands';
import type { EditorTrack } from '@/project/types';
import { useI18n } from '@/ui/i18n';
import { isImeComposing } from '@/ui/keyboard/ime';

/** Configuration for {@link useTrackRename}. */
export interface UseTrackRenameOptions {
  /** The header list's error banner, set when a rename is rejected. */
  error: Ref<string>;
  /** Header list emit asking the container to scroll the renamed row into view. */
  emit: (event: 'revealTrack', trackId: number) => void;
}

/** Rename state and handlers returned by {@link useTrackRename}. */
export interface TrackRename {
  /** Id of the track being renamed, or -1 when none is. */
  editingTrackId: Ref<number>;
  /** Draft name bound to the rename input. */
  editName: Ref<string>;
  /** Starts renaming a track and focuses its input; frozen tracks surface a banner instead. */
  startRename(track: EditorTrack): void;
  /** Commits the draft name; an empty draft keeps the old name. */
  commitRename(): void;
  /** Commits on Enter unless an IME composition is in progress. */
  onRenameEnter(event: KeyboardEvent): void;
  /** Abandons the rename without committing. */
  cancelRename(): void;
}

/**
 * Creates the inline rename state for one track header list.
 *
 * @param options - The error banner and the reveal emit.
 * @returns The rename state and handlers.
 */
export function useTrackRename(options: UseTrackRenameOptions): TrackRename {
  const { error, emit } = options;
  const { t } = useI18n();

  const editingTrackId = ref<number>(-1);
  const editName = ref('');
  // The host template's ref="nameInput" (an array inside `v-for`).
  const nameInput = useTemplateRef<HTMLInputElement[] | HTMLInputElement>('nameInput');
  let renameFocusFrame: number | null = null;

  function startRename(track: EditorTrack): void {
    if (track.frozen !== undefined) {
      error.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
      return;
    }
    editingTrackId.value = track.id;
    editName.value = track.name;
    emit('revealTrack', track.id);
    if (renameFocusFrame !== null) cancelAnimationFrame(renameFocusFrame);
    // Focus once the input exists in the DOM. preventScroll: the shared
    // scrollY above is the single source of truth for the row's position;
    // the browser's own scrollIntoView-on-focus would otherwise scroll the
    // (overflow-clipped) header list independently of it.
    renameFocusFrame = requestAnimationFrame(() => {
      renameFocusFrame = null;
      const el = nameInput.value;
      const input = Array.isArray(el) ? el[0] : el;
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }

  function commitRename(): void {
    const trackId = editingTrackId.value;
    editingTrackId.value = -1;
    if (trackId < 0) return;
    const name = editName.value.trim();
    if (name.length === 0) return;
    try {
      renameTrack(trackId, name);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  function onRenameEnter(event: KeyboardEvent): void {
    if (isImeComposing(event)) return;
    event.preventDefault();
    commitRename();
  }

  function cancelRename(): void {
    editingTrackId.value = -1;
  }

  onBeforeUnmount(() => {
    if (renameFocusFrame !== null) {
      cancelAnimationFrame(renameFocusFrame);
      renameFocusFrame = null;
    }
  });

  return {
    editingTrackId,
    editName,
    startRename,
    commitRename,
    onRenameEnter,
    cancelRename,
  };
}
