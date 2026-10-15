<script setup lang="ts">
import { computed } from 'vue';
import CloseIcon from '@/components/shell/CloseIcon.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import type { GuidanceProfile } from '@/compose/guidance-profile';
import { useI18n } from '@/ui/i18n';
import type { ExplainLevel } from '@/ui/settings/app-settings';
import { PIANO_ROLL_COLORS } from './theme';

/**
 * Popover legend explaining the piano-roll composition guidance: explanation
 * level and guidance profile selectors, the row-tint safety colours, the
 * resolution arrow and the note card's colour-tone line, then the pencil
 * column's three levels, ng hatch, thinning underline and resolution arrow.
 * Descriptive — it reads its swatch colours from the same theme the canvas
 * draws with so the legend never drifts from what is rendered.
 */

defineEmits<{
  /** Request the host close the popover. */
  close: [];
}>();

const { t } = useI18n();
const appSettings = useAppSettings();
const COLORS = PIANO_ROLL_COLORS;

/** Start x of each hatch stroke in the 20x12 ng swatch, matching the canvas spacing. */
const HATCH_OFFSETS: ReadonlyArray<number> = [-12, -8, -4, 0, 4, 8, 12, 16];

/** The three explanation levels, in increasing depth, for the selector. */
const LEVELS: ReadonlyArray<ExplainLevel> = ['beginner', 'normal', 'theory'];

/** The two guidance profiles, strictest first. */
const PROFILES: ReadonlyArray<GuidanceProfile> = ['counterpoint', 'pop'];

const explainLevel = computed<ExplainLevel>(() => appSettings.settings.explainLevel);
const profile = computed<GuidanceProfile>(() => appSettings.settings.guidanceProfile);

function setLevel(level: ExplainLevel): void {
  appSettings.set('explainLevel', level);
}

function setProfile(next: GuidanceProfile): void {
  appSettings.set('guidanceProfile', next);
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
        <CloseIcon />
      </button>
    </header>
    <div class="legend-level">
      <span class="legend-level-label">{{ t.shell.pianoRoll.guideLevel }}</span>
      <div class="segmented dense" role="radiogroup" v-radiogroup :aria-label="t.shell.pianoRoll.guideLevel">
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
      <span class="legend-level-label">{{ t.shell.pianoRoll.guideProfile }}</span>
      <div
        class="segmented dense"
        role="radiogroup"
        v-radiogroup
        :aria-label="t.shell.pianoRoll.guideProfile"
      >
        <button
          v-for="option in PROFILES"
          :key="option"
          type="button"
          class="segment"
          :class="{ active: profile === option }"
          role="radio"
          :aria-checked="profile === option"
          @click="setProfile(option)"
        >
          {{ t.settings.general.guidanceProfileName[option] }}
        </button>
      </div>
    </div>
    <span class="legend-section-label">{{ t.shell.pianoRoll.guideBackgroundHeading }}</span>
    <ul class="legend-items">
      <li>
        <span class="swatch" :style="{ background: COLORS.guidanceSafe }" />
        <span>{{ t.shell.pianoRoll.guideSafe }}</span>
      </li>
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
    <p v-if="profile === 'counterpoint'" class="legend-note">
      {{ t.shell.pianoRoll.guideAvoidNoteCounterpoint }}
    </p>
    <span class="legend-section-label legend-section-split">
      {{ t.shell.pianoRoll.guideExistingHeading }}
    </span>
    <ul class="legend-items">
      <li>
        <span class="note-line-swatch" :style="{ borderColor: COLORS.noteWarning }" />
        <span>{{ t.shell.pianoRoll.guideExistingWarning }}</span>
      </li>
      <li>
        <span class="note-line-swatch" :style="{ borderColor: COLORS.noteError }" />
        <span>{{ t.shell.pianoRoll.guideExistingDissonant }}</span>
      </li>
    </ul>
    <span class="legend-section-label legend-section-split">
      {{ t.shell.pianoRoll.guidePlacementHeading }}
    </span>
    <ul class="legend-items">
      <li>
        <span class="swatch" :style="{ background: COLORS.guidanceSafe }" />
        <span>{{ t.shell.pianoRoll.guidePlacementSafe }}</span>
      </li>
      <li>
        <span class="swatch" :style="{ background: COLORS.guidanceWarning }" />
        <span>{{ t.shell.pianoRoll.guidePlacementWarn }}</span>
      </li>
      <li data-legend="placement-ng">
        <svg class="swatch swatch-svg" viewBox="0 0 20 12" aria-hidden="true">
          <rect width="20" height="12" :fill="COLORS.guidanceDissonant" />
          <line
            v-for="offset in HATCH_OFFSETS"
            :key="offset"
            :x1="offset"
            y1="12"
            :x2="offset + 12"
            y2="0"
            :stroke="COLORS.placementHatch"
            stroke-width="1"
          />
        </svg>
        <span>{{ t.shell.pianoRoll.guidePlacementNg }}</span>
      </li>
      <li data-legend="placement-thinned">
        <svg class="swatch swatch-svg" viewBox="0 0 20 12" aria-hidden="true">
          <rect width="20" height="12" :fill="COLORS.guidanceSafe" />
          <line
            x1="2"
            y1="10.5"
            x2="18"
            y2="10.5"
            :stroke="COLORS.placementThinned"
            stroke-width="1"
            stroke-dasharray="2 2"
          />
        </svg>
        <span>{{ t.shell.pianoRoll.guidePlacementThinned }}</span>
      </li>
      <li data-legend="placement-resolution">
        <svg class="arrow-swatch" viewBox="0 0 24 12" aria-hidden="true">
          <line
            x1="2"
            y1="3"
            x2="18"
            y2="9"
            :stroke="COLORS.resolutionArrow"
            stroke-width="1.5"
            stroke-dasharray="3 2"
          />
          <path d="M18 9 L14 8.5 L15.5 5.5 Z" :fill="COLORS.resolutionArrow" />
        </svg>
        <span>{{ t.shell.pianoRoll.guidePlacementResolution }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.guidance-legend {
  position: absolute;
  /* The shared pop entrance grows from the right-docked anchor. */
  transform-origin: top right;
  box-sizing: border-box;
  top: calc(100% + 4px);
  right: 0.5rem;
  z-index: 40;
  min-width: 15rem;
  padding: 0.5rem 0.75rem;
  max-height: min(480px, calc(100vh - 100px));
  overflow-y: auto;
  background: var(--surface-floating);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  font: var(--fs-sm)/1.4 var(--font-sans);
  color: var(--text-1);
}

@media (max-height: 900px) {
  .guidance-legend {
    top: auto;
    bottom: calc(100% + 4px);
    max-height: min(220px, calc(100vh - 100px));
  }
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

.swatch-svg {
  display: block;
}

.note-line-swatch {
  flex: none;
  width: 20px;
  height: 12px;
  border-top: 3px solid;
  background: var(--accent-soft);
  border-radius: 2px;
}

.legend-section-label {
  display: block;
  margin-bottom: 0.3rem;
  color: var(--text-2);
}

.legend-section-split {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-subtle);
}

.legend-note {
  max-width: 17rem;
  margin: 0.35rem 0 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
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
