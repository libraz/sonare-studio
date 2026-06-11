<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import {
  addAudioTrack,
  addTrack,
  removeTrack,
  renameTrack,
  reorderTracks,
  setActiveTrack,
  setTrackColor,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import { type EditorTrack, TRACK_COLOR_PALETTE, type TrackKind } from '@/project/types';

/**
 * Track header column of the arrangement view: one header per track lane with
 * a kind icon, color swatch, editable name (double-click), record-arm (audio
 * tracks), mute/solo toggles, volume and pan mini sliders, inline delete and
 * pointer-drag reordering via the grip. All edits go through
 * src/project/commands.ts; the store is the read model. Record-arm state is
 * owned by the shell and only mirrored here via the `armedTrackIds` prop and
 * the `arm` emit.
 */

const props = defineProps<{
  /** Height of one track lane in px (matches the arrangement canvas). */
  laneHeight: number;
  /** Vertical scroll offset shared with the arrangement canvas, in px. */
  scrollY: number;
  /** Top spacer height aligning the first lane with the canvas ruler, in px. */
  rulerOffset: number;
  /** Ids of record-armed tracks (recording state is owned by the shell). */
  armedTrackIds?: readonly number[];
}>();

const emit = defineEmits<{
  /** Request to (dis)arm a track for recording. */
  arm: [trackId: number, armed: boolean];
}>();

const store = useProjectStore();

/** Glyph shown in front of the track name per track kind. */
const TRACK_KIND_GLYPHS: Record<TrackKind, string> = { audio: '∿', midi: '♪', aux: '⇄' };
/** Tooltip label per track kind. */
const TRACK_KIND_LABELS: Record<TrackKind, string> = {
  audio: 'Audio track',
  midi: 'MIDI track',
  aux: 'Aux track',
};

/** Surfaced when a command rejects (e.g. empty rename). */
const error = ref('');

// --- Inline rename ---------------------------------------------------------

const editingTrackId = ref<number>(-1);
const editName = ref('');
const nameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

function startRename(track: EditorTrack): void {
  editingTrackId.value = track.id;
  editName.value = track.name;
  // Focus once the input exists in the DOM.
  requestAnimationFrame(() => {
    const el = nameInput.value;
    const input = Array.isArray(el) ? el[0] : el;
    input?.focus();
    input?.select();
  });
}

function commitRename(): void {
  const trackId = editingTrackId.value;
  editingTrackId.value = -1;
  if (trackId < 0) return;
  const name = editName.value.trim();
  if (name.length === 0) return;
  try {
    renameTrack(trackId, name);
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function cancelRename(): void {
  editingTrackId.value = -1;
}

// --- Per-track controls ----------------------------------------------------

function activate(track: EditorTrack): void {
  if (editingTrackId.value === track.id) return;
  setActiveTrack(track.id);
}

/** Advances the track to the next palette color. */
function cycleColor(track: EditorTrack): void {
  const index = TRACK_COLOR_PALETTE.indexOf(track.color);
  const next = TRACK_COLOR_PALETTE[(index + 1) % TRACK_COLOR_PALETTE.length];
  setTrackColor(track.id, next);
}

function onVolumeChange(track: EditorTrack, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value) && value >= 0 && value !== track.volume) {
    setTrackVolume(track.id, value);
  }
}

function onPanChange(track: EditorTrack, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value) && value >= -1 && value <= 1 && value !== track.pan) {
    setTrackPan(track.id, value);
  }
}

function onDelete(track: EditorTrack): void {
  removeTrack(track.id);
}

/** True when the shell reports the track as record-armed. */
function isArmed(track: EditorTrack): boolean {
  return props.armedTrackIds?.includes(track.id) ?? false;
}

function onToggleArm(track: EditorTrack): void {
  emit('arm', track.id, !isArmed(track));
}

// --- Add-track menu ----------------------------------------------------------

const addMenuOpen = ref(false);
const addMenu = ref<HTMLDivElement | null>(null);

function onAddTrack(kind: 'midi' | 'audio'): void {
  addMenuOpen.value = false;
  const trackId = kind === 'audio' ? addAudioTrack() : addTrack();
  setActiveTrack(trackId);
}

