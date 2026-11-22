<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { readLocalStorage, writeLocalStorage } from '@/lib/local-storage';
import { hasNativeEnterBehavior } from '@/ui/accessibility/keyboard';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { useShortcutBlockingOverlay } from '@/ui/overlay-registry';
import { wrapTabFocus } from '@/ui/settings/focus-trap';
import { type AnchorRect, placeTooltip, type TooltipPlacement } from './tour-placement';
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

const { t } = useI18n();
const visible = ref(false);
const step = ref<TourStep | null>(null);
const stepNumber = ref(0);
const stepCount = ref(0);
const hasBack = ref(false);
const backBlocked = computed(() => firstBlock([!hasBack.value, t.value.shell.tour.firstStep]));
const isLast = ref(false);
const anchorRect = ref<AnchorRect | null>(null);
const placement = ref<TooltipPlacement>({ left: 0, top: 0, side: 'bottom' });
const tooltipRef = ref<HTMLElement | null>(null);
useShortcutBlockingOverlay(visible);

/**
 * Highlight box clamped to the viewport. A full-bleed anchor (e.g. a panel
 * spanning the whole width) would otherwise push its left/right borders a few
 * pixels off-screen, making the spotlight look borderless. Keeping the 2px
 * border inside the viewport ensures the outline always reads as a frame.
 */
const highlightStyle = computed(() => {
  const rect = anchorRect.value;
  if (rect === null) return {};
  const pad = 4;
  // Keep the full 2px border + halo within the viewport edge.
  const margin = 2;
  let left = rect.left - pad;
  let top = rect.top - pad;
  let right = rect.left + rect.width + pad;
  let bottom = rect.top + rect.height + pad;
  // clientWidth/Height exclude the scrollbar gutter that innerWidth/Height
  // include; clamping to those keeps the right/bottom border on-screen rather
  // than tucked behind a scrollbar where the fixed overlay does not paint.
  const viewW = document.documentElement.clientWidth;
  const viewH = document.documentElement.clientHeight;
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  right = Math.min(viewW - margin, right);
  bottom = Math.min(viewH - margin, bottom);
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.max(0, right - left)}px`,
    height: `${Math.max(0, bottom - top)}px`,
  };
});

let sequence: TourSequence | null = null;
let previousFocus: HTMLElement | null = null;

/** Returns focus to the control that opened the tour when it still exists. */
function restorePreviousFocus(afterRender = true): void {
  const target = previousFocus;
  previousFocus = null;
  if (!target) return;
  const restore = () => {
    if (target.isConnected) target.focus();
  };
  if (afterRender) void nextTick(restore);
  else restore();
}

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
  writeLocalStorage(props.storageKey, '1');
}

function wasSeen(): boolean {
  return readLocalStorage(props.storageKey) !== null;
}

/** Starts the tour from the first available step. Safe to call repeatedly. */
function open(): void {
  sequence = new TourSequence(props.steps, targetAvailable);
  if (!sequence.start()) return;
  if (!visible.value) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
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
  restorePreviousFocus();
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
  void nextTick().then(() => {
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
  if (tooltipRef.value !== null && wrapTabFocus(event, tooltipRef.value)) return;
  if (event.key === 'Enter' && hasNativeEnterBehavior(event)) return;
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

let viewportFrame: number | null = null;

/** Coalesces resize/scroll bursts into one re-measure per frame. */
function onViewportChange(): void {
  if (viewportFrame !== null) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = null;
    reposition();
  });
}

function detachViewportListeners(): void {
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
  if (viewportFrame !== null) {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = null;
  }
}

// The anchor only needs tracking while a step is on screen.
watch(visible, (isVisible) => {
  if (isVisible) {
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
  } else {
    detachViewportListeners();
  }
});

onMounted(() => {
  if (props.autoStart && !wasSeen()) {
    // Wait a tick so the shell has rendered the anchor elements.
    void nextTick().then(() => open());
  }
});

onBeforeUnmount(() => {
  detachViewportListeners();
  restorePreviousFocus(false);
});
</script>

<template>
  <Transition name="fade">
  <div v-if="visible && step" class="tour-overlay" @click.self="onSkip">
    <div
      v-if="anchorRect"
      class="tour-highlight"
      :style="highlightStyle"
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
      <h2 :key="`title-${step.id}`" class="tour-title fade-once">{{ step.title }}</h2>
      <p :key="`body-${step.id}`" class="tour-body fade-once">{{ step.body }}</p>
      <div class="tour-actions">
        <button type="button" class="tour-skip" @click="onSkip">
          {{ t.shell.tour.skip }}
        </button>
        <span class="tour-spacer" />
        <button
          type="button"
          :disabled="!!backBlocked"
          v-tooltip="{ reason: backBlocked }"
          @click="onBack"
        >
          {{ t.shell.tour.back }}
        </button>
        <button type="button" class="primary" @click="onNext">
          {{ isLast ? t.shell.tour.done : t.shell.tour.next }}
        </button>
      </div>
    </div>
  </div>
  </Transition>
</template>

<style scoped>
.tour-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--scrim);
}

.tour-highlight {
  position: fixed;
  border: 2px solid var(--accent);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 4px var(--accent-muted);
  pointer-events: none;
  /* Glide the spotlight to each step's anchor as its inline rect updates.
   * CSS does not transition the initial render, so the first step is instant. */
  transition:
    left var(--dur-2) var(--ease-out),
    top var(--dur-2) var(--ease-out),
    width var(--dur-2) var(--ease-out),
    height var(--dur-2) var(--ease-out);
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
  /* Glide alongside the spotlight when advancing between steps. */
  transition:
    left var(--dur-2) var(--ease-out),
    top var(--dur-2) var(--ease-out);
}

.tour-tooltip:focus {
  outline: none;
}

.tour-progress {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
}

.tour-title {
  margin: 0;
  font-size: var(--fs-lg);
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
  gap: var(--sp-4);
  margin-top: var(--sp-1);
}

.tour-spacer {
  flex: 1;
}

/* De-emphasized action: mirrors the .row-button recipe so skip stays
   subordinate to Next without reading as a web-style underlined link. */
.tour-skip {
  background: none;
  border: none;
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
  padding: var(--sp-2) var(--sp-3);
  transition: color var(--dur-1) var(--ease-out);
}

.tour-skip:hover {
  color: var(--text-1);
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
