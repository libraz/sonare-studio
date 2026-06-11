<script setup lang="ts">
import { ref } from 'vue';
import { removeMarker, setMarker } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorMarker } from '@/project/types';
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
    errorMessage.value = `Invalid position "${input.value}" (use bars.beats, e.g. 5.1)`;
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
  setMarker(null, ppq, `Marker ${store.markers.length + 1}`);
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
          <th scope="col"><span class="visually-hidden">Seek</span></th>
          <th scope="col">Position</th>
          <th scope="col">Name</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
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
              :aria-label="`Seek to marker ${marker.name}`"
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
              :aria-label="`Position of marker ${marker.name} (bars.beats)`"
              @click.stop
              @change="onPositionChange(marker, $event)"
            />
          </td>
          <td>
            <input
              :value="marker.name"
              class="cell-input"
              type="text"
              :aria-label="`Name of marker ${marker.name}`"
              @click.stop
              @change="onNameChange(marker, $event)"
            />
          </td>
          <td class="cell-actions">
            <button
              type="button"
              class="row-button"
              :aria-label="`Delete marker ${marker.name}`"
              @click.stop="onDelete(marker)"
            >
              ✕
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="store.markers.length === 0" class="list-empty">
      No markers — add one at the playhead below.
    </p>
    <p v-if="errorMessage" class="list-error" role="alert">{{ errorMessage }}</p>
    <div class="list-actions">
      <button type="button" @click="addAtPlayhead">Add at playhead</button>
    </div>
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

.marker-row {
  cursor: pointer;
}

.marker-row:hover {
  background: #181b22;
}

.cell-input {
  width: 100%;
  box-sizing: border-box;
  background: #0b0d11;
  border: 1px solid #2a2e38;
  border-radius: 3px;
  color: #e2e6ee;
  font: inherit;
  font-variant-numeric: tabular-nums;
  padding: 0.15rem 0.3rem;
}

.cell-input:focus {
  outline: none;
  border-color: #60a5fa;
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
  color: #8b93a3;
  cursor: pointer;
  padding: 0.1rem 0.25rem;
  font-size: 11px;
}

.row-button:hover {
  color: #e2e6ee;
}

.cell-actions .row-button:hover {
  color: #f87171;
}

.list-empty {
  margin: 0;
  color: #8b93a3;
}

.list-error {
  margin: 0;
  background: #3b1219;
  border: 1px solid #ef4444;
  border-radius: 3px;
  color: #ffb4b4;
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
