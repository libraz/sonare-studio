/**
 * Transient/onset marker detection for the sample editor. Owns the overlay
 * marker positions (in frames) and the actions that populate or clear them:
 * transient onset detection and silence splitting. The markers never alter the
 * audio; they snap selection edges and let a click pick the slice between two
 * marks (see the selection composable).
 */

import { ref } from 'vue';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { detectOnsetFrames, type SampleEditorWasmOps, splitSilenceFrames } from './wasm-ops';

/** Options for {@link useSampleMarkers}. */
export interface UseSampleMarkersOptions {
  /** Loaded WASM ops (null until ready). */
  wasmOps: () => SampleEditorWasmOps | null;
  /** Currently loaded asset (null when none). */
  asset: () => LoadedAudioAsset | null;
  /** Silence-split threshold in dB below the peak, as a string. */
  silenceThresholdInput: () => string;
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
  const { wasmOps, asset, silenceThresholdInput, setError, clearError } = options;

  /** Detected transient onset positions in frames (overlay markers). */
  const onsetFrames = ref<number[]>([]);

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
    try {
      onsetFrames.value = detectOnsetFrames(ops, loaded.channels, loaded.meta.sampleRate);
    } catch (err) {
      setError(errorMessage(err));
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
    try {
      onsetFrames.value = splitSilenceFrames(ops, loaded.channels, topDb ?? undefined);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** Removes the transient markers (selection and audio are untouched). */
  function onClearTransients(): void {
    onsetFrames.value = [];
  }

  return {
    onsetFrames,
    onDetectTransients,
    onSplitSilence,
    onClearTransients,
  };
}
