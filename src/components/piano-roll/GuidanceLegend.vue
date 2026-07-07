<script setup lang="ts">
import { computed } from 'vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { useI18n } from '@/ui/i18n';
import type { ExplainLevel } from '@/ui/settings/app-settings';
import { PIANO_ROLL_COLORS } from './theme';

/**
 * Popover legend explaining the piano-roll composition guidance: an explanation
 * level selector plus the row-tint safety colours, the resolution arrow, and
 * the note card's colour-tone line. Descriptive — it reads its swatch colours
 * from the same theme the canvas draws with so the legend never drifts from
 * what is rendered.
 */

defineEmits<{
  /** Request the host close the popover. */
  close: [];
}>();

const { t } = useI18n();
const appSettings = useAppSettings();
const COLORS = PIANO_ROLL_COLORS;

/** The three explanation levels, in increasing depth, for the selector. */
const LEVELS: ReadonlyArray<ExplainLevel> = ['beginner', 'normal', 'theory'];

const explainLevel = computed<ExplainLevel>(() => appSettings.settings.explainLevel);

function setLevel(level: ExplainLevel): void {
  appSettings.set('explainLevel', level);
}
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
    <div class="legend-level">
      <span class="legend-level-label">{{ t.shell.pianoRoll.guideLevel }}</span>
      <div class="segmented" role="radiogroup" :aria-label="t.shell.pianoRoll.guideLevel">
        <button
          v-for="level in LEVELS"
          :key="level"
          type="button"
          class="segment"
          :class="{ active: explainLevel === level }"
          role="radio"
          :aria-checked="explainLevel === level"
          @click="setLevel(level)"
        >
          {{ t.theory.levelName[level] }}
        </button>
      </div>
    </div>
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

.legend-level {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border-subtle);
}

.legend-level-label {
  color: var(--text-2);
}

/* Equal-width three-way level picker, matching the generate-dialog segmented
   control so the app's segmented affordances read the same everywhere. */
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  box-shadow: var(--control-edge), var(--inset-well);
}

.segment {
  flex: 1 1 0;
  padding: var(--sp-1) var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition:
    background var(--dur-1) var(--ease-out),
    color var(--dur-1) var(--ease-out),
    box-shadow var(--dur-1) var(--ease-out);
}

.segment:hover:not(.active) {
  color: var(--text-1);
}

.segment.active {
  background: var(--surface-2);
  color: var(--text-1);
  box-shadow: var(--control-edge), var(--shadow-1);
}

.segment:focus-visible {
  outline: none;
  box-shadow: var(--ring);
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
