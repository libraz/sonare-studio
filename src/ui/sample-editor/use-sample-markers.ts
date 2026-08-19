/**
 * Marker detection for the sample editor. Owns the overlay marker positions (in
 * frames) and the actions that populate or clear them: transient onsets,
 * silence splitting and pitched note regions. The markers never alter the
 * audio; they snap selection edges and let a click pick the slice between two
 * marks (see the selection composable).
 */

import { nextTick, type Ref, ref } from 'vue';
import type { LoadedAudioAsset } from '@/persistence/assets';
import type { DetectedNote } from './onsets';
import { noteRegionMarkers } from './onsets';
import {
  detectNoteRegions,
  detectOnsetFrames,
  type SampleEditorWasmOps,
  splitSilenceFrames,
} from './wasm-ops';

/** Options for {@link useSampleMarkers}. */
export interface UseSampleMarkersOptions {
  /** Loaded WASM ops (null until ready). */
  wasmOps: () => SampleEditorWasmOps | null;
  /** Currently loaded asset (null when none). */
  asset: () => LoadedAudioAsset | null;
  /** Silence-split threshold in dB below the peak, as a string. */
  silenceThresholdInput: () => string;
  /** Editor-wide busy flag, held while a detection pass blocks the thread. */
  busy: Ref<boolean>;
  /** Surfaces an error message to the editor's shared error banner. */
  setError: (message: string) => void;
  /** Clears the editor's shared error banner. */
  clearError: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
}

/** Builds the marker state and detection actions. */
export function useSampleMarkers(options: UseSampleMarkersOptions) {
  const { wasmOps, asset, silenceThresholdInput, busy, setError, clearError } = options;

  /** Detected transient onset positions in frames (overlay markers). */
  const onsetFrames = ref<number[]>([]);

  /** Detected note regions, empty unless the note detector produced the markers. */
  const noteRegions = ref<DetectedNote[]>([]);

  /**
   * Detects transient onsets across the whole file and shows them as overlay
   * markers. The markers do not alter the audio; they snap selection edges and
   * let a click pick the slice between two transients (then any op can run on it).
   */
  function onDetectTransients(): void {
    const ops = wasmOps();
    const loaded = asset();
    if (!ops || !loaded) return;
    clearError();
    noteRegions.value = [];
    try {
      onsetFrames.value = detectOnsetFrames(ops, loaded.channels, loaded.meta.sampleRate);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /**
   * Detects the pitched note regions of a monophonic recording and marks both
   * edge of every note, so a click selects the note itself. Complements the
   * transient detector: it finds a legato note that arrives with no attack and
   * marks where a note stops, but cannot split a note repeated at one pitch.
   *
   * Pitch tracking runs on the whole file and is the slowest detector here
   * (seconds on a long take), so the editor is held busy across it — a paint
   * is awaited first so the busy state is actually on screen.
   */
  async function onDetectNotes(): Promise<void> {
    const ops = wasmOps();
    const loaded = asset();
    if (!ops || !loaded || busy.value) return;
    clearError();
    busy.value = true;
    try {
      await nextTick();
      const notes = detectNoteRegions(ops, loaded.channels, loaded.meta.sampleRate);
      noteRegions.value = notes;
      onsetFrames.value = noteRegionMarkers(notes, loaded.meta.numFrames);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      busy.value = false;
    }
  }

  /**
   * Splits the whole file on silence and shows the cut boundaries as the same
   * overlay markers the transient detector uses (a click then selects the slice —
   * silent or not — between two cuts). The audio is untouched.
   */
  function onSplitSilence(): void {
    const ops = wasmOps();
    const loaded = asset();
    if (!ops || !loaded) return;
    clearError();
    const topDb = parseNumber(silenceThresholdInput());
    noteRegions.value = [];
    try {
      onsetFrames.value = splitSilenceFrames(ops, loaded.channels, topDb ?? undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** Removes the markers (selection and audio are untouched). */
  function onClearTransients(): void {
    onsetFrames.value = [];
    noteRegions.value = [];
  }

  return {
    onsetFrames,
    noteRegions,
    onDetectTransients,
    onDetectNotes,
    onSplitSilence,
    onClearTransients,
  };
}
