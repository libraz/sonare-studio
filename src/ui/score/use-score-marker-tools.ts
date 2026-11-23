/**
 * Lyric and key-signature marker tools of the score panel: the input state, the
 * select options and the edits that write the markers at the edit position.
 */

import { computed, ref } from 'vue';
import { setMarker } from '@/project/commands';
import type { useProjectStore } from '@/project/store';
import { clipMeasureGrid } from '@/project/time-signature';
import { useI18n } from '@/ui/i18n';
import { isImeComposing } from '@/ui/keyboard/ime';
import {
  SCORE_KEY_MODES,
  SCORE_KEY_ROOTS,
  SCORE_LYRIC_SYLLABICS,
  type ScoreKeyMode,
  type ScoreKeyRoot,
  scoreEditPpq,
  scoreKeyMarkerName,
  scoreLyricMarkerName,
} from '@/ui/score/marker-editors';
import type { AccessibleScoreSource } from '@/ui/score/use-score-accessible-notes';

type ProjectStore = ReturnType<typeof useProjectStore>;

/** Tolerance for an edit position sitting exactly on a measure start. */
const MEASURE_EPSILON_PPQ = 1e-6;

/** Configuration for {@link useScoreMarkerTools}. */
export interface UseScoreMarkerToolsOptions {
  /** The project store (clip window and time signatures). */
  store: ProjectStore;
  /** Playhead position in PPQ, when the panel was given one. */
  getPositionPpq: () => number | undefined;
  /** Clip length of the engraved window in PPQ. */
  getScreenClipLengthPpq: () => number;
  /** Source-note occurrences the lyric snaps to. */
  getSources: () => ReadonlyArray<AccessibleScoreSource>;
  /** Runs a score edit, surfacing a thrown error; true when it succeeded. */
  tryScoreEdit: (edit: () => void) => boolean;
  /** Re-engraves the score. */
  transcribe: () => Promise<void>;
}

/**
 * Creates the lyric and key marker tools of one score panel.
 *
 * @param options - The store, position getters and edit helpers.
 * @returns The input refs, the select options and the marker actions.
 */
export function useScoreMarkerTools(options: UseScoreMarkerToolsOptions) {
  const { store, getPositionPpq, getScreenClipLengthPpq, getSources, tryScoreEdit, transcribe } =
    options;
  const { t } = useI18n();

  const lyricInput = ref('');
  const lyricVerseInput = ref(1);
  const lyricSyllabicInput = ref<(typeof SCORE_LYRIC_SYLLABICS)[number]>('single');
  const lyricExtendInput = ref(false);
  const keyRootInput = ref<ScoreKeyRoot>('C');
  const keyModeInput = ref<ScoreKeyMode>('major');

  const keyRootOptions = computed(() =>
    SCORE_KEY_ROOTS.map((root) => ({ value: root, label: root })),
  );
  const keyModeOptions = computed(() =>
    SCORE_KEY_MODES.map((mode) => ({ value: mode, label: t.value.shell.score.keyModes[mode] })),
  );
  const lyricSyllabicOptions = computed(() =>
    SCORE_LYRIC_SYLLABICS.map((value) => ({
      value,
      label: t.value.shell.score.lyricSyllabics[value],
    })),
  );

  function markerEditPpq(): number {
    return scoreEditPpq(getPositionPpq(), store.clipStartPpq, store.clipLengthPpq);
  }

  function nearestLyricOnset(ppq: number): number {
    const sources = getSources();
    if (sources.length === 0) throw new RangeError(t.value.shell.score.lyricNoNote);
    return sources.reduce((nearest, source) =>
      Math.abs(source.startPpq - ppq) < Math.abs(nearest.startPpq - ppq) ? source : nearest,
    ).startPpq;
  }

  function onLyricEnter(event: KeyboardEvent): void {
    if (isImeComposing(event)) return;
    event.preventDefault();
    addLyricMarker();
  }

  function addLyricMarker(): void {
    const edited = tryScoreEdit(() => {
      const name = scoreLyricMarkerName(lyricInput.value, {
        verse: lyricVerseInput.value,
        syllabic: lyricSyllabicInput.value,
        extend: lyricExtendInput.value,
      });
      setMarker(null, nearestLyricOnset(markerEditPpq()), name);
      lyricInput.value = '';
    });
    if (edited) void transcribe();
  }

  function addKeyMarker(): void {
    const edited = tryScoreEdit(() => {
      const editPpq = markerEditPpq();
      const ppq = clipMeasureGrid(
        store.timeSignatures,
        store.clipStartPpq,
        store.clipStartPpq + getScreenClipLengthPpq(),
        store.pickupLengthPpq,
      ).reduce(
        (start, measure) =>
          measure.startPpq <= editPpq + MEASURE_EPSILON_PPQ ? measure.startPpq : start,
        store.clipStartPpq,
      );
      setMarker(null, ppq, scoreKeyMarkerName(keyRootInput.value, keyModeInput.value));
    });
    if (edited) void transcribe();
  }

  return {
    lyricInput,
    lyricVerseInput,
    lyricSyllabicInput,
    lyricExtendInput,
    keyRootInput,
    keyModeInput,
    keyRootOptions,
    keyModeOptions,
    lyricSyllabicOptions,
    onLyricEnter,
    addLyricMarker,
    addKeyMarker,
  };
}
