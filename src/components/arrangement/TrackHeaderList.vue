<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AddTrackMenu from '@/components/arrangement/track-header/AddTrackMenu.vue';
import TrackAutomationStrip from '@/components/arrangement/track-header/TrackAutomationStrip.vue';
import TrackTakeRows from '@/components/arrangement/track-header/TrackTakeRows.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { confirmDestructive } from '@/composables/useDialogs';
import { dbToLinear, linearToDb } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { clamp } from '@/lib/math';
import type { AutomationParam } from '@/project/automation';
import {
  addAudioTrack,
  addGroupTrack,
  addTrack,
  flattenClipMidiComp,
  removeTrack,
  removeTracks,
  setActiveTrack,
  setStripPan,
  setTrackColor,
  setTrackMute,
  setTrackSelection,
  setTrackSolo,
  setTracksColor,
  setTrackVolume,
  type TrackPart,
} from '@/project/commands';
import { flattenTrackComps } from '@/project/comp-flatten';
import { useProjectStore } from '@/project/store';
import {
  type EditorClip,
  type EditorTrack,
  TRACK_COLOR_PALETTE,
  type TrackKind,
} from '@/project/types';
import {
  type ArrangementRowLayout,
  TAKE_LANE_HEIGHT_PX,
  trackActiveTakeIndex,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { useTrackAutomationStrip } from '@/ui/arrangement/use-track-automation-strip';
import { useTrackFreezeBounce } from '@/ui/arrangement/use-track-freeze-bounce';
import { useTrackHeaderMenu } from '@/ui/arrangement/use-track-header-menu';
import { useTrackRename } from '@/ui/arrangement/use-track-rename';
import { useTrackReorderDrag } from '@/ui/arrangement/use-track-reorder-drag';
import { useTrackRouting } from '@/ui/arrangement/use-track-routing';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { dbToFaderPosition, faderPositionToDb, formatDb } from '@/ui/mixer/db-scale';
import { readInputNumber } from '@/ui/numeric-input';

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
 * The `scrollY` prop is the single vertical-scroll source of truth, shared
 * with the canvas; this column never scrolls on its own, so a row that must
 * become visible (rename focus, a newly added track) is requested from the
 * container via the `revealTrack` emit rather than scrolled locally.
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
  /** Shared row geometry from the arrangement container. */
  rowLayout: ArrangementRowLayout;
  /** Tracks currently visible in the arrangement (collapsed group members omitted). */
  tracks?: readonly EditorTrack[];
  /** Group-track ids whose member rows are currently hidden. */
  collapsedGroupIds?: readonly number[];
  /** Ids of record-armed tracks (recording state is owned by the shell). */
  armedTrackIds?: readonly number[];
  /**
   * Available audioinput devices for the per-track record-device picker
   * ({ value: deviceId, label }); empty hides the picker. Owned by the shell.
   */
  recordInputDevices?: readonly { value: string; label: string }[];
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
  /** Request to open the active MIDI track's instrument picker. */
  changeInstrument: [trackId: number];
  /** Request to expand/collapse a track's automation sublane. */
  toggleAutomation: [trackId: number, expanded: boolean];
  /** Request to switch the parameter a track's automation sublane edits. */
  automationParam: [trackId: number, param: AutomationParam];
  /** Request to expand/collapse a track's take sub-rows. */
  toggleTakes: [trackId: number, expanded: boolean];
  /** Request to regenerate this generated track (replacing it). */
  regenerateTrack: [trackId: number, part: TrackPart];
  /** Request to toggle visibility of one group track's member rows. */
  toggleGroupCollapse: [trackId: number, collapsed: boolean];
  /**
   * Request to scroll the shared vertical offset so this track's row is
   * fully visible (rename focus landing off-screen, a newly added track).
   */
  revealTrack: [trackId: number];
}>();

const store = useProjectStore();
const { t } = useI18n();
const displayTracks = computed(() => props.tracks ?? store.tracks);

