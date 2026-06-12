<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  type AutomationLaneState,
  type AutomationParam,
  isAutomationParam,
} from '@/project/automation';
import {
  addAudioTrack,
  addGroupTrack,
  addTrack,
  removeTrack,
  renameTrack,
  reorderTracks,
  setActiveTrack,
  setAutomationLaneEnabled,
  setTrackColor,
  setTrackGroup,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
} from '@/project/commands';
import { flattenClipComp } from '@/project/comp-flatten';
import { bounceTrackRange, freezeTrack, unfreezeTrack } from '@/project/freeze';
import { useProjectStore } from '@/project/store';
import { type EditorTrack, TRACK_COLOR_PALETTE, type TrackKind } from '@/project/types';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  TAKE_LANE_HEIGHT_PX,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';

/**
 * Track header column of the arrangement view: one header per track lane with
 * a kind icon, color swatch, editable name (double-click), record-arm (audio
 * tracks), mute/solo toggles, volume and pan mini sliders, inline delete and
 * pointer-drag reordering via the grip. Once a group track exists, non-group
 * tracks also get a group-assignment select routing them into a group submix.
 * All edits go through src/project/commands.ts; the store is the read model. Record-arm state is
 * owned by the shell and only mirrored here via the `armedTrackIds` prop and
 * the `arm` emit.
 *
 * The "A" toggle expands an automation strip below a track's header (mirroring
 * the canvas sublane); expansion state and the selected parameter are owned by
 * the container and mirrored via the `automationExpandedIds` /
 * `automationParams` props and the `toggleAutomation` / `automationParam`
 * emits. The "T" toggle (tracks with comped audio clips only) likewise expands
 * one label row per take, mirrored via the `takesExpandedIds` prop and the
 * `toggleTakes` emit; the Flatten button next to it bakes every comped clip on
 * the track. Row heights then match the canvas row geometry: lane height plus
 * TAKE_LANE_HEIGHT_PX per take row plus AUTOMATION_LANE_HEIGHT_PX for expanded
 * rows, so stacked headers follow the same prefix sums as automation-rows.ts.
 *
 * The snowflake toggle freezes a non-group track (bakes its pre-fader render
 * and silences its own clips/DSP); frozen headers carry the .track-frozen
 * tint. The BNC button bounces the track in place over the transport loop
 * region (mirrored via the loop props) or, without a valid loop, over the
 * track's full clip span. Both renders are async with a disabled busy state.
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
  /** Ids of tracks whose automation sublane is expanded. */
  automationExpandedIds?: readonly number[];
  /** Selected automation parameter per track id (absent = 'faderDb'). */
  automationParams?: Record<number, AutomationParam>;
  /** Ids of tracks whose take sub-rows are expanded. */
  takesExpandedIds?: readonly number[];
  /** True when the transport loop region is enabled (bounce range source). */
  loopEnabled?: boolean;
  /** Transport loop start in PPQ. */
  loopStartPpq?: number;
  /** Transport loop end in PPQ. */
  loopEndPpq?: number;
}>();

const emit = defineEmits<{
  /** Request to (dis)arm a track for recording. */
  arm: [trackId: number, armed: boolean];
  /** Request to expand/collapse a track's automation sublane. */
  toggleAutomation: [trackId: number, expanded: boolean];
  /** Request to switch the parameter a track's automation sublane edits. */
  automationParam: [trackId: number, param: AutomationParam];
  /** Request to expand/collapse a track's take sub-rows. */
  toggleTakes: [trackId: number, expanded: boolean];
}>();

const store = useProjectStore();

