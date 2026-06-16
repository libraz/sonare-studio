<script setup lang="ts">
import { ref } from 'vue';
import { removeMarker, setMarker } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorMarker } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatBarBeat, parseBarBeat } from './bar-beat';

/**
 * Marker list editor: one row per timeline marker (bars.beats position +
 * name). Edits commit immediately through the marker commands (each change
 * is one undoable entry). Clicking a row asks the shell to seek the
 * transport to the marker; "Add at playhead" creates a marker at the
 * current transport position.
 */

const props = defineProps<{
  /** Playhead position getter in PPQ; omit to add markers at 1.1 instead. */
  positionPpq?: () => number;
}>();

const emit = defineEmits<{
  /** Request to move the transport playhead to an absolute PPQ position. */
  seek: [ppq: number];
}>();

const store = useProjectStore();
const { t } = useI18n();
const errorMessage = ref('');

/** Current display position of a marker. */
function positionText(marker: EditorMarker): string {
  return formatBarBeat(marker.ppq, store.timeSignatures);
}

/** Commits an edited position, reverting the field on invalid input. */
function onPositionChange(marker: EditorMarker, event: Event): void {
  const input = event.target as HTMLInputElement;
  const ppq = parseBarBeat(input.value, store.timeSignatures);
  if (ppq === null) {
    errorMessage.value = formatMessage(t.value.shell.lists.markers.invalidPosition, {
      position: input.value,
    });
    input.value = positionText(marker);
    return;
  }
  errorMessage.value = '';
  if (ppq !== marker.ppq) setMarker(marker.id, ppq, marker.name);
  else input.value = positionText(marker);
}

/** Commits an edited name (empty input reverts to the current name). */
function onNameChange(marker: EditorMarker, event: Event): void {
  const input = event.target as HTMLInputElement;
  const name = input.value.trim();
  if (name.length === 0) {
    input.value = marker.name;
    return;
  }
  if (name !== marker.name) setMarker(marker.id, marker.ppq, name);
}

/** Creates a marker at the transport playhead (or 1.1 without a getter). */
function addAtPlayhead(): void {
  const ppq = Math.max(0, props.positionPpq?.() ?? 0);
  setMarker(
    null,
    ppq,
    formatMessage(t.value.shell.lists.markers.defaultName, { number: store.markers.length + 1 }),
  );
}

function onDelete(marker: EditorMarker): void {
  removeMarker(marker.id);
}

function onSeek(marker: EditorMarker): void {
  emit('seek', marker.ppq);
}
</script>

<template>
  <div class="list-editor">
    <table class="list-table">
      <thead>
        <tr>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.seek }}</span></th>
          <th scope="col">{{ t.shell.lists.columns.position }}</th>
          <th scope="col">{{ t.shell.lists.columns.name }}</th>
          <th scope="col"><span class="visually-hidden">{{ t.shell.lists.columns.actions }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="marker in store.markers"
          :key="marker.id"
          class="marker-row"
          @click="onSeek(marker)"
        >
          <td class="cell-seek">
            <button
              type="button"
              class="row-button"
              :aria-label="formatMessage(t.shell.lists.markers.seekTo, { name: marker.name })"
              @click.stop="onSeek(marker)"
            >
              ▶
            </button>
          </td>
          <td>
            <input
              :value="positionText(marker)"
              class="cell-input cell-position"
              type="text"
              inputmode="decimal"
              :aria-label="formatMessage(t.shell.lists.markers.positionOf, { name: marker.name })"
              @click.stop
              @change="onPositionChange(marker, $event)"
            />
          </td>
          <td>
            <input
              :value="marker.name"
              class="cell-input"
              type="text"
              :aria-label="formatMessage(t.shell.lists.markers.nameOf, { name: marker.name })"
              @click.stop
              @change="onNameChange(marker, $event)"
            />
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="formatMessage(t.shell.lists.markers.delete, { name: marker.name })"
              @click.stop="onDelete(marker)"
            >
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="store.markers.length === 0" class="list-empty">{{ t.shell.lists.markers.empty }}</p>
    <p v-if="errorMessage" class="list-error" role="alert">{{ errorMessage }}</p>
    <div class="list-actions">
      <button type="button" @click="addAtPlayhead">{{ t.shell.lists.common.addAtPlayhead }}</button>
    </div>
  </div>
</template>

<style scoped>
.list-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  font-size: var(--fs-sm);
  color: var(--text-2);
  overflow: auto;
  min-height: 0;
}

.list-table {
  border-collapse: collapse;
  width: 100%;
}

.list-table th {
  text-align: left;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  color: var(--text-3);
  padding: 0.15rem 0.4rem 0.15rem 0;
  border-bottom: 1px solid var(--border);
}

.list-table td {
  padding: 0.12rem 0.4rem 0.12rem 0;
}

.marker-row {
  cursor: pointer;
}

.marker-row:hover {
  background: var(--surface-2);
}

.cell-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface-inset);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0.15rem 0.3rem;
  box-shadow: var(--control-edge), var(--inset-well);
  transition: box-shadow var(--dur-1) var(--ease-out);
}

.cell-input:focus {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--accent), var(--inset-well), var(--ring);
}

.cell-position {
  width: 5.5rem;
}

.cell-seek {
  width: 1.6rem;
}

.cell-actions {
  width: 1.6rem;
  text-align: right;
}

.row-button {
  background: none;
  border: none;
  box-shadow: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 0.1rem 0.25rem;
  font-size: var(--fs-xs);
  transition: color var(--dur-1) var(--ease-out);
}

.row-button:hover {
  color: var(--text-1);
}

.cell-actions .row-button:hover {
  color: var(--danger);
}

.list-empty {
  margin: 0;
  color: var(--text-3);
}

.list-error {
  margin: 0;
  background: var(--danger-surface);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger-text);
  padding: 0.25rem 0.5rem;
}

.list-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