/** Position the native popover inside the visible header viewport. The top
 * layer lets it escape the clipped rows while retaining keyboard dismissal. */
function positionTrackOverflow(event: Event): void {
  const panel = event.currentTarget;
  if (!(panel instanceof HTMLElement)) return;
  if (!panel.matches(':popover-open')) {
    panel.style.visibility = 'hidden';
    return;
  }
  const trigger = panel.previousElementSibling;
  if (!(trigger instanceof HTMLElement)) return;
  const viewport = trigger.closest('.headers-viewport')?.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const viewportTop = viewport?.top ?? 0;
  const viewportBottom = viewport?.bottom ?? window.innerHeight;
  panel.style.maxHeight = `${clamp(viewportBottom - viewportTop - 8, 40, 320)}px`;
  const { width, height } = panel.getBoundingClientRect();
  const below = anchor.bottom + 4;
  const above = anchor.top - height - 4;
  panel.style.top = `${below + height <= viewportBottom - 4 ? below : Math.max(viewportTop + 4, above)}px`;
  panel.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
  panel.style.visibility = 'visible';
}

function closeTrackOverflows(): void {
  for (const panel of document.querySelectorAll<HTMLElement>(
    '.track-overflow-panel:popover-open',
  )) {
    panel.hidePopover();
  }
}

watch([() => props.scrollY, () => props.laneHeight], closeTrackOverflows);
onMounted(() => window.addEventListener('resize', closeTrackOverflows));
onBeforeUnmount(() => window.removeEventListener('resize', closeTrackOverflows));

/** Glyph shown in front of the track name per track kind. */
const TRACK_KIND_GLYPHS: Record<TrackKind, string> = {
  audio: '∿',
  midi: '♪',
  aux: '⇄',
  group: '⊞',
};
/** Tooltip label per track kind. */
const trackKindLabel = computed<Record<TrackKind, string>>(() => ({
  audio: t.value.shell.arrangement.trackHeader.audioTrack,
  midi: t.value.shell.arrangement.trackHeader.midiTrack,
  aux: t.value.shell.arrangement.trackHeader.auxTrack,
  group: t.value.shell.arrangement.trackHeader.groupTrack,
}));

/** Surfaced when a command rejects (e.g. empty rename). */
const error = ref('');

const { editingTrackId, editName, startRename, commitRename, onRenameEnter, cancelRename } =
  useTrackRename({ error, emit });

// --- Per-track controls ----------------------------------------------------

const selectionAnchorTrackId = ref<number | null>(null);

function selectedTrackIds(fallbackTrackId: number): number[] {
  return store.trackSelection.has(fallbackTrackId) ? [...store.trackSelection] : [fallbackTrackId];
}

function activate(track: EditorTrack, event?: MouseEvent): void {
  if (editingTrackId.value === track.id) return;
  const index = displayTracks.value.findIndex((entry) => entry.id === track.id);
  if (event?.metaKey || event?.ctrlKey) {
    const next = new Set(store.trackSelection);
    if (next.has(track.id)) next.delete(track.id);
    else next.add(track.id);
    setTrackSelection(next, next.has(track.id) ? track.id : undefined);
  } else if (event?.shiftKey && selectionAnchorTrackId.value !== null) {
    const anchor = displayTracks.value.findIndex(
      (entry) => entry.id === selectionAnchorTrackId.value,
    );
    const [start, end] = anchor <= index ? [anchor, index] : [index, anchor];
    setTrackSelection(
      displayTracks.value.slice(start, end + 1).map((entry) => entry.id),
      track.id,
    );
  } else {
    setActiveTrack(track.id);
  }
  if (index >= 0) selectionAnchorTrackId.value = track.id;
}

/** Advances the track to the next palette color. */
function cycleColor(track: EditorTrack): void {
  const index = TRACK_COLOR_PALETTE.indexOf(track.color);
  const next = TRACK_COLOR_PALETTE[(index + 1) % TRACK_COLOR_PALETTE.length];
  const ids = selectedTrackIds(track.id);
  if (ids.length === 1) setTrackColor(track.id, next);
  else setTracksColor(ids, next);
}