/** Closes the add-track menu when the pointer goes down outside of it. */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || !addMenu.value?.contains(event.target)) {
    addMenuOpen.value = false;
  }
}

watch(addMenuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown, true);
  else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});

// --- Drag reordering -------------------------------------------------------

interface ReorderDrag {
  trackId: number;
  fromIndex: number;
  toIndex: number;
  startClientY: number;
}

const reorderDrag = ref<ReorderDrag | null>(null);

function onGripPointerDown(track: EditorTrack, index: number, event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  reorderDrag.value = {
    trackId: track.id,
    fromIndex: index,
    toIndex: index,
    startClientY: event.clientY,
  };
}

function onGripPointerMove(event: PointerEvent): void {
  const drag = reorderDrag.value;
  if (!drag) return;
  const deltaRows = Math.round((event.clientY - drag.startClientY) / props.laneHeight);
  const toIndex = Math.min(store.tracks.length - 1, Math.max(0, drag.fromIndex + deltaRows));
  if (toIndex !== drag.toIndex) reorderDrag.value = { ...drag, toIndex };
}

function onGripPointerUp(): void {
  const drag = reorderDrag.value;
  reorderDrag.value = null;
  if (!drag || drag.toIndex === drag.fromIndex) return;
  const ids = store.tracks.map((track) => track.id);
  ids.splice(drag.fromIndex, 1);
  ids.splice(drag.toIndex, 0, drag.trackId);
  reorderTracks(ids);
}

function onGripPointerCancel(): void {
  reorderDrag.value = null;
}

/** Row classes: active highlight plus reorder drag feedback. */
function rowClass(track: EditorTrack, index: number): Record<string, boolean> {
  const drag = reorderDrag.value;
  return {
    active: track.id === store.activeTrackId,
    dragging: drag?.trackId === track.id,
    'drop-target': drag !== null && drag.toIndex === index && drag.trackId !== track.id,
  };
}
</script>

<template>
  <div class="track-headers">
    <div class="headers-top" :style="{ height: `${props.rulerOffset}px` }">
      <div ref="addMenu" class="add-track-menu">
        <button
          type="button"
          class="add-track"
          title="Add a track"
          @click="addMenuOpen = !addMenuOpen"
        >
          + Track ▾
        </button>
        <div v-if="addMenuOpen" class="add-track-items" role="menu">
          <button type="button" role="menuitem" @click="onAddTrack('midi')">+ MIDI track</button>
          <button type="button" role="menuitem" @click="onAddTrack('audio')">+ Audio track</button>
        </div>
      </div>
    </div>
    <p v-if="error" class="headers-error" role="alert">{{ error }}</p>
    <div class="headers-viewport">
      <div class="headers-rows" :style="{ transform: `translateY(${-props.scrollY}px)` }">
        <div
          v-for="(track, index) in store.tracks"
          :key="track.id"
          class="track-header"
          :class="rowClass(track, index)"
          :style="{ height: `${props.laneHeight}px` }"
          @click="activate(track)"
        >
          <div
            class="track-grip"
            title="Drag to reorder"
            @click.stop
            @pointerdown.stop="onGripPointerDown(track, index, $event)"
            @pointermove="onGripPointerMove"
            @pointerup="onGripPointerUp"
            @pointercancel="onGripPointerCancel"
          >
            ⋮⋮
          </div>
          <button
            type="button"
            class="track-swatch"
            :style="{ background: track.color }"
            title="Cycle track color"
            @click.stop="cycleColor(track)"
          />
          <div class="track-main">
            <div class="track-name-row">
              <span class="track-kind" :title="TRACK_KIND_LABELS[track.kind]">
                {{ TRACK_KIND_GLYPHS[track.kind] }}
              </span>
              <input
                v-if="editingTrackId === track.id"
                ref="nameInput"
                v-model="editName"
                class="track-name-input"
                @click.stop
                @keydown.enter.prevent="commitRename"
                @keydown.escape.prevent="cancelRename"
                @blur="commitRename"
              />
              <span v-else class="track-name" @dblclick.stop="startRename(track)">
                {{ track.name }}
              </span>
              <button
                type="button"
                class="track-delete"
                title="Delete track"
                @click.stop="onDelete(track)"
              >
                ×
              </button>
            </div>
            <div class="track-controls" @click.stop>
              <button
                v-if="track.kind === 'audio'"
                type="button"
                class="toggle arm"
                :class="{ on: isArmed(track) }"
                title="Record arm"
                @click="onToggleArm(track)"
              >
                R
              </button>
              <button
                type="button"
                class="toggle mute"
                :class="{ on: track.mute }"
                title="Mute"
                @click="setTrackMute(track.id, !track.mute)"
              >
                M
              </button>
              <button
                type="button"
                class="toggle solo"
                :class="{ on: track.solo }"
                title="Solo"
                @click="setTrackSolo(track.id, !track.solo)"
              >
                S
              </button>
              <input
                class="mini-slider"
                type="range"
                min="0"
                max="2"
                step="0.01"
                :value="track.volume"
                :title="`Volume ${track.volume.toFixed(2)}`"
                @change="onVolumeChange(track, $event)"
              />
              <input
                class="mini-slider"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                :value="track.pan"
                :title="`Pan ${track.pan.toFixed(2)}`"
                @change="onPanChange(track, $event)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.track-headers {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #14161b;
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.headers-top {
  display: flex;
  align-items: center;
  padding: 0 6px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.5);
  flex: none;
}

