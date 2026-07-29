<script setup lang="ts">
import {
  type KeyScale,
  type ProgFunction,
  type ProgStyle,
  progressionsByStyle,
} from '@libraz/libcantus';
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { useAppSettings } from '@/composables/useAppSettings';
import { presetNotation } from '@/compose/preset-notation';
import { useI18n } from '@/ui/i18n';

/**
 * Style + preset picker for a chord progression, shared between the full
 * generate dialog and the chord list's in-place pattern replacement. Presets
 * are scoped to the chosen style and labeled with both the degree numerals
 * and the resolved chord letters in the given key (see {@link presetNotation}).
 */

const props = defineProps<{
  style: ProgStyle;
  presetId: string;
  keyScale: KeyScale;
}>();

const emit = defineEmits<{
  'update:style': [ProgStyle];
  'update:presetId': [string];
}>();

const appSettings = useAppSettings();
const { t } = useI18n();
const g = computed(() => t.value.shell.generate.chord);

const STYLES: ReadonlyArray<{
  id: ProgStyle;
  labelKey: 'styleMinimal' | 'styleDance' | 'styleIdol' | 'styleRock';
}> = [
  { id: 'minimal', labelKey: 'styleMinimal' },
  { id: 'dance', labelKey: 'styleDance' },
  { id: 'idol', labelKey: 'styleIdol' },
  { id: 'rock', labelKey: 'styleRock' },
];

const presetOptions = computed(() => [
  { value: '', label: g.value.presetAuto },
  ...progressionsByStyle(props.style).map((preset) => ({
    value: preset.id,
    label: preset.name,
    detail: presetNotation(preset, props.style, props.keyScale),
  })),
]);

const PRESET_ROLE_LABEL_KEYS: Record<
  ProgFunction,
  'presetRoleLoop' | 'presetRoleTensionBuild' | 'presetRoleCadenceStrong' | 'presetRoleStable'
> = {
  loop: 'presetRoleLoop',
  tensionBuild: 'presetRoleTensionBuild',
  cadenceStrong: 'presetRoleCadenceStrong',
  stable: 'presetRoleStable',
};

/** One-line helper under the preset picker: the role text, or the auto hint. */
const presetDetail = computed(() => {
  const level = appSettings.settings.explainLevel;
  if (props.presetId === '') return level === 'theory' ? '' : g.value.presetAutoHint;
  const preset = progressionsByStyle(props.style).find((p) => p.id === props.presetId);
  return preset ? g.value[PRESET_ROLE_LABEL_KEYS[preset.functional]] : '';
});

/** Degree/chord notation shown alongside the role text, styled distinctly (not at beginner level). */
const presetDetailNotation = computed(() => {
  if (appSettings.settings.explainLevel === 'beginner') return '';
  if (props.presetId === '') return '';
  const preset = progressionsByStyle(props.style).find((p) => p.id === props.presetId);
  return preset ? presetNotation(preset, props.style, props.keyScale) : '';
});

/** Switching style narrows the preset pool; a selection outside it resets to auto. */
function onStyleChange(style: ProgStyle): void {
  emit('update:style', style);
  if (props.presetId === '') return;
  const stillValid = progressionsByStyle(style).some((preset) => preset.id === props.presetId);
  if (!stillValid) emit('update:presetId', '');
}
</script>

<template>
  <div class="preset-picker">
    <span class="field-label">{{ g.style }}</span>
    <div class="segmented style-select" role="radiogroup" v-radiogroup :aria-label="g.style">
      <button
        v-for="option in STYLES"
        :key="option.id"
        type="button"
        class="segment"
        :class="{ active: props.style === option.id }"
        role="radio"
        :aria-checked="props.style === option.id"
        @click="onStyleChange(option.id)"
      >
        {{ g[option.labelKey] }}
      </button>
    </div>

    <div class="number-field">
      <span class="field-label">{{ g.preset }}</span>
      <SelectMenu
        :model-value="props.presetId"
        class="preset-select"
        :options="presetOptions"
        :aria-label="g.preset"
        @update:model-value="emit('update:presetId', $event)"
      />
    </div>
    <p v-if="presetDetail" class="preset-detail">
      {{ presetDetail }}
      <span v-if="presetDetailNotation" class="preset-notation">· {{ presetDetailNotation }}</span>
    </p>
  </div>
</template>

<style scoped>
.preset-picker {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.field-label {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-3);
}

.number-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.preset-detail {
  margin: calc(-1 * var(--sp-3)) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.preset-notation {
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}
</style>
