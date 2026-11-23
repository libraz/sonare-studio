import { computed, ref } from 'vue';
import { useGestureTransaction } from '@/composables/useGestureTransaction';
import { cloneJson } from '@/project/clone-json';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { createDrumPattern, type StepPattern } from '@/ui/step-sequencer/pattern';

/**
 * Owns the step sequencer's editable pattern and root pitch, the pattern-local
 * undo/redo stacks (a pointer gesture coalesces into one entry) and the
 * reasons undo/redo are unavailable.
 */
export function useStepPatternHistory() {
  const { t } = useI18n();

  /** The editable pattern (replaced wholesale by every pure operation). */
  const pattern = ref<StepPattern>(createDrumPattern());
  interface PatternHistoryEntry {
    pattern: StepPattern;
    rootPitch: number;
  }

  const undoStack = ref<PatternHistoryEntry[]>([]);
  const redoStack = ref<PatternHistoryEntry[]>([]);
  const MAX_PATTERN_HISTORY = 100;

  function pushHistory(entry: PatternHistoryEntry): void {
    undoStack.value = [...undoStack.value.slice(-(MAX_PATTERN_HISTORY - 1)), entry];
    redoStack.value = [];
  }

  /** A pointer drag or paint stroke records one history entry, however many cells it writes. */
  const gesture = useGestureTransaction<PatternHistoryEntry>({ commit: pushHistory });

  function beginPointerGesture(): void {
    gesture.begin({ pattern: cloneJson(pattern.value), rootPitch: rootPitch.value });
  }

  function setPattern(next: StepPattern, previousRootPitch = rootPitch.value): void {
    if (gesture.active) {
      gesture.markDirty();
    } else {
      pushHistory({ pattern: cloneJson(pattern.value), rootPitch: previousRootPitch });
    }
    pattern.value = next;
  }

  function undoPattern(): void {
    const previous = undoStack.value.at(-1);
    if (!previous) return;
    redoStack.value = [
      ...redoStack.value,
      { pattern: cloneJson(pattern.value), rootPitch: rootPitch.value },
    ];
    undoStack.value = undoStack.value.slice(0, -1);
    pattern.value = previous.pattern;
    rootPitch.value = previous.rootPitch;
  }

  function redoPattern(): void {
    const next = redoStack.value.at(-1);
    if (!next) return;
    undoStack.value = [
      ...undoStack.value,
      { pattern: cloneJson(pattern.value), rootPitch: rootPitch.value },
    ];
    redoStack.value = redoStack.value.slice(0, -1);
    pattern.value = next.pattern;
    rootPitch.value = next.rootPitch;
  }

  /** Root pitch for pitch-mode rows (lowest of the chromatic octave). */
  const rootPitch = ref(48);

  const undoBlocked = computed(() =>
    firstBlock([undoStack.value.length === 0, t.value.reasons.nothingToUndo]),
  );
  const redoBlocked = computed(() =>
    firstBlock([redoStack.value.length === 0, t.value.reasons.nothingToRedo]),
  );

  return {
    pattern,
    rootPitch,
    gesture,
    beginPointerGesture,
    setPattern,
    undoPattern,
    redoPattern,
    undoBlocked,
    redoBlocked,
  };
}
