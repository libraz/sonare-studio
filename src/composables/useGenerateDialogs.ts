import { type Ref, ref } from 'vue';
import type { TrackGenerateOpenWith } from '@/components/compose/TrackGenerateDialog.vue';
import { editableDrumTracks } from '@/compose/tracks';
import type { TrackPart } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';

export interface GenerateDialogsOptions {
  errorMessage: Ref<string>;
}

/**
 * Open state of the chord, track and key-change generation dialogs (at most
 * one open at a time) and the entry points that pre-focus track generation on
 * a track or arrangement section.
 */
export function useGenerateDialogs(options: GenerateDialogsOptions) {
  const { errorMessage } = options;
  const store = useProjectStore();
  const { t } = useI18n();
  const chordGenerateDialogOpen = ref(false);
  const trackGenerateDialogOpen = ref(false);
  const trackGenerateOpenWith = ref<TrackGenerateOpenWith | null>(null);
  const keyChangeDialogOpen = ref(false);

  /** Opens Flow B (track generation), optionally pre-focused on one part. */
  function openTrackGenerateDialog(openWith: TrackGenerateOpenWith | null = null): void {
    trackGenerateOpenWith.value = openWith;
    chordGenerateDialogOpen.value = false;
    trackGenerateDialogOpen.value = true;
  }

  /** Opens Flow A (chord progression). */
  function openChordGenerateDialog(): void {
    trackGenerateDialogOpen.value = false;
    chordGenerateDialogOpen.value = true;
  }

  /** Opens the key-change detection dialog from the Generate menu. */
  function openKeyChangeDialog(): void {
    trackGenerateDialogOpen.value = false;
    chordGenerateDialogOpen.value = false;
    keyChangeDialogOpen.value = true;
  }

  /** Track-header "regenerate": opens Flow B pre-focused on replacing this track. */
  function onRegenerateTrack(trackId: number, part: TrackPart): void {
    if (store.tracks.find((track) => track.id === trackId)?.frozen !== undefined) {
      errorMessage.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
      return;
    }
    openTrackGenerateDialog({ part, target: { kind: 'replaceTrack', trackId } });
  }

  /** Start a drum variation at exactly the clicked arrangement section. */
  function onRegenerateSectionDrums(sectionId: number): void {
    const section = store.sections.find((entry) => entry.id === sectionId);
    if (!section) return;
    const track = editableDrumTracks(store.tracks, store.clips)[0];
    if (!track) {
      errorMessage.value = t.value.shell.arrangement.regenerateSectionDrumsNoTrack;
      return;
    }
    openTrackGenerateDialog({
      part: 'drums',
      target: {
        kind: 'replaceRange',
        trackId: track.id,
        startPpq: section.startPpq,
        endPpq: section.endPpq,
      },
    });
  }

  return {
    chordGenerateDialogOpen,
    trackGenerateDialogOpen,
    trackGenerateOpenWith,
    keyChangeDialogOpen,
    openTrackGenerateDialog,
    openChordGenerateDialog,
    openKeyChangeDialog,
    onRegenerateTrack,
    onRegenerateSectionDrums,
  };
}
