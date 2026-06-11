<script setup lang="ts">
import { computed } from 'vue';
import { useProjectStore } from '@/project/store';
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
 * piano-roll highlighting. There is no per-range key list to edit, so this
 * editor presents that one key as a single fixed row. Like the piano-roll
 * scale-highlight toggle, changes are editor-only state: they are not
 * undoable and are not part of the saved project document.
 */

const store = useProjectStore();

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
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col">Root</th>
          <th scope="col">Mode</th>
          <th scope="col">Highlight</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <select v-model.number="rootPc" class="cell-input cell-number" aria-label="Key root">
              <option v-for="(name, pc) in PITCH_CLASS_NAMES" :key="name" :value="pc">
                {{ name }}
              </option>
            </select>
          </td>
          <td>
            <select v-model="modeId" class="cell-input" aria-label="Key mode">
              <option v-for="choice in KEY_MODE_CHOICES" :key="choice.id" :value="choice.id">
                {{ choice.label }}
              </option>
              <option v-if="modeId === 'custom'" value="custom" disabled>Custom scale</option>
            </select>
          </td>
          <td class="cell-toggle">
            <input
              v-model="enabled"
              type="checkbox"
              aria-label="Highlight the key in the piano roll"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <p class="list-readout">{{ currentLabel }}</p>
    <p class="list-hint">
      The project stores one global key, used for piano-roll scale highlighting. Per-range key
      changes are not supported yet.
    </p>
  </div>
</template>

<style scoped>
.list-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  font-size: 12px;
  color: #c7cdd9;
  overflow: auto;
  min-height: 0;
}

.list-table {
  border-collapse: collapse;
  width: 100%;
}

.list-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: #8b93a3;
  padding: 0.15rem 0.4rem 0.15rem 0;
  border-bottom: 1px solid #2a2e38;
}

.list-table td {
  padding: 0.12rem 0.4rem 0.12rem 0;
}

.cell-input {
  width: 100%;
  box-sizing: border-box;
  background: #0b0d11;
  border: 1px solid #2a2e38;
  border-radius: 3px;
  color: #e2e6ee;
  font: inherit;
  padding: 0.15rem 0.3rem;
}

.cell-input:focus {
  outline: none;
  border-color: #60a5fa;
}

.cell-number {
  width: 4.5rem;
}

.cell-toggle {
  width: 4.5rem;
}

.list-readout {
  margin: 0;
  color: #e2e6ee;
  font-weight: 600;
}

.list-hint {
  margin: 0;
  color: #8b93a3;
}
</style>