.add-track-menu {
  position: relative;
}

.add-track {
  font: 600 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
}

.add-track:hover {
  background: #242832;
}

.add-track-items {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 110px;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.add-track-items button {
  font: 600 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: transparent;
  border: none;
  padding: 5px 8px;
  text-align: left;
  cursor: pointer;
}

.add-track-items button:hover {
  background: #242832;
}

.headers-error {
  margin: 0;
  padding: 2px 6px;
  background: #3b1219;
  color: #ffb4b4;
  font: 10px/1.4 system-ui, sans-serif;
}

.headers-viewport {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.track-header {
  display: flex;
  align-items: stretch;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  background: #15171c;
  cursor: pointer;
  user-select: none;
}

.track-header.active {
  background: #1b2330;
}

.track-header.dragging {
  opacity: 0.6;
}

.track-header.drop-target {
  box-shadow: inset 0 2px 0 #60a5fa;
}

.track-grip {
  display: flex;
  align-items: center;
  padding: 0 3px;
  color: #3a4150;
  font: 10px system-ui, sans-serif;
  letter-spacing: -1px;
  cursor: grab;
  touch-action: none;
}

.track-grip:hover {
  color: #5b6270;
}

.track-swatch {
  width: 6px;
  border: none;
  padding: 0;
  margin: 4px 0;
  border-radius: 3px;
  cursor: pointer;
  flex: none;
}

.track-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
}

.track-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.track-kind {
  flex: none;
  font: 10px system-ui, sans-serif;
  color: #5b6270;
}

.track-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 11px system-ui, sans-serif;
  color: #c8cdd6;
}

.track-name-input {
  flex: 1;
  min-width: 0;
  font: 600 11px system-ui, sans-serif;
  color: #e8ebf0;
  background: #0b0d11;
  border: 1px solid #60a5fa;
  border-radius: 3px;
  padding: 0 3px;
}

.track-delete {
  border: none;
  background: transparent;
  color: #5b6270;
  font: 12px system-ui, sans-serif;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  visibility: hidden;
}

.track-header:hover .track-delete {
  visibility: visible;
}

.track-delete:hover {
  color: #ffb4b4;
}

.track-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toggle {
  width: 16px;
  height: 14px;
  font: 700 9px system-ui, sans-serif;
  line-height: 1;
  color: #8b93a3;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
}

.toggle.arm.on {
  color: #fff;
  background: #ef4444;
  border-color: #ef4444;
}

.toggle.mute.on {
  color: #0b0d11;
  background: #fbbf24;
  border-color: #fbbf24;
}

.toggle.solo.on {
  color: #0b0d11;
  background: #60a5fa;
  border-color: #60a5fa;
}

.mini-slider {
  flex: 1;
  min-width: 0;
  height: 10px;
  accent-color: #60a5fa;
}
</style>
