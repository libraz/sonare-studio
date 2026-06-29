<script setup lang="ts">
import { ref } from 'vue';
import EmptyState from '@/components/shell/EmptyState.vue';
import { removeMarker, setMarker } from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorMarker } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { formatBarBeat, parseBarBeat } from './bar-beat';
import ListIcon from './ListIcon.vue';

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
      <TransitionGroup tag="tbody" name="list-row">
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
              <ListIcon name="seek" />
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
              <ListIcon name="delete" />
            </button>
          </td>
        </tr>
      </TransitionGroup>
    </table>
    <EmptyState v-if="store.markers.length === 0" variant="inline" :message="t.shell.lists.markers.empty" />
    <p v-if="errorMessage" class="list-error" role="alert">{{ errorMessage }}</p>
    <div class="list-actions">
      <button type="button" @click="addAtPlayhead">{{ t.shell.lists.common.addAtPlayhead }}</button>
    </div>
  </div>
</template>

<style scoped src="./lists.css"></style>

<style scoped>
/*
 * The whole row seeks the transport, unlike the non-clickable tempo/meter
 * rows. A left accent edge plus an accent-tinted seek glyph on hover make that
 * affordance explicit.
 */
.marker-row {
  cursor: pointer;
  transition: box-shadow var(--dur-1) var(--ease-out);
}

.marker-row:hover {
  background: var(--surface-2);
  box-shadow: inset 2px 0 0 var(--accent-muted);
}

.marker-row:hover .cell-seek .row-button {
  color: var(--accent);
}

.cell-position {
  width: 5.5rem;
}
</style>