function onVolumeChange(track: EditorTrack, event: Event): void {
  const position = readInputNumber(event);
  if (position !== null && position >= 0 && position <= 1) {
    // Preserve exact silence at the bottom rather than turning a zero legacy
    // volume into a merely very quiet −96 dB value.
    const value = position === 0 ? 0 : dbToLinear(faderPositionToDb(position));
    if (linearToDb(value) !== trackFaderDb(track)) setTrackVolume(track.id, value);
  }
}

/** Maps the canonical fader dB value to the shared fader taper. */
function trackVolumeFaderPosition(track: EditorTrack): number {
  return dbToFaderPosition(trackFaderDb(track));
}

/** Formats the canonical fader dB value. */
function trackVolumeLabel(track: EditorTrack): string {
  return `${formatDb(trackFaderDb(track))} dB`;
}

function trackFaderDb(track: EditorTrack): number {
  return linearToDb(track.volume) + (track.mixer?.gainDb ?? 0);
}

function onPanChange(track: EditorTrack, event: Event): void {
  const value = readInputNumber(event);
  const current = track.mixer?.pan ?? track.pan;
  if (value !== null && value >= -1 && value <= 1 && value !== current) {
    setStripPan(track.id, value);
  }
}

/** Audible strip pan, with the legacy document field as an old-project fallback. */
function trackPan(track: EditorTrack): number {
  return track.mixer?.pan ?? track.pan;
}

async function onDelete(track: EditorTrack): Promise<void> {
  const ids = selectedTrackIds(track.id);
  const labels = t.value.shell.arrangement.trackHeader;
  if (
    !(await confirmDestructive({
      title: labels.deleteTrack,
      message:
        ids.length === 1
          ? formatMessage(labels.deleteTrackConfirmMessage, { name: track.name })
          : formatMessage(labels.deleteTracksConfirmMessage, { count: ids.length }),
      confirmLabel: t.value.common.delete,
    }))
  )
    return;
  if (ids.length === 1) removeTrack(track.id);
  else removeTracks(ids);
}

function isGroupCollapsed(track: EditorTrack): boolean {
  return track.kind === 'group' && (props.collapsedGroupIds?.includes(track.id) ?? false);
}

const {
  groupTracks,
  GROUP_NONE,
  groupOptions,
  onGroupChange,
  vcaGroups,
  VCA_NONE,
  vcaOptions,
  onVcaChange,
  recordInputChannelOptions,
  recordInputChannelValue,
  onRecordInputChannelChange,
  recordInputDeviceOptions,
  recordInputDeviceValue,
  onRecordInputDeviceChange,
} = useTrackRouting({ props, error, selectedTrackIds });

/** True when the shell reports the track as record-armed. */
function isArmed(track: EditorTrack): boolean {
  return props.armedTrackIds?.includes(track.id) ?? false;
}

function onToggleArm(track: EditorTrack): void {
  emit('arm', track.id, !isArmed(track));
}

// --- Automation sublane ------------------------------------------------------

const {
  isAutomationExpanded,
  automationParamFor,
  automationLaneFor,
  automationParamOptions,
  onToggleAutomation,
  onAutomationParamChange,
  onAutomationEnabledChange,
} = useTrackAutomationStrip({ props, emit });

/** Full header row height: lane plus take rows and the automation strip when expanded. */
function rowHeight(index: number): number {
  return props.rowLayout.rowHeight(index);
}

// --- Take sub-rows (comping) -------------------------------------------------

/** True when the container reports the track's take sub-rows as expanded. */
function isTakesExpanded(track: EditorTrack): boolean {
  return props.takesExpandedIds?.includes(track.id) ?? false;
}

