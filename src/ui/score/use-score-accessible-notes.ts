/**
 * Accessible mirror of the engraved score: the note occurrences the current
 * engraving shows, as navigator items, and their activate/annotate actions.
 */

import { computed } from 'vue';
import { useNoteNames } from '@/composables/useNoteNames';
import { setActiveClip, setSelection } from '@/project/commands';
import { projectMidiNoteOccurrences } from '@/project/midi-projection';
import type { useProjectStore } from '@/project/store';
import { clipKind } from '@/project/types';
import type { AccessibleObjectItem } from '@/ui/accessibility/object-navigation';
import { formatMessage, useI18n } from '@/ui/i18n';

type ProjectStore = ReturnType<typeof useProjectStore>;

/** One source-note occurrence mirrored by the engraving. */
export interface AccessibleScoreSource {
  item: AccessibleObjectItem;
  clipId: number;
  noteId: number;
  occurrence: number;
  startPpq: number;
}

/** Configuration for {@link useScoreAccessibleNotes}. */
export interface UseScoreAccessibleNotesOptions {
  /** The project store (clips, tracks and selection). */
  store: ProjectStore;
  /** True while the full-score engraving covers every clip in the window. */
  getFullScoreEnabled: () => boolean;
  /** Clip length of the engraved window in PPQ. */
  getScreenClipLengthPpq: () => number;
  /** Requests a transport seek to an absolute PPQ position. */
  seek: (ppq: number) => void;
  /** Opens the annotation palette on a note of a clip. */
  openPalette: (noteId: number, clipId: number) => void;
}

/**
 * Creates the accessible note list of one score panel.
 *
 * @param options - The store, window getters and palette hook.
 * @returns The occurrences, the navigator items and the activate/annotate actions.
 */
export function useScoreAccessibleNotes(options: UseScoreAccessibleNotesOptions) {
  const { store, getFullScoreEnabled, getScreenClipLengthPpq, seek, openPalette } = options;
  const { t } = useI18n();
  const { formatPitch } = useNoteNames();

  /** Source-note occurrences mirrored by the current active/full-score engraving. */
  const accessibleScoreSources = computed<AccessibleScoreSource[]>(() => {
    const windowStart = store.clipStartPpq;
    const windowEnd = windowStart + getScreenClipLengthPpq();
    const clips = getFullScoreEnabled()
      ? store.clips.filter(
          (clip) =>
            clipKind(clip) === 'midi' &&
            clip.startPpq < windowEnd &&
            clip.startPpq + clip.lengthPpq > windowStart,
        )
      : store.activeClip && clipKind(store.activeClip) === 'midi'
        ? [store.activeClip]
        : [];
    return clips
      .flatMap((clip) => {
        const trackName =
          store.tracks.find((track) => track.id === clip.trackId)?.name ?? clip.name;
        return projectMidiNoteOccurrences(clip)
          .filter(
            (note) => note.startPpq < windowEnd && note.startPpq + note.durationPpq > windowStart,
          )
          .map((note) => ({
            item: {
              id: `score-${clip.id}-${note.id}-${note.sourceIdentity.occurrence}`,
              label: formatMessage(t.value.shell.score.accessibility.note, {
                track: trackName,
                pitch: formatPitch(note.pitch),
                start: note.startPpq.toFixed(2),
                length: note.durationPpq.toFixed(2),
              }),
              selected: clip.id === store.clipId && store.selection.has(note.id),
            },
            clipId: clip.id,
            noteId: note.id,
            occurrence: note.sourceIdentity.occurrence,
            startPpq: note.startPpq,
          }));
      })
      .sort(
        (a, b) =>
          a.startPpq - b.startPpq ||
          a.clipId - b.clipId ||
          a.noteId - b.noteId ||
          a.occurrence - b.occurrence,
      );
  });

  const accessibleScoreItems = computed(() =>
    accessibleScoreSources.value.map((source) => source.item),
  );

  function accessibleScoreSource(id: string): AccessibleScoreSource | undefined {
    return accessibleScoreSources.value.find((source) => source.item.id === id);
  }

  function activateAccessibleScoreNote(id: string): void {
    const source = accessibleScoreSource(id);
    if (!source) return;
    if (source.clipId !== store.clipId) setActiveClip(source.clipId);
    setSelection([source.noteId]);
    seek(source.startPpq);
  }

  function annotateAccessibleScoreNote(id: string): void {
    const source = accessibleScoreSource(id);
    if (!source) return;
    activateAccessibleScoreNote(id);
    openPalette(source.noteId, source.clipId);
  }

  return {
    accessibleScoreSources,
    accessibleScoreItems,
    activateAccessibleScoreNote,
    annotateAccessibleScoreNote,
  };
}