/** Glyph shown in front of the track name per track kind. */
const TRACK_KIND_GLYPHS: Record<TrackKind, string> = {
  audio: '∿',
  midi: '♪',
  aux: '⇄',
  group: '⊞',
};
/** Tooltip label per track kind. */
const TRACK_KIND_LABELS: Record<TrackKind, string> = {
  audio: 'Audio track',
  midi: 'MIDI track',
  aux: 'Aux track',
  group: 'Group track',
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

// --- Group membership --------------------------------------------------------

/** Group tracks available as routing targets, in track order. */
const groupTracks = computed<EditorTrack[]>(() =>
  store.tracks.filter((track) => track.kind === 'group'),
);

function onGroupChange(track: EditorTrack, event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  try {
    setTrackGroup(track.id, raw === '' ? null : Number(raw));
    error.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** True when the shell reports the track as record-armed. */
function isArmed(track: EditorTrack): boolean {
  return props.armedTrackIds?.includes(track.id) ?? false;
}

function onToggleArm(track: EditorTrack): void {
  emit('arm', track.id, !isArmed(track));
}

// --- Automation sublane ------------------------------------------------------

/** True when the container reports the track's automation sublane as expanded. */
function isAutomationExpanded(track: EditorTrack): boolean {
  return props.automationExpandedIds?.includes(track.id) ?? false;
}

/** Parameter the track's automation sublane currently edits. */
function automationParamFor(track: EditorTrack): AutomationParam {
  return props.automationParams?.[track.id] ?? 'faderDb';
}

/** Store lane behind the track's sublane, or null when none exists yet. */
function automationLaneFor(track: EditorTrack): AutomationLaneState | null {
  const param = automationParamFor(track);
  return (
    store.automationLanes.find((lane) => lane.target === track.id && lane.param === param) ?? null
  );
}

/** Full header row height: lane plus take rows and the automation strip when expanded. */
function rowHeight(track: EditorTrack): number {
  const takeRows = isTakesExpanded(track) ? takeRowCount(track) : 0;
  return (
    props.laneHeight +
    takeRows * TAKE_LANE_HEIGHT_PX +
    (isAutomationExpanded(track) ? AUTOMATION_LANE_HEIGHT_PX : 0)
  );
}

function onToggleAutomation(track: EditorTrack): void {
  emit('toggleAutomation', track.id, !isAutomationExpanded(track));
}

// --- Take sub-rows (comping) -------------------------------------------------

/** True when the container reports the track's take sub-rows as expanded. */
function isTakesExpanded(track: EditorTrack): boolean {
  return props.takesExpandedIds?.includes(track.id) ?? false;
}

/** Number of take sub-rows the track shows when expanded (0 = no comped clips). */
function takeRowCount(track: EditorTrack): number {
  return trackTakeRowCount(store.clips, track.id);
}

function onToggleTakes(track: EditorTrack): void {
  emit('toggleTakes', track.id, !isTakesExpanded(track));
}

/** Bakes the comp of every comped audio clip on the track, one clip at a time. */
async function onFlattenTakes(track: EditorTrack): Promise<void> {
  const comped = store.clips.filter(
    (clip) => clip.trackId === track.id && (clip.takes?.length ?? 0) > 0,
  );
  for (const clip of comped) {
    try {
      await flattenClipComp(clip.id);
    } catch (err) {
      console.warn(`Flattening clip ${clip.id} failed`, err);
    }
  }
}

// --- Freeze & bounce-in-place ------------------------------------------------

/** Ids of tracks with an in-flight freeze render. */
const freezingIds = ref(new Set<number>());
/** Ids of tracks with an in-flight bounce render. */
const bouncingIds = ref(new Set<number>());

/** True while the track's freeze render is pending. */
function isFreezing(track: EditorTrack): boolean {
  return freezingIds.value.has(track.id);
}

/** True while the track's bounce render is pending. */
function isBouncing(track: EditorTrack): boolean {
  return bouncingIds.value.has(track.id);
}

/** Freezes an unfrozen track (async bake) or unfreezes a frozen one. */
async function onToggleFreeze(track: EditorTrack): Promise<void> {
  if (freezingIds.value.has(track.id)) return;
  if (track.frozen) {
    unfreezeTrack(track.id);
    return;
  }
  freezingIds.value.add(track.id);
  try {
    await freezeTrack(track.id);
  } catch (err) {
    console.warn(`Freezing track ${track.id} failed`, err);
  } finally {
    freezingIds.value.delete(track.id);
  }
}

/** True when the track has at least one clip to bounce. */
function trackHasClips(track: EditorTrack): boolean {
  return store.clips.some((clip) => clip.trackId === track.id);
}

/**
 * PPQ range a bounce covers: the transport loop region when enabled and
 * valid, otherwise the track's full clip span (null when the track has no
 * clips).
 */
function bounceRangeFor(track: EditorTrack): { startPpq: number; endPpq: number } | null {
  const loopStart = props.loopStartPpq ?? 0;
  const loopEnd = props.loopEndPpq ?? 0;
  if (props.loopEnabled && loopStart >= 0 && loopEnd > loopStart) {
    return { startPpq: loopStart, endPpq: loopEnd };
  }
  const clips = store.clips.filter((clip) => clip.trackId === track.id);
  if (clips.length === 0) return null;
  const startPpq = Math.min(...clips.map((clip) => clip.startPpq));
  const endPpq = Math.max(...clips.map((clip) => clip.startPpq + clip.lengthPpq));
  return endPpq > startPpq ? { startPpq, endPpq } : null;
}

/** Bounces the track in place over the range from {@link bounceRangeFor}. */
async function onBounce(track: EditorTrack): Promise<void> {
  if (bouncingIds.value.has(track.id)) return;
  const range = bounceRangeFor(track);
  if (range === null) return;
  bouncingIds.value.add(track.id);
  try {
    await bounceTrackRange(track.id, range.startPpq, range.endPpq);
  } catch (err) {
    console.warn(`Bouncing track ${track.id} failed`, err);
  } finally {
    bouncingIds.value.delete(track.id);
  }
}

function onAutomationParamChange(track: EditorTrack, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (isAutomationParam(value)) emit('automationParam', track.id, value);
}

function onAutomationEnabledChange(track: EditorTrack, event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  setAutomationLaneEnabled(track.id, automationParamFor(track), enabled);
}

// --- Add-track menu ----------------------------------------------------------

const addMenuOpen = ref(false);
const addMenu = ref<HTMLDivElement | null>(null);

function onAddTrack(kind: 'midi' | 'audio' | 'group'): void {
  addMenuOpen.value = false;
  const trackId =
    kind === 'audio' ? addAudioTrack() : kind === 'group' ? addGroupTrack() : addTrack();
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

/** Row classes: active highlight, frozen tint plus reorder drag feedback. */
function rowClass(track: EditorTrack, index: number): Record<string, boolean> {
  const drag = reorderDrag.value;
  return {
    active: track.id === store.activeTrackId,
    'track-frozen': track.frozen !== undefined,
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
          aria-haspopup="menu"
          :aria-expanded="addMenuOpen"
          @click="addMenuOpen = !addMenuOpen"
        >
          + Track ▾
        </button>
        <div v-if="addMenuOpen" class="add-track-items" role="menu">
          <button type="button" role="menuitem" @click="onAddTrack('midi')">+ MIDI track</button>
          <button type="button" role="menuitem" @click="onAddTrack('audio')">+ Audio track</button>
          <button type="button" role="menuitem" @click="onAddTrack('group')">+ Group track</button>
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
          :style="{ height: `${rowHeight(track)}px` }"
          @click="activate(track)"
        >
          <div class="track-row" :style="{ height: `${props.laneHeight}px` }">
            <div
              class="track-grip"
              title="Drag to reorder"
              aria-hidden="true"
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
              :aria-label="`Cycle color of ${track.name}`"
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
                  aria-label="Track name"
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
                  :aria-label="`Delete track ${track.name}`"
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
                  :aria-label="`Record arm ${track.name}`"
                  :aria-pressed="isArmed(track)"
                  @click="onToggleArm(track)"
                >
                  R
                </button>
                <button
                  type="button"
                  class="toggle mute"
                  :class="{ on: track.mute }"
                  title="Mute"
                  :aria-label="`Mute ${track.name}`"
                  :aria-pressed="track.mute"
                  @click="setTrackMute(track.id, !track.mute)"
                >
                  M
                </button>
                <button
                  type="button"
                  class="toggle solo"
                  :class="{ on: track.solo }"
                  title="Solo"
                  :aria-label="`Solo ${track.name}`"
                  :aria-pressed="track.solo"
                  @click="setTrackSolo(track.id, !track.solo)"
                >
                  S
                </button>
                <button
                  type="button"
                  class="toggle automation"
                  :class="{ on: isAutomationExpanded(track) }"
                  title="Automation lane"
                  :aria-label="`Automation lane of ${track.name}`"
                  :aria-pressed="isAutomationExpanded(track)"
                  @click="onToggleAutomation(track)"
                >
                  A
                </button>
                <button
                  v-if="track.kind !== 'group'"
                  type="button"
                  class="toggle freeze"
                  :class="{ on: track.frozen !== undefined, busy: isFreezing(track) }"
                  :disabled="isFreezing(track)"
                  :title="track.frozen ? 'Unfreeze track' : 'Freeze track (bake its render)'"
                  :aria-label="`Freeze ${track.name}`"
                  :aria-pressed="track.frozen !== undefined"
                  @click="onToggleFreeze(track)"
                >
                  ❄
                </button>
                <button
                  v-if="track.kind !== 'group' && trackHasClips(track)"
                  type="button"
                  class="track-bounce"
                  :class="{ busy: isBouncing(track) }"
                  :disabled="isBouncing(track)"
                  title="Bounce in place (loop region, or the full clip span)"
                  :aria-label="`Bounce ${track.name}`"
                  @click="onBounce(track)"
                >
                  BNC
                </button>
                <button
                  v-if="takeRowCount(track) > 0"
                  type="button"
                  class="toggle takes"
                  :class="{ on: isTakesExpanded(track) }"
                  title="Take lanes"
                  :aria-label="`Take lanes of ${track.name}`"
                  :aria-pressed="isTakesExpanded(track)"
                  @click="onToggleTakes(track)"
                >
                  T
                </button>
                <button
                  v-if="takeRowCount(track) > 0 && isTakesExpanded(track)"
                  type="button"
                  class="takes-flatten"
                  title="Flatten comp into one clip per comped clip"
                  :aria-label="`Flatten takes of ${track.name}`"
                  @click="onFlattenTakes(track)"
                >
                  Flatten
                </button>
                <input
                  class="mini-slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  :value="track.volume"
                  :title="`Volume ${track.volume.toFixed(2)}`"
                  :aria-label="`Volume of ${track.name}`"
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
                  :aria-label="`Pan of ${track.name}`"
                  @change="onPanChange(track, $event)"
                />
                <select
                  v-if="track.kind !== 'group' && groupTracks.length > 0"
                  class="track-group-select"
                  :value="track.groupId ?? ''"
                  title="Output group"
                  :aria-label="`Group of ${track.name}`"
                  @change="onGroupChange(track, $event)"
                >
                  <option value="">No group</option>
                  <option v-for="group in groupTracks" :key="group.id" :value="group.id">
                    {{ group.name }}
                  </option>
                </select>
              </div>
            </div>
          </div>
          <div
            v-if="isTakesExpanded(track) && takeRowCount(track) > 0"
            class="track-takes"
            @click.stop
          >
            <div
              v-for="k in takeRowCount(track)"
              :key="k"
              class="take-label-row"
              :style="{ height: `${TAKE_LANE_HEIGHT_PX}px` }"
            >
              Take {{ k }}
            </div>
          </div>
          <div v-if="isAutomationExpanded(track)" class="track-automation" @click.stop>
            <span class="automation-label">AUTO</span>
            <select
              class="automation-param"
              :value="automationParamFor(track)"
              :aria-label="`Automation parameter of ${track.name}`"
              @change="onAutomationParamChange(track, $event)"
            >
              <option value="faderDb">Volume (dB)</option>
              <option value="pan">Pan</option>
            </select>
            <label class="automation-enable" :title="automationLaneFor(track) ? 'Apply during playback' : 'No automation points yet'">
              <input
                type="checkbox"
                :checked="automationLaneFor(track)?.enabled ?? false"
                :disabled="automationLaneFor(track) === null"
                :aria-label="`Enable automation of ${track.name}`"
                @change="onAutomationEnabledChange(track, $event)"
              />
              On
            </label>
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
  flex-direction: column;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  background: #15171c;
  cursor: pointer;
  user-select: none;
}

.track-row {
  display: flex;
  align-items: stretch;
  box-sizing: border-box;
  flex: none;
}

.track-header.active {
  background: #1b2330;
}

.track-header.track-frozen {
  background: #161c24;
}

.track-header.track-frozen .track-name {
  color: #9bb8cc;
}

.track-header.track-frozen.active {
  background: #1b2530;
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

.toggle.automation.on {
  color: #0b0d11;
  background: #34d399;
  border-color: #34d399;
}

.toggle.takes.on {
  color: #0b0d11;
  background: #a78bfa;
  border-color: #a78bfa;
}

.toggle.freeze.on {
  color: #0b0d11;
  background: #7dd3fc;
  border-color: #7dd3fc;
}

.toggle.freeze:disabled,
.track-bounce:disabled {
  opacity: 0.5;
  cursor: wait;
}

.track-bounce {
  height: 14px;
  font: 700 8px system-ui, sans-serif;
  line-height: 1;
  color: #8b93a3;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 0 4px;
  cursor: pointer;
}

.track-bounce:hover:not(:disabled) {
  color: #c8cdd6;
  background: #242832;
}

.takes-flatten {
  height: 14px;
  font: 700 8px system-ui, sans-serif;
  line-height: 1;
  color: #8b93a3;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 0 4px;
  cursor: pointer;
}

.takes-flatten:hover {
  color: #c8cdd6;
  background: #242832;
}

.track-takes {
  display: flex;
  flex-direction: column;
  flex: none;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
  cursor: default;
}

.take-label-row {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 6px 0 15px;
  font: 600 9px system-ui, sans-serif;
  color: #8b93a3;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.take-label-row:last-child {
  border-bottom: none;
}

.track-automation {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 15px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
  cursor: default;
}

.automation-label {
  flex: none;
  font: 600 8px system-ui, sans-serif;
  letter-spacing: 0.08em;
  color: #5b6270;
}

.automation-param {
  flex: 1;
  min-width: 0;
  font: 600 10px system-ui, sans-serif;
  color: #c8cdd6;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 1px 2px;
}

.automation-enable {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  font: 600 9px system-ui, sans-serif;
  color: #8b93a3;
  cursor: pointer;
}

.automation-enable input {
  margin: 0;
  accent-color: #60a5fa;
}

.automation-enable input:disabled {
  cursor: not-allowed;
}

.mini-slider {
  flex: 1;
  min-width: 0;
  height: 10px;
  accent-color: #60a5fa;
}

.track-group-select {
  flex: 1;
  min-width: 0;
  max-width: 64px;
  height: 14px;
  font: 600 9px system-ui, sans-serif;
  color: #c8cdd6;
  background: #1d2027;
  border: 1px solid #2a2e37;
  border-radius: 3px;
  padding: 0 1px;
}
</style>
