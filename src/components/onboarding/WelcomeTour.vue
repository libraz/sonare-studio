<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  type AnchorRect,
  placeTooltip,
  type TooltipPlacement,
  type TooltipSide,
} from './tour-placement';
import { TourSequence, type TourStep } from './tour-steps';

/**
 * First-run welcome tour: a sequence of tooltips anchored to shell elements
 * resolved by CSS selectors. Steps whose target does not exist are skipped,
 * so the same step list works regardless of which panels are open. The tour
 * starts automatically when the localStorage flag is absent and can be
 * reopened any time via the exposed `open()` (e.g. from a Help menu entry).
 * Dismissing the tour in any way sets the flag so it never auto-starts again.
 */

const props = withDefaults(
  defineProps<{
    /** Ordered tour steps; steps whose target selector matches nothing are skipped. */
    steps: TourStep[];
    /** localStorage flag remembering the tour was seen. */
    storageKey?: string;
    /** Start automatically on mount when the storage flag is absent. */
    autoStart?: boolean;
  }>(),
  { storageKey: 'sonare-studio.tourSeen', autoStart: true },
);

const emit = defineEmits<{
  /** The tour closed; `completed` is true when the last step was reached. */
  close: [completed: boolean];
}>();

const visible = ref(false);
const step = ref<TourStep | null>(null);
const stepNumber = ref(0);
const stepCount = ref(0);
const hasBack = ref(false);
const isLast = ref(false);
const anchorRect = ref<AnchorRect | null>(null);
const placement = ref<TooltipPlacement>({ left: 0, top: 0, side: 'bottom' });
const tooltipRef = ref<HTMLElement | null>(null);

let sequence: TourSequence | null = null;

/** A selector is available when it matches a visible-ish element. */
function targetAvailable(selector: string): boolean {
  return findTarget(selector) !== null;
}

function findTarget(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    // Invalid selector: treat as missing rather than crashing the tour.
    return null;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(props.storageKey, '1');
  } catch {
    // Storage unavailable (private mode etc.); the tour just reappears.
  }
}

function wasSeen(): boolean {
  try {
    return localStorage.getItem(props.storageKey) !== null;
  } catch {
    return false;
  }
}

/** Starts the tour from the first available step. Safe to call repeatedly. */
function open(): void {
  sequence = new TourSequence(props.steps, targetAvailable);
  if (!sequence.start()) return;
  visible.value = true;
  syncStep();
}

defineExpose({ open });

function close(completed: boolean): void {
  markSeen();
  visible.value = false;
  step.value = null;
  anchorRect.value = null;
  emit('close', completed);
}

function onNext(): void {
  if (!sequence) return;
  sequence.next();
  if (sequence.status === 'done') {
    close(true);
    return;
  }
  syncStep();
}

function onBack(): void {
  if (!sequence) return;
  sequence.back();
  syncStep();
}

function onSkip(): void {
  sequence?.skip();
  close(false);
}

/** Pulls the current step out of the sequence and repositions the tooltip. */
function syncStep(): void {
  if (!sequence) return;
  const current = sequence.current;
  if (current === null) {
    close(sequence.outcome === 'completed');
    return;
  }
  step.value = current;
  const progress = sequence.progress;
  stepNumber.value = progress.index;
  stepCount.value = progress.count;
  hasBack.value = sequence.hasBack;
  isLast.value = !sequence.hasNext;
  void nextTick(() => {
    reposition();
    tooltipRef.value?.focus();
  });
}

/** Re-measures the anchor and tooltip and recomputes the placement. */
function reposition(): void {
  const current = step.value;
  if (!visible.value || current === null) return;
  const target = findTarget(current.target);
  if (target === null) {
    // Target vanished (panel closed) mid-step; advance instead of pointing
    // at empty space.
    onNext();
    return;
  }
  const rect = target.getBoundingClientRect();
  anchorRect.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  const tooltip = tooltipRef.value;
  placement.value = placeTooltip({
    anchor: anchorRect.value,
    tooltip: { width: tooltip?.offsetWidth ?? 0, height: tooltip?.offsetHeight ?? 0 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    side: current.placement,
  });
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      onSkip();
      break;
    case 'Enter':
    case 'ArrowRight':
      event.preventDefault();
      onNext();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      onBack();
      break;
    default:
      break;
  }
}

function onViewportChange(): void {
  reposition();
}

onMounted(() => {
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  if (props.autoStart && !wasSeen()) {
    // Wait a tick so the shell has rendered the anchor elements.
    void nextTick(() => open());
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<template>
  <div v-if="visible && step" class="tour-overlay" @click.self="onSkip">
    <div
      v-if="anchorRect"
      class="tour-highlight"
      :style="{
        left: `${anchorRect.left - 4}px`,
        top: `${anchorRect.top - 4}px`,
        width: `${anchorRect.width + 8}px`,
        height: `${anchorRect.height + 8}px`,
      }"
    />
    <div
      ref="tooltipRef"
      class="tour-tooltip"
      role="dialog"
      aria-modal="true"
      :aria-label="step.title"
      tabindex="-1"
      :data-side="placement.side"
      :style="{ left: `${placement.left}px`, top: `${placement.top}px` }"
      @keydown="onKeydown"
    >
      <p class="tour-progress">{{ stepNumber }} / {{ stepCount }}</p>
      <h2 class="tour-title">{{ step.title }}</h2>
      <p class="tour-body">{{ step.body }}</p>
      <div class="tour-actions">
        <button type="button" class="tour-skip" @click="onSkip">Skip tour</button>
        <span class="tour-spacer" />
        <button type="button" :disabled="!hasBack" @click="onBack">Back</button>
        <button type="button" class="primary" @click="onNext">
          {{ isLast ? 'Done' : 'Next' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tour-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(17, 24, 39, 0.32);
}

.tour-highlight {
  position: fixed;
  border: 2px solid var(--accent);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 4px var(--accent-muted);
  pointer-events: none;
}

.tour-tooltip {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  width: min(20rem, calc(100vw - 2rem));
  padding: 0.85rem 1rem;
  background: var(--glass-3);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-hairline), var(--shadow-pop);
  color: var(--text-1);
  font-size: var(--fs-sm);
}

.tour-tooltip:focus {
  outline: none;
}

.tour-progress {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
}

.tour-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: var(--fw-bold);
  letter-spacing: 0.02em;
}

.tour-body {
  margin: 0;
  color: var(--text-2);
  line-height: 1.5;
}

.tour-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.2rem;
}

.tour-spacer {
  flex: 1;
}

.tour-skip {
  background: none;
  border: none;
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0.25rem 0;
  text-decoration: underline;
}

.tour-actions button:not(.tour-skip) {
  background: var(--surface-3);
  border-radius: var(--radius-sm);
  color: var(--text-1);
  padding: 0.25rem 0.7rem;
  cursor: pointer;
  box-shadow: var(--control-lift);
  transition: background var(--dur-1) var(--ease-out);
}

.tour-actions button:not(.tour-skip):not(.primary):not(:disabled):hover {
  background: var(--surface-4);
  box-shadow: var(--control-lift-hover);
}

.tour-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}

.tour-actions .primary {
  background: var(--accent-strong);
  border-color: var(--accent);
}

.tour-actions .primary:not(:disabled):hover {
  background: var(--accent-hover);
}
</style>
