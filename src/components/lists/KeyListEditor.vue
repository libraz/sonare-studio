<script setup lang="ts">
import { computed } from 'vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import ToggleButton from '@/components/shell/ToggleButton.vue';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import {
  KEY_MODE_CHOICES,
  keyLabel,
  matchModeChoiceId,
  modeMaskForChoice,
  PITCH_CLASS_NAMES,
} from './key-modes';

/**
 * Key editor over the project's single global key.
 *
 * The project model stores exactly one key: the scale-highlight
 * configuration (root pitch class + 12-bit interval mask) that drives the
 * piano-roll highlighting. Score key changes are authored as measure-aligned
 * markers from the Score toolbar, so this editor presents the scale-highlight
 * key as a single fixed row. Like the piano-roll scale-highlight toggle,
 * changes are editor-only state: they are not undoable and are not part of
 * the saved project document.
 */

const store = useProjectStore();
const { t } = useI18n();

/** Sentinel select value shown when the mask matches no diatonic mode. */
const CUSTOM_MODE = 'custom';

const enabled = computed({
  get: () => store.scaleHighlight.enabled,
  set: (value: boolean) => {
    store.scaleHighlight = { ...store.scaleHighlight, enabled: value };
  },
});

const rootPc = computed({
  get: () => store.scaleHighlight.rootPc,
  set: (value: number) => {
    store.scaleHighlight = { ...store.scaleHighlight, rootPc: value };
  },
});

const modeId = computed({
  get: () => matchModeChoiceId(store.scaleHighlight.modeMask) ?? CUSTOM_MODE,
  set: (value: string) => {
    if (value === CUSTOM_MODE) return;
    store.scaleHighlight = { ...store.scaleHighlight, modeMask: modeMaskForChoice(value) };
  },
});

const currentLabel = computed(() =>
  keyLabel(rootPc.value, modeId.value === CUSTOM_MODE ? null : modeId.value),
);

/** Root pitch-class choices, numeric to match the stored root pitch class. */
const rootOptions = computed(() =>
  PITCH_CLASS_NAMES.map((name, pc) => ({ value: pc, label: name })),
);

/**
 * Mode choices. The "Custom scale" sentinel is appended (disabled) only while
 * the current mask matches no diatonic mode, mirroring the original markup.
 */
const modeOptions = computed(() => {
  const choices: Array<{ value: string; label: string; disabled?: boolean }> = KEY_MODE_CHOICES.map(
    (choice) => ({ value: choice.id, label: choice.label }),
  );
  if (modeId.value === CUSTOM_MODE) {
    choices.push({
      value: CUSTOM_MODE,
      label: t.value.shell.lists.key.customScale,
      disabled: true,
    });
  }
  return choices;
});
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col">{{ t.shell.lists.columns.root }}</th>
          <th scope="col">{{ t.shell.lists.columns.mode }}</th>
          <th scope="col">{{ t.shell.lists.columns.highlight }}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <SelectMenu
              v-model="rootPc"
              :options="rootOptions"
              class="cell-input cell-number"
              :aria-label="t.shell.lists.key.root"
              size="sm"
            />
          </td>
          <td>
            <SelectMenu
              v-model="modeId"
              :options="modeOptions"
              class="cell-input"
              :aria-label="t.shell.lists.key.mode"
              size="sm"
            />
          </td>
          <td class="cell-toggle">
            <ToggleButton
              v-model="enabled"
              :label="t.shell.lists.columns.highlight"
              :aria-label="t.shell.lists.key.highlight"
              size="sm"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <p class="list-readout">{{ currentLabel }}</p>
    <p class="list-hint">{{ t.shell.lists.key.hint }}</p>
  </div>
</template>

<style scoped src="./lists.css"></style>

<style scoped>
.cell-number {
  width: 4.5rem;
}

.cell-toggle {
  width: 4.5rem;
}

.list-readout {
  margin: 0;
  color: var(--text-1);
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
}

.list-hint {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-xs);
}
</style>
