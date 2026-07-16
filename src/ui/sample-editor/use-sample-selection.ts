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

  /** Sets an explicit range from accessible frame-bound controls. */
  function setSelectionRange(startFrame: number, endFrame: number): void {
    const totalFrames = asset.value?.meta.numFrames;
    if (totalFrames === undefined) return;
    const anchorFrame = clampFrameIndex(startFrame, totalFrames);
    const headFrame = clampFrameIndex(endFrame, totalFrames);
    selection.value = anchorFrame === headFrame ? null : { anchorFrame, headFrame };
  }

  /** Selects the entire loaded asset. */
  function selectAll(): void {
    const totalFrames = asset.value?.meta.numFrames;
    if (totalFrames === undefined) return;
    selection.value = totalFrames > 0 ? { anchorFrame: 0, headFrame: totalFrames } : null;
  }

  /** Keyboard control for the selection head. Arrow = one frame, Page = one second. */
  function onKeyDown(event: KeyboardEvent): void {
    const totalFrames = asset.value?.meta.numFrames;
    if (totalFrames === undefined) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      selection.value = null;
      return;
    }
    const step = event.shiftKey ? Math.max(1, asset.value?.meta.sampleRate ?? 1) : 1;
    const draft = selection.value;
    const anchorFrame = draft?.anchorFrame ?? 0;
    const headFrame = draft?.headFrame ?? 0;
    let nextHead: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        nextHead = headFrame - step;
        break;
      case 'ArrowRight':
        nextHead = headFrame + step;
        break;
      case 'PageUp':
        nextHead = headFrame - Math.max(1, asset.value?.meta.sampleRate ?? 1);
        break;
      case 'PageDown':
        nextHead = headFrame + Math.max(1, asset.value?.meta.sampleRate ?? 1);
        break;
      case 'Home':
        nextHead = 0;
        break;
      case 'End':
        nextHead = totalFrames;
        break;
      default:
        return;
    }
    event.preventDefault();
    const clamped = clampFrameIndex(nextHead, totalFrames);
    selection.value = anchorFrame === clamped ? null : { anchorFrame, headFrame: clamped };
  }

  return {
    selection,
    selRange,
    clampSelectionTo,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    setSelectionRange,
    selectAll,
    onKeyDown,
  };
}