/** Take-row facts per track id, derived once per clip change instead of per render. */
const takeRowsByTrack = computed(() => {
  const clipsByTrack = new Map<number, EditorClip[]>();
  for (const clip of store.clips) {
    const list = clipsByTrack.get(clip.trackId);
    if (list) list.push(clip);
    else clipsByTrack.set(clip.trackId, [clip]);
  }
  const facts = new Map<number, { count: number; active: number }>();
  for (const [trackId, clips] of clipsByTrack) {
    facts.set(trackId, {
      count: trackTakeRowCount(clips, trackId),
      active: trackActiveTakeIndex(clips, trackId),
    });
  }
  return facts;
});

/** Number of take sub-rows the track shows when expanded (0 = no comped clips). */
function takeRowCount(track: EditorTrack): number {
  return takeRowsByTrack.value.get(track.id)?.count ?? 0;
}

/** Live/comped take row index for the track, or -1 when none is unambiguous. */
function activeTakeIndex(track: EditorTrack): number {
  return takeRowsByTrack.value.get(track.id)?.active ?? -1;
}

function onToggleTakes(track: EditorTrack): void {
  emit('toggleTakes', track.id, !isTakesExpanded(track));
}

/** Bakes every comped clip first, then commits the whole track as one undo step. */
async function onFlattenTakes(track: EditorTrack): Promise<void> {
  try {
    if (track.kind === 'midi') {
      for (const clip of store.clips) {
        if (clip.trackId === track.id && (clip.midiTakes?.length ?? 0) > 0) {
          flattenClipMidiComp(clip.id);
        }
      }
    } else {
      await flattenTrackComps(track.id);
    }
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

const freezeBounce = useTrackFreezeBounce({ props, error });
const {
  isFreezing,
  isBouncing,
  onToggleFreeze,
  trackHasClips,
  onBounce,
  freezeBlocked,
  bounceBlocked,
} = freezeBounce;

function frozenReason(track: EditorTrack): string | null {
  return firstBlock([track.frozen !== undefined, t.value.reasons.trackFrozen]);
}

/** Arming a frozen track would record into silenced clips; disarming stays possible. */
function armBlocked(track: EditorTrack): string | null {
  return isArmed(track) ? null : frozenReason(track);
}

function flattenBlocked(track: EditorTrack): string | null {
  return frozenReason(track);
}

function onAddTrack(kind: 'midi' | 'audio' | 'group'): void {
  const trackId =
    kind === 'audio' ? addAudioTrack() : kind === 'group' ? addGroupTrack() : addTrack();
  setActiveTrack(trackId);
  emit('revealTrack', trackId);
}

const { reorderDrag, onGripPointerDown, onGripPointerMove, onGripPointerUp, onGripPointerCancel } =
  useTrackReorderDrag({ props, displayTracks });

const { onContextMenu } = useTrackHeaderMenu({
  error,
  selectionAnchorTrackId,
  freezeBounce,
  startRename,
  frozenReason,
  isArmed,
  armBlocked,
  onToggleArm,
  cycleColor,
  onDelete,
  emit,
});

/** Row classes: active highlight, frozen tint plus reorder drag feedback. */
function rowClass(track: EditorTrack, index: number): Record<string, boolean> {
  const drag = reorderDrag.value;
  return {
    active: track.id === store.activeTrackId,
    selected: store.trackSelection.has(track.id),
    'group-member': track.groupId !== undefined,
    'track-frozen': track.frozen !== undefined,
    dragging: drag?.trackId === track.id,
    'drop-target': drag !== null && drag.toIndex === index && drag.trackId !== track.id,
  };
}
</script>

<template>
  <div class="track-headers" role="listbox" aria-multiselectable="true">
    <div class="headers-top" :style="{ height: `${props.rulerOffset}px` }">
      <AddTrackMenu @add="onAddTrack" />
    </div>
    <p v-if="error" class="headers-error" role="alert">{{ error }}</p>
    <div class="headers-viewport">
      <div class="headers-rows" :style="{ transform: `translateY(${-props.scrollY}px)` }">
        <div
          v-for="(track, index) in displayTracks"
          :key="track.id"
          class="track-header"
          :class="rowClass(track, index)"
          :style="{ height: `${rowHeight(index)}px` }"
          role="option"
          :aria-selected="store.trackSelection.has(track.id)"
          @click="activate(track, $event)"
          @contextmenu.prevent="onContextMenu(track, $event)"
        >
          <div
            class="track-row"
            :class="{
              'track-row--compact': props.laneHeight <= 44,
              'track-row--tall': props.laneHeight >= 96,
            }"
            :style="{ height: `${props.laneHeight}px` }"
          >
            <div
              class="track-grip"
              v-tooltip="t.shell.arrangement.trackHeader.dragReorder"
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
              v-tooltip="t.shell.arrangement.trackHeader.cycleColor"
              :aria-label="
                formatMessage(t.shell.arrangement.trackHeader.cycleColorOf, { name: track.name })
              "
              @click.stop="cycleColor(track)"
            />
            <div class="track-main">
              <div class="track-name-row">
                <span class="track-kind" v-tooltip="trackKindLabel[track.kind]">
                  {{ TRACK_KIND_GLYPHS[track.kind] }}
                </span>
                <button
                  v-if="track.kind === 'group'"
                  type="button"
                  class="group-collapse"
                  :aria-label="
                    isGroupCollapsed(track)
                      ? t.shell.arrangement.trackHeader.expandGroup
                      : t.shell.arrangement.trackHeader.collapseGroup
                  "
                  v-tooltip="
                    isGroupCollapsed(track)
                      ? t.shell.arrangement.trackHeader.expandGroup
                      : t.shell.arrangement.trackHeader.collapseGroup
                  "
                  @click.stop="emit('toggleGroupCollapse', track.id, !isGroupCollapsed(track))"
                >
                  {{ isGroupCollapsed(track) ? '›' : '⌄' }}
                </button>
                <input
                  v-if="editingTrackId === track.id"
                  ref="nameInput"
                  v-model="editName"
                  class="track-name-input"
                  :aria-label="t.shell.arrangement.trackHeader.trackName"
                  @click.stop
                  @keydown.enter="onRenameEnter"
                  @keydown.escape.prevent="cancelRename"
                  @blur="commitRename"
                />
                <span
                  v-else
                  class="track-name"
                  v-tooltip="{
                    text: t.shell.arrangement.trackHeader.renameHint,
                    reason: frozenReason(track),
                  }"
                  @dblclick.stop="startRename(track)"
                >
                  {{ track.name }}
                </span>
                <button
                  type="button"
                  class="track-delete"
                  v-tooltip="t.shell.arrangement.trackHeader.deleteTrack"
                  :aria-label="
                    formatMessage(t.shell.arrangement.trackHeader.deleteTrackNamed, {
                      name: track.name,
                    })
                  "
                  @click.stop="void onDelete(track)"
                >
                  ×
                </button>
              </div>
              <div class="track-controls" @click.stop>
                <div class="track-primary-controls">
                  <button
                    v-if="track.kind === 'audio' || track.kind === 'midi'"
                    type="button"
                    class="toggle arm"
                    :class="{ on: isArmed(track) }"
                    :disabled="!!armBlocked(track)"
                    v-tooltip="{
                      text: t.shell.arrangement.trackHeader.recordArm,
                      shortcut: 'track.toggleArm',
                      reason: armBlocked(track),
                    }"
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.recordArmNamed, {
                        name: track.name,
                      })
                    "
                    :aria-pressed="isArmed(track)"
                    @click="onToggleArm(track)"
                  >
                    R
                  </button>
                  <button
                    type="button"
                    class="toggle mute"
                    :class="{ on: track.mute }"
                    v-tooltip="{
                      text: t.shell.arrangement.trackHeader.muteTitle,
                      shortcut: 'track.toggleMute',
                    }"
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.muteNamed, { name: track.name })
                    "
                    :aria-pressed="track.mute"
                    @click="setTrackMute(track.id, !track.mute)"
                  >
                    M
                  </button>
                  <button
                    type="button"
                    class="toggle solo"
                    :class="{ on: track.solo }"
                    v-tooltip="{
                      text: t.shell.arrangement.trackHeader.soloTitle,
                      shortcut: 'track.toggleSolo',
                    }"
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.soloNamed, { name: track.name })
                    "
                    :aria-pressed="track.solo"
                    @click="setTrackSolo(track.id, !track.solo)"
                  >
                    S
                  </button>
                  <button
                    type="button"
                    class="toggle automation"
                    :class="{ on: isAutomationExpanded(track) }"
                    v-tooltip="t.shell.arrangement.trackHeader.automationLane"
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.automationLaneOf, {
                        name: track.name,
                      })
                    "
                    :aria-pressed="isAutomationExpanded(track)"
                    @click="onToggleAutomation(track)"
                  >
                    A
                  </button>
                </div>
                <div class="track-mix-controls">
                  <input
                    class="mini-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    :value="trackVolumeFaderPosition(track)"
                    v-tooltip="
                      formatMessage(t.shell.arrangement.trackHeader.volumeTitle, {
                        value: trackVolumeLabel(track),
                      })
                    "
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.volumeOf, { name: track.name })
                    "
                    @change="onVolumeChange(track, $event)"
                  />
                  <input
                    v-if="track.kind !== 'group'"
                    class="mini-slider mini-slider--pan"
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    :value="trackPan(track)"
                    v-tooltip="
                      formatMessage(t.shell.arrangement.trackHeader.panTitle, {
                        value: trackPan(track).toFixed(2),
                      })
                    "
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.panOf, { name: track.name })
                    "
                    @change="onPanChange(track, $event)"
                  />
                </div>
                <div
                  v-if="
                    props.laneHeight <= 44 ||
                    track.kind !== 'group' ||
                    takeRowCount(track) > 0 ||
                    vcaGroups.length > 0
                  "
                  class="track-overflow"
                >
                  <button
                    type="button"
                    class="track-overflow-summary"
                    :popovertarget="`track-overflow-${track.id}`"
                    :aria-label="
                      formatMessage(t.shell.arrangement.trackHeader.moreActionsNamed, {
                        name: track.name,
                      })
                    "
                    v-tooltip="
                      formatMessage(t.shell.arrangement.trackHeader.moreActionsNamed, {
                        name: track.name,
                      })
                    "
                  >
                    <span aria-hidden="true">⋯</span>
                  </button>
                  <div
                    :id="`track-overflow-${track.id}`"
                    class="track-overflow-panel"
                    popover="auto"
                    @toggle="positionTrackOverflow"
                    @wheel.stop
                  >
                    <div v-if="props.laneHeight <= 44" class="track-compact-mix-controls">
                      <label>
                        <span>{{ t.shell.arrangement.trackHeader.volumeDb }}</span>
                        <input
                          class="mini-slider"
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          :value="trackVolumeFaderPosition(track)"
                          :aria-label="
                            formatMessage(t.shell.arrangement.trackHeader.volumeOf, {
                              name: track.name,
                            })
                          "
                          @change="onVolumeChange(track, $event)"
                        />
                      </label>
                      <label v-if="track.kind !== 'group'">
                        <span>{{ t.shell.arrangement.trackHeader.pan }}</span>
                        <input
                          class="mini-slider mini-slider--pan"
                          type="range"
                          min="-1"
                          max="1"
                          step="0.01"
                          :value="trackPan(track)"
                          :aria-label="
                            formatMessage(t.shell.arrangement.trackHeader.panOf, {
                              name: track.name,
                            })
                          "
                          @change="onPanChange(track, $event)"
                        />
                      </label>
                    </div>
                    <div class="track-secondary-controls">
                      <button
                        v-if="track.kind !== 'group'"
                        type="button"
                        class="toggle freeze"
                        :class="{ on: track.frozen !== undefined, busy: isFreezing(track) }"
                        :disabled="!!freezeBlocked(track)"
                        v-tooltip="{
                          text: track.frozen
                            ? t.shell.arrangement.trackHeader.unfreezeTitle
                            : t.shell.arrangement.trackHeader.freezeTitle,
                          reason: freezeBlocked(track),
                        }"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.freezeNamed, {
                            name: track.name,
                          })
                        "
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
                        :disabled="!!bounceBlocked(track)"
                        v-tooltip="{
                          text: t.shell.arrangement.trackHeader.bounceTitle,
                          reason: bounceBlocked(track),
                        }"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.bounceNamed, {
                            name: track.name,
                          })
                        "
                        @click="onBounce(track)"
                      >
                        BNC
                      </button>
                      <button
                        v-if="takeRowCount(track) > 0"
                        type="button"
                        class="toggle takes"
                        :class="{ on: isTakesExpanded(track) }"
                        v-tooltip="t.shell.arrangement.trackHeader.takeLanes"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.takeLanesOf, {
                            name: track.name,
                          })
                        "
                        :aria-pressed="isTakesExpanded(track)"
                        @click="onToggleTakes(track)"
                      >
                        T
                      </button>
                      <button
                        v-if="takeRowCount(track) > 0 && isTakesExpanded(track)"
                        type="button"
                        class="takes-flatten"
                        :disabled="!!flattenBlocked(track)"
                        v-tooltip="{
                          text: t.shell.arrangement.trackHeader.flattenTitle,
                          reason: flattenBlocked(track),
                        }"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.flattenNamed, {
                            name: track.name,
                          })
                        "
                        @click="onFlattenTakes(track)"
                      >
                        {{ t.shell.arrangement.trackHeader.flatten }}
                      </button>
                    </div>
                    <div
                      v-if="
                        track.kind === 'audio' ||
                        (track.kind !== 'group' && groupTracks.length > 0) ||
                        vcaGroups.length > 0
                      "
                      class="track-routing-controls"
                    >
                      <SelectMenu
                        v-if="track.kind === 'audio'"
                        class="track-record-input-select"
                        size="sm"
                        :model-value="recordInputChannelValue(track)"
                        :options="recordInputChannelOptions"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.recordInputOf, {
                            name: track.name,
                          })
                        "
                        @change="onRecordInputChannelChange(track, Number($event))"
                      />
                      <SelectMenu
                        v-if="track.kind === 'audio' && (props.recordInputDevices?.length ?? 0) > 0"
                        class="track-record-device-select"
                        size="sm"
                        :model-value="recordInputDeviceValue(track)"
                        :options="recordInputDeviceOptions"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.recordInputDeviceOf, {
                            name: track.name,
                          })
                        "
                        @change="onRecordInputDeviceChange(track, String($event))"
                      />
                      <SelectMenu
                        v-if="track.kind !== 'group' && groupTracks.length > 0"
                        class="track-group-select"
                        size="sm"
                        :model-value="track.groupId ?? GROUP_NONE"
                        :options="groupOptions"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.groupOf, { name: track.name })
                        "
                        @change="onGroupChange(track, $event)"
                      />
                      <SelectMenu
                        v-if="vcaGroups.length > 0"
                        class="track-vca-select"
                        size="sm"
                        :model-value="track.vcaId ?? VCA_NONE"
                        :options="vcaOptions"
                        :aria-label="
                          formatMessage(t.shell.arrangement.trackHeader.vcaOf, { name: track.name })
                        "
                        @change="onVcaChange(track, String($event))"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <TrackTakeRows
            v-if="isTakesExpanded(track) && takeRowCount(track) > 0"
            :row-count="takeRowCount(track)"
            :row-height="TAKE_LANE_HEIGHT_PX"
            :active-take="activeTakeIndex(track)"
          />
          <TrackAutomationStrip
            v-if="isAutomationExpanded(track)"
            :track="track"
            :lane="automationLaneFor(track)"
            :param="automationParamFor(track)"
            :options="automationParamOptions(track)"
            @param-change="onAutomationParamChange"
            @enabled-change="onAutomationEnabledChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style src="./track-header/track-header-list.css"></style>
