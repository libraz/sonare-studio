<script setup lang="ts">
import { useI18n } from '@/ui/i18n';
import { PIANO_ROLL_COLORS } from './theme';

/**
 * Popover legend explaining the piano-roll composition guidance: the row-tint
 * safety colours, the resolution arrow, and the note card's colour-tone line.
 * Purely descriptive — it reads its swatch colours from the same theme the
 * canvas draws with so the legend never drifts from what is rendered.
 */

defineEmits<{
  /** Request the host close the popover. */
  close: [];
}>();

const { t } = useI18n();
const COLORS = PIANO_ROLL_COLORS;
</script>

<template>
  <div class="guidance-legend" role="dialog" :aria-label="t.shell.pianoRoll.guideHeading">
    <header class="legend-header">
      <span class="legend-title">{{ t.shell.pianoRoll.guideHeading }}</span>
      <button
        type="button"
        class="legend-close"
        :aria-label="t.shell.pianoRoll.guideClose"
        @click="$emit('close')"
      >
        ✕
      </button>
    </header>
    <ul class="legend-items">
      <li>
        <span class="swatch" :style="{ background: COLORS.guidanceWarning }" />
        <span>{{ t.shell.pianoRoll.guideWarning }}</span>
      </li>
      <li>
        <span class="swatch" :style="{ background: COLORS.guidanceDissonant }" />
        <span>{{ t.shell.pianoRoll.guideDissonant }}</span>
      </li>
      <li>
        <svg class="arrow-swatch" viewBox="0 0 24 12" aria-hidden="true">
          <line
            x1="2"
            y1="9"
            x2="18"
            y2="3"
            :stroke="COLORS.resolutionArrow"
            stroke-width="1.5"
          />
          <path
            d="M18 3 L14 3.5 L15.5 6.5 Z"
            :fill="COLORS.resolutionArrow"
          />
        </svg>
        <span>{{ t.shell.pianoRoll.guideResolution }}</span>
      </li>
      <li>
        <span class="swatch swatch-color-tone" />
        <span>{{ t.shell.pianoRoll.guideColorTones }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.guidance-legend {
  position: absolute;
  top: calc(100% + 4px);
  right: 0.5rem;
  z-index: 40;
  min-width: 15rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--raise-hi);
  font: var(--fs-sm)/1.4 var(--font-sans);
  color: var(--text-1);
}

.legend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.4rem;
}

.legend-title {
  font-weight: var(--fw-semibold);
}

.legend-close {
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  line-height: 1;
  padding: 0.1rem 0.25rem;
}

.legend-close:hover {
  color: var(--text-1);
}

.legend-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.legend-items li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.swatch {
  flex: none;
  width: 20px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid var(--border);
}

.swatch-color-tone {
  background: var(--accent-soft);
}

.arrow-swatch {
  flex: none;
  width: 24px;
  height: 12px;
}
</style>
