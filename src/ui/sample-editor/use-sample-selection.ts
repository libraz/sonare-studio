/**
 * Range-selection gestures for the sample editor. Owns the selection draft and
 * its derived range, the pointer drag state, and the click-to-slice behaviour
 * over transient markers. Pointer-to-frame mapping (with onset snapping) and
 * viewport access are supplied by the viewport composable.
 */

import { computed, type Ref, ref } from 'vue';
import type { LoadedAudioAsset } from '@/persistence/assets';
import { sliceRangeAt } from './onsets';
import {
  beginSelection,
  clampFrameIndex,
  dragSelection,
  extendSelection,
  type SelectionDraft,
  selectionRange,
} from './selection';
import type { SampleViewport } from './viewport';

/** Options for {@link useSampleSelection}. */
export interface UseSampleSelectionOptions {
  /** Currently loaded asset ref (null when none). */
  asset: Ref<LoadedAudioAsset | null>;
  /** Detected onset marker frames ref (drives snapping and slice-on-click). */
  onsetFrames: Ref<number[]>;
  /** Current viewport instance accessor (null before the first load). */
  getViewport: () => SampleViewport | null;
  /** Maps a pointer/wheel event x to a wrapper-local x coordinate. */
  localX: (event: PointerEvent) => number;
  /** Maps a viewport x to a frame, snapping to nearby onset markers. */
  frameAtPointer: (view: SampleViewport, x: number) => number;
}

/** Selection state and pointer handlers returned by {@link useSampleSelection}. */
export function useSampleSelection(options: UseSampleSelectionOptions) {
  const { asset, onsetFrames, getViewport, localX, frameAtPointer } = options;

  const selection = ref<SelectionDraft | null>(null);
  const selRange = computed(() => selectionRange(selection.value));

  let dragging = false;
  /** Shift state and raw down frame of the active gesture (for slice-on-click). */
  let pointerDownShift = false;
  let pointerDownRawFrame = 0;

  /** Clamps the selection to a new audio length (drops empty results). */
  function clampSelectionTo(totalFrames: number): void {
    const draft = selection.value;
    if (!draft) return;
    const anchorFrame = clampFrameIndex(draft.anchorFrame, totalFrames);
    const headFrame = clampFrameIndex(draft.headFrame, totalFrames);
    selection.value = anchorFrame === headFrame ? null : { anchorFrame, headFrame };
  }

  function onPointerDown(event: PointerEvent): void {
    const view = getViewport();
    const loaded = asset.value;
    if (event.button !== 0 || !view || !loaded) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pointerDownShift = event.shiftKey;
    pointerDownRawFrame = view.xToFrame(localX(event));
    const frame = frameAtPointer(view, localX(event));
    selection.value = event.shiftKey
      ? extendSelection(selection.value, frame, loaded.meta.numFrames)
      : beginSelection(frame, loaded.meta.numFrames);
    dragging = true;
  }

  function onPointerMove(event: PointerEvent): void {
    const view = getViewport();
    const loaded = asset.value;
    const draft = selection.value;
    if (!dragging || !view || !loaded || !draft) return;
    selection.value = dragSelection(
      draft,
      frameAtPointer(view, localX(event)),
      loaded.meta.numFrames,
    );
  }

  function onPointerUp(): void {
    const loaded = asset.value;
    // A click (no drag) on a transient-marked file selects the slice it lands in.
    if (
      dragging &&
      !pointerDownShift &&
      loaded &&
      onsetFrames.value.length > 0 &&
      selectionRange(selection.value) === null
    ) {
      const slice = sliceRangeAt(pointerDownRawFrame, onsetFrames.value, loaded.meta.numFrames);
      if (slice) selection.value = { anchorFrame: slice.startFrame, headFrame: slice.endFrame };
    }
    dragging = false;
  }

  return {
    selection,
    selRange,
    clampSelectionTo,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
