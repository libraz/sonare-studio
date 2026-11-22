<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AddTrackMenu from '@/components/arrangement/track-header/AddTrackMenu.vue';
import TrackAutomationStrip from '@/components/arrangement/track-header/TrackAutomationStrip.vue';
import TrackTakeRows from '@/components/arrangement/track-header/TrackTakeRows.vue';
import SelectMenu from '@/components/shell/SelectMenu.vue';
import { confirmDestructive, promptDialog } from '@/composables/useDialogs';
import { isDrumTrack } from '@/compose/tracks';
import { dbToLinear, linearToDb } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { clamp } from '@/lib/math';
import { isOpfsAvailable } from '@/persistence/opfs';
import {
  deleteTrackChannelPreset,
  listTrackChannelPresets,
  saveTrackChannelPreset,
} from '@/persistence/track-presets';
import {
  type AutomationLaneState,
  type AutomationParam,
  insertAutomationParam,
  instrumentAutomationParam,
  isAutomationParam,
} from '@/project/automation';
import {
  addAudioTrack,
  addGroupTrack,
  addTrack,
  addVcaGroup,
  applyTrackChannelPreset,
  copyTrackChannelPreset,
  flattenClipMidiComp,
  hasCopiedTrackChannelPreset,
  pasteTrackChannelPreset,
  removeTrack,
  removeTracks,
  renameTrack,
  reorderTracks,
  setActiveTrack,
  setAutomationLaneEnabled,
  setStripPan,
  setTrackChordFollow,
  setTrackColor,
  setTrackExpressionMap,
  setTrackGroup,
  setTrackLeadFollow,
  setTrackMute,
  setTrackPercussion,
  setTrackPitchRange,
  setTrackRecordInputChannel,
  setTrackRecordInputDeviceId,
  setTrackSelection,
  setTrackSolo,
  setTracksColor,
  setTracksGroup,
  setTrackVca,
  setTrackVolume,
  type TrackPart,
} from '@/project/commands';
import { flattenTrackComps } from '@/project/comp-flatten';
import { EXPRESSION_MAP_PRESETS, matchingExpressionMapPreset } from '@/project/expression-map';
import { bounceTrackRange, freezeTrack, unfreezeTrack } from '@/project/freeze';
import { partForTrack } from '@/project/generation';
import {
  AUTOMATABLE_SYNTH_PARAMS,
  type AutomatableSynthParam,
  isNativeSynthInstrument,
  synthParamReachesSoundingVoices,
  trackInstrument,
} from '@/project/instrument';
import { MAX_VCA_GROUPS } from '@/project/mixer';
import {
  PITCH_RANGE_PRESET_IDS,
  PITCH_RANGE_PRESETS,
  type PitchRangePresetId,
} from '@/project/pitch-range';
import { catalogParamInfo } from '@/project/processor-controls';
import { useProjectStore } from '@/project/store';
import { type TrackChannelPreset, trackChannelPresetFromTrack } from '@/project/track-preset';
import {
  type EditorClip,
  type EditorTrack,
  TRACK_COLOR_PALETTE,
  type TrackKind,
} from '@/project/types';
import {
  type ArrangementRowLayout,
  reorderRowIndexForDelta,
  TAKE_LANE_HEIGHT_PX,
  trackActiveTakeIndex,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { patchFieldSpec } from '@/ui/devices/patch-draft';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { dbToFaderPosition, faderPositionToDb, formatDb } from '@/ui/mixer/db-scale';
import { shortcutHint } from '@/ui/settings/shortcut-hint';

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
const savedTrackPresets = ref<TrackChannelPreset[]>([]);

async function refreshSavedTrackPresets(): Promise<void> {
  savedTrackPresets.value = await listTrackChannelPresets();
}

onMounted(() => {
  if (!isOpfsAvailable()) return;
  void refreshSavedTrackPresets().catch((reason: unknown) => {
    error.value = describeError(reason, t.value.notices.errors);
  });
});

// --- Inline rename ---------------------------------------------------------

const editingTrackId = ref<number>(-1);
const editName = ref('');
const nameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);
let renameFocusFrame: number | null = null;

function startRename(track: EditorTrack): void {
  if (track.frozen !== undefined) {
    error.value = t.value.shell.arrangement.trackHeader.unfreezeTitle;
    return;
  }
  editingTrackId.value = track.id;
  editName.value = track.name;
  emit('revealTrack', track.id);
  if (renameFocusFrame !== null) cancelAnimationFrame(renameFocusFrame);
  // Focus once the input exists in the DOM. preventScroll: the shared
  // scrollY above is the single source of truth for the row's position;
  // the browser's own scrollIntoView-on-focus would otherwise scroll the
  // (overflow-clipped) header list independently of it.
  renameFocusFrame = requestAnimationFrame(() => {
    renameFocusFrame = null;
    const el = nameInput.value;
    const input = Array.isArray(el) ? el[0] : el;
    input?.focus({ preventScroll: true });
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
    error.value = describeError(err, t.value.notices.errors);
  }
}

function cancelRename(): void {
  editingTrackId.value = -1;
}

onBeforeUnmount(() => {
  if (renameFocusFrame !== null) {
    cancelAnimationFrame(renameFocusFrame);
    renameFocusFrame = null;
  }
});

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
  const position = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(position) && position >= 0 && position <= 1) {
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
  const value = Number((event.target as HTMLInputElement).value);
  const current = track.mixer?.pan ?? track.pan;
  if (Number.isFinite(value) && value >= -1 && value <= 1 && value !== current) {
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

async function savePreset(track: EditorTrack): Promise<void> {
  const name = await promptDialog({
    title: t.value.shell.arrangement.trackHeader.saveChannelPreset,
    message: t.value.shell.arrangement.trackHeader.saveChannelPresetMessage,
    defaultValue: track.name,
    confirmLabel: t.value.shell.arrangement.trackHeader.savePreset,
  });
  if (!name) return;
  try {
    await saveTrackChannelPreset(trackChannelPresetFromTrack(track, name));
    await refreshSavedTrackPresets();
    error.value = '';
  } catch (reason) {
    error.value = describeError(reason, t.value.notices.errors);
  }
}

async function deletePreset(name: string): Promise<void> {
  try {
    await deleteTrackChannelPreset(name);
    await refreshSavedTrackPresets();
    error.value = '';
  } catch (reason) {
    error.value = describeError(reason, t.value.notices.errors);
  }
}

// --- Group membership --------------------------------------------------------

/** Group tracks available as routing targets, in track order. */
const groupTracks = computed<EditorTrack[]>(() =>
  store.tracks.filter((track) => track.kind === 'group'),
);

/** Sentinel value for the "No group" output-group option. */
const GROUP_NONE = '';

/** Output-group picker options: "No group" plus every group track. */
const groupOptions = computed<{ value: string | number; label: string }[]>(() => [
  { value: GROUP_NONE, label: t.value.shell.arrangement.trackHeader.noGroup },
  ...groupTracks.value.map((group) => ({ value: group.id, label: group.name })),
]);

function onGroupChange(track: EditorTrack, value: string | number): void {
  try {
    const ids = selectedTrackIds(track.id);
    const groupId = value === GROUP_NONE ? null : Number(value);
    if (ids.length === 1) setTrackGroup(track.id, groupId);
    else setTracksGroup(ids, groupId);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

// --- VCA membership ----------------------------------------------------------

/** VCA groups available as remote fader targets. */
const vcaGroups = computed(() => store.mixer.vcaGroups ?? []);

/** Sentinel value for the "No VCA" option. */
const VCA_NONE = '';

/** VCA picker options: "No VCA" plus every mixer VCA group. */
const vcaOptions = computed<{ value: string; label: string }[]>(() => [
  { value: VCA_NONE, label: t.value.shell.arrangement.trackHeader.noVca },
  ...vcaGroups.value.map((group) => ({ value: group.id, label: group.name })),
]);

function onVcaChange(track: EditorTrack, value: string): void {
  try {
    setTrackVca(track.id, value === VCA_NONE ? null : value);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

// --- Recording input channel -------------------------------------------------

/** SelectMenu value used for automatic input-channel assignment. */
const RECORD_INPUT_AUTO = -1;
/** Compact fixed menu; actual capture channel availability is known only after recording starts. */
const RECORD_INPUT_CHANNEL_OPTIONS = 8;

const recordInputChannelOptions = computed<{ value: number; label: string }[]>(() => [
  { value: RECORD_INPUT_AUTO, label: t.value.shell.arrangement.trackHeader.recordInputAuto },
  ...Array.from({ length: RECORD_INPUT_CHANNEL_OPTIONS }, (_, index) => ({
    value: index,
    label: formatMessage(t.value.shell.arrangement.trackHeader.recordInputChannel, {
      channel: String(index + 1),
    }),
  })),
]);

function recordInputChannelValue(track: EditorTrack): number {
  return track.recordInputChannel ?? RECORD_INPUT_AUTO;
}

function onRecordInputChannelChange(track: EditorTrack, value: number): void {
  try {
    setTrackRecordInputChannel(track.id, value === RECORD_INPUT_AUTO ? null : value);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
  }
}

// --- Recording input device --------------------------------------------------

/** SelectMenu value for the global (non-overridden) input device. */
const RECORD_DEVICE_DEFAULT = '';

const recordInputDeviceOptions = computed<{ value: string; label: string }[]>(() => [
  {
    value: RECORD_DEVICE_DEFAULT,
    label: t.value.shell.arrangement.trackHeader.recordInputDeviceDefault,
  },
  ...(props.recordInputDevices ?? [])
    .filter((device) => device.value !== RECORD_DEVICE_DEFAULT)
    .map((device) => ({ value: device.value, label: device.label })),
]);

function recordInputDeviceValue(track: EditorTrack): string {
  return track.recordInputDeviceId ?? RECORD_DEVICE_DEFAULT;
}

function onRecordInputDeviceChange(track: EditorTrack, value: string): void {
  try {
    setTrackRecordInputDeviceId(track.id, value === RECORD_DEVICE_DEFAULT ? null : value);
    error.value = '';
  } catch (err) {
    error.value = describeError(err, t.value.notices.errors);
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
  const param = props.automationParams?.[track.id] ?? 'faderDb';
  return track.kind === 'group' && param === 'pan' ? 'faderDb' : param;
}

/** Store lane behind the track's sublane, or null when none exists yet. */
function automationLaneFor(track: EditorTrack): AutomationLaneState | null {
  const param = automationParamFor(track);
  return (
    store.automationLanes.find((lane) => lane.target === track.id && lane.param === param) ?? null
  );
}

/** Full header row height: lane plus take rows and the automation strip when expanded. */
function rowHeight(index: number): number {
  return props.rowLayout.rowHeight(index);
}

function onToggleAutomation(track: EditorTrack): void {
  emit('toggleAutomation', track.id, !isAutomationExpanded(track));
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
  } catch (err) {
    console.warn(`Flattening track ${track.id} failed`, err);
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

/** A track's notes across all of its clips, for {@link isDrumTrack}. */
function notesOfTrack(track: EditorTrack) {
  return (store.clipsByTrack.get(track.id) ?? []).flatMap((clip) => clip.notes);
}

/** True when the track's saved pitch range matches this preset exactly. */
function matchesPitchRangePreset(track: EditorTrack, id: PitchRangePresetId): boolean {
  const range = track.pitchRange;
  const preset = PITCH_RANGE_PRESETS[id];
  return range !== undefined && range.low === preset.low && range.high === preset.high;
}

/** Tracks `track` may follow: not itself, not percussion, not already following another. */
function leadFollowCandidates(track: EditorTrack): EditorTrack[] {
  return store.tracks.filter(
    (entry) =>
      entry.id !== track.id &&
      entry.leadFollow === undefined &&
      !isDrumTrack(entry, notesOfTrack(entry)),
  );
}

const headerReasons = computed(() => t.value.shell.arrangement.trackHeader.reasons);

function frozenReason(track: EditorTrack): string | null {
  return firstBlock([track.frozen !== undefined, t.value.reasons.trackFrozen]);
}

/** Arming a frozen track would record into silenced clips; disarming stays possible. */
function armBlocked(track: EditorTrack): string | null {
  return isArmed(track) ? null : frozenReason(track);
}

function freezeBlocked(track: EditorTrack): string | null {
  return firstBlock([isFreezing(track), t.value.reasons.busy]);
}

function bounceBlocked(track: EditorTrack): string | null {
  return firstBlock([isBouncing(track), t.value.reasons.busy]);
}

function flattenBlocked(track: EditorTrack): string | null {
  return frozenReason(track);
}

/**
 * Why `track` cannot take part in lead following: percussion neither follows
 * nor leads, and a track already followed would form a chain by following.
 */
function leadFollowBlocked(track: EditorTrack): string | null {
  return firstBlock(
    [isDrumTrack(track, notesOfTrack(track)), headerReasons.value.percussionNoLeadFollow],
    [
      store.tracks.some((entry) => entry.leadFollow?.leadTrackId === track.id),
      headerReasons.value.alreadyLead,
    ],
  );
}

/** Saved presets live in OPFS, so every preset action needs it. */
const presetStorageBlocked = computed(() =>
  firstBlock([!isOpfsAvailable(), t.value.reasons.noStorage]),
);
const savedPresetsBlocked = computed(() =>
  firstBlock(presetStorageBlocked.value, [
    savedTrackPresets.value.length === 0,
    headerReasons.value.noSavedPresets,
  ]),
);

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

/**
 * Parameter choices for a track's automation sublane picker: the fader and pan
 * lanes plus, per insert slot, that processor's realtime-safe parameters as
 * insert-parameter automation targets.
 */
function automationParamOptions(
  track: EditorTrack,
): ReadonlyArray<{ value: AutomationParam; label: string }> {
  const options: { value: AutomationParam; label: string }[] = [
    { value: 'faderDb', label: t.value.shell.arrangement.trackHeader.volumeDb },
  ];
  if (track.kind !== 'group') {
    options.push({ value: 'pan', label: t.value.shell.arrangement.trackHeader.pan });
  }
  (track.mixer?.inserts ?? []).forEach((slot, index) => {
    for (const param of catalogParamInfo(slot.processor)) {
      if (!param.rtSafe) continue;
      options.push({
        value: insertAutomationParam(slot.id ?? index, param.name),
        label: `${slot.processor} · ${param.name}`,
      });
    }
  });
  if (
    track.kind === 'midi' &&
    track.frozen === undefined &&
    isNativeSynthInstrument(trackInstrument(track))
  ) {
    for (const param of AUTOMATABLE_SYNTH_PARAMS) {
      options.push({ value: instrumentAutomationParam(param), label: synthParamLabel(param) });
    }
  }
  return options;
}

/** Patch-editor section each synth field sits under, as its lane-label prefix. */
const SYNTH_SECTION_LABEL_KEYS = {
  osc: 'oscillator',
  filter: 'filter',
  amp: 'ampEnvelope',
  'filter-env': 'filterEnvelope',
  lfo: 'lfo',
  global: 'global',
} as const;

/**
 * "Section · Field" label for a synth parameter lane, e.g. "Amp envelope ·
 * Attack", marked when the lane only reaches notes that start after it moves.
 */
function synthParamLabel(param: AutomatableSynthParam): string {
  const spec = patchFieldSpec(param);
  if (!spec) return param;
  const editor = t.value.shell.patchEditor;
  const section = editor.sections[SYNTH_SECTION_LABEL_KEYS[spec.section]];
  const label = `${section} · ${editor.fields[spec.labelKey] ?? spec.label}`;
  return synthParamReachesSoundingVoices(param)
    ? label
    : formatMessage(t.value.shell.arrangement.trackHeader.synthParamNextNote, { label });
}

function onAutomationParamChange(track: EditorTrack, value: string): void {
  if (isAutomationParam(value)) emit('automationParam', track.id, value);
}

function onAutomationEnabledChange(track: EditorTrack, enabled: boolean): void {
  setAutomationLaneEnabled(track.id, automationParamFor(track), enabled);
}

function onAddTrack(kind: 'midi' | 'audio' | 'group'): void {
  const trackId =
    kind === 'audio' ? addAudioTrack() : kind === 'group' ? addGroupTrack() : addTrack();
  setActiveTrack(trackId);
  emit('revealTrack', trackId);
}

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
  const toIndex = reorderRowIndexForDelta(
    props.rowLayout,
    drag.fromIndex,
    event.clientY - drag.startClientY,
  );
  if (toIndex !== drag.toIndex) reorderDrag.value = { ...drag, toIndex };
}

function onGripPointerUp(): void {
  const drag = reorderDrag.value;
  reorderDrag.value = null;
  if (!drag || drag.toIndex === drag.fromIndex) return;
  const ids = store.tracks.map((track) => track.id);
  const fromIndex = ids.indexOf(drag.trackId);
  const destinationId = displayTracks.value[drag.toIndex]?.id;
  if (fromIndex < 0 || destinationId === undefined) return;
  ids.splice(fromIndex, 1);
  const destinationIndex = ids.indexOf(destinationId);
  if (destinationIndex < 0) return;
  ids.splice(destinationIndex + (drag.fromIndex < drag.toIndex ? 1 : 0), 0, drag.trackId);
  reorderTracks(ids);
}

function onGripPointerCancel(): void {
  reorderDrag.value = null;
}

// --- Right-click menu ------------------------------------------------------

/** Builds and opens the track header's right-click action menu. */
function onContextMenu(track: EditorTrack, event: MouseEvent): void {
  if (store.trackSelection.has(track.id)) {
    setTrackSelection(store.trackSelection, track.id);
  } else {
    setActiveTrack(track.id);
  }
  selectionAnchorTrackId.value = track.id;
  const items: ContextMenuItem[] = [
    {
      id: 'rename',
      label: t.value.shell.arrangement.trackHeader.rename,
      disabledReason: frozenReason(track),
      run: () => startRename(track),
    },
    { id: 'sep-1', separator: true },
    {
      id: 'mute',
      label: track.mute
        ? t.value.shell.arrangement.trackHeader.unmute
        : t.value.shell.arrangement.trackHeader.mute,
      hint: shortcutHint('track.toggleMute'),
      run: () => setTrackMute(track.id, !track.mute),
    },
    {
      id: 'solo',
      label: track.solo
        ? t.value.shell.arrangement.trackHeader.unsolo
        : t.value.shell.arrangement.trackHeader.solo,
      hint: shortcutHint('track.toggleSolo'),
      run: () => setTrackSolo(track.id, !track.solo),
    },
  ];
  if (track.kind === 'audio' || track.kind === 'midi') {
    items.push({
      id: 'arm',
      label: isArmed(track)
        ? t.value.shell.arrangement.trackHeader.disarmRecording
        : t.value.shell.arrangement.trackHeader.recordEnable,
      hint: shortcutHint('track.toggleArm'),
      disabledReason: armBlocked(track),
      run: () => onToggleArm(track),
    });
  }
  if (track.kind === 'midi') {
    items.push({
      id: 'change-instrument',
      label: t.value.shell.arrangement.trackHeader.changeInstrument,
      run: () => emit('changeInstrument', track.id),
    });
    const header = t.value.shell.arrangement.trackHeader;
    items.push(
      { id: 'sep-percussion', separator: true },
      {
        id: 'percussion-auto',
        label: `${header.percussion}: ${header.percussionAuto}`,
        checked: track.percussion === undefined,
        run: () => setTrackPercussion(track.id, null),
      },
      {
        id: 'percussion-on',
        label: `${header.percussion}: ${header.percussionOn}`,
        checked: track.percussion === true,
        run: () => setTrackPercussion(track.id, true),
      },
      {
        id: 'percussion-off',
        label: `${header.percussion}: ${header.percussionOff}`,
        checked: track.percussion === false,
        run: () => setTrackPercussion(track.id, false),
      },
      { id: 'sep-expression-map', separator: true },
      {
        id: 'expression-map-off',
        label: `${header.expressionMap}: ${header.expressionMapOff}`,
        checked: track.expressionMap === undefined,
        run: () => setTrackExpressionMap(track.id, null),
      },
      ...EXPRESSION_MAP_PRESETS.map((preset) => ({
        id: `expression-map-${preset.id}`,
        label: `${header.expressionMap}: ${header.expressionMapPresets[preset.id]}`,
        checked: matchingExpressionMapPreset(track.expressionMap)?.id === preset.id,
        run: () => setTrackExpressionMap(track.id, preset.map),
      })),
      { id: 'sep-chord-follow', separator: true },
      {
        id: 'chord-follow-off',
        label: `${header.chordFollow}: ${header.chordFollowOff}`,
        checked: track.chordFollow === undefined,
        run: () => setTrackChordFollow(track.id, null),
      },
      {
        id: 'chord-follow-tones',
        label: `${header.chordFollow}: ${header.chordFollowChordTones}`,
        checked: track.chordFollow === 'chordTones',
        run: () => setTrackChordFollow(track.id, 'chordTones'),
      },
      {
        id: 'chord-follow-root',
        label: `${header.chordFollow}: ${header.chordFollowRoot}`,
        checked: track.chordFollow === 'root',
        run: () => setTrackChordFollow(track.id, 'root'),
      },
      { id: 'sep-pitch-lead-follow', separator: true },
      {
        id: 'pitch-range',
        label: header.pitchRange,
        children: [
          {
            id: 'pitch-range-off',
            label: header.pitchRangeOff,
            checked: track.pitchRange === undefined,
            run: () => setTrackPitchRange(track.id, null),
          },
          ...PITCH_RANGE_PRESET_IDS.map((id) => ({
            id: `pitch-range-${id}`,
            label: header.pitchRangePresets[id],
            checked: matchesPitchRangePreset(track, id),
            run: () => setTrackPitchRange(track.id, PITCH_RANGE_PRESETS[id]),
          })),
        ],
      },
      {
        id: 'lead-follow',
        label: header.leadFollow,
        disabledReason: leadFollowBlocked(track),
        children: [
          {
            id: 'lead-follow-off',
            label: header.leadFollowOff,
            checked: track.leadFollow === undefined,
            run: () => setTrackLeadFollow(track.id, null),
          },
          ...leadFollowCandidates(track).map((candidate) => ({
            id: `lead-follow-${candidate.id}`,
            label: candidate.name,
            checked: track.leadFollow?.leadTrackId === candidate.id,
            run: () => setTrackLeadFollow(track.id, candidate.id),
          })),
        ],
      },
    );
  }
  if (track.kind === 'group') {
    const memberIds = store.tracks
      .filter((entry) => entry.groupId === track.id)
      .map((entry) => entry.id);
    items.push({ id: 'sep-group-members', separator: true });
    items.push({
      id: 'select-group-members',
      label: t.value.shell.arrangement.trackHeader.selectGroupMembers,
      disabledReason: firstBlock([memberIds.length === 0, headerReasons.value.noGroupMembers]),
      run: () => setTrackSelection([track.id, ...memberIds], track.id),
    });
  }
  items.push(
    { id: 'sep-channel-preset', separator: true },
    {
      id: 'copy-channel-settings',
      label: t.value.shell.arrangement.trackHeader.copyChannelSettings,
      run: () => copyTrackChannelPreset(track.id),
    },
    {
      id: 'paste-channel-settings',
      label: t.value.shell.arrangement.trackHeader.pasteChannelSettings,
      disabledReason: firstBlock([
        !hasCopiedTrackChannelPreset(),
        headerReasons.value.noCopiedChannel,
      ]),
      run: () => pasteTrackChannelPreset(track.id),
    },
    {
      id: 'save-channel-preset',
      label: t.value.shell.arrangement.trackHeader.savePreset,
      disabledReason: presetStorageBlocked.value,
      run: () => savePreset(track),
    },
    {
      id: 'apply-channel-preset',
      label: t.value.shell.arrangement.trackHeader.applyPreset,
      disabledReason: savedPresetsBlocked.value,
      children: savedTrackPresets.value.map((preset) => ({
        id: `apply-channel-preset-${preset.name}`,
        label: preset.name,
        run: () => applyTrackChannelPreset(track.id, preset),
      })),
    },
    {
      id: 'delete-channel-preset',
      label: t.value.shell.arrangement.trackHeader.deletePreset,
      disabledReason: savedPresetsBlocked.value,
      children: savedTrackPresets.value.map((preset) => ({
        id: `delete-channel-preset-${preset.name}`,
        label: preset.name,
        danger: true,
        run: () => deletePreset(preset.name),
      })),
    },
  );
  items.push(
    { id: 'sep-2', separator: true },
    {
      id: 'color',
      label: t.value.shell.arrangement.trackHeader.nextColor,
      run: () => cycleColor(track),
    },
  );
  if (track.kind !== 'group') {
    items.push({
      id: 'freeze',
      label: track.frozen
        ? t.value.shell.arrangement.trackHeader.unfreeze
        : t.value.shell.arrangement.trackHeader.freeze,
      disabledReason: freezeBlocked(track),
      run: () => {
        void onToggleFreeze(track);
      },
    });
    if (trackHasClips(track)) {
      items.push({
        id: 'bounce',
        label: t.value.shell.arrangement.trackHeader.bounceInPlace,
        disabledReason: bounceBlocked(track),
        run: () => {
          void onBounce(track);
        },
      });
    }
  }
  const groups = store.mixer.vcaGroups ?? [];
  if (groups.length > 0 || groups.length < MAX_VCA_GROUPS) {
    items.push({ id: 'sep-vca', separator: true });
    for (const group of groups) {
      const assigned = track.vcaId === group.id;
      items.push({
        id: `vca-${group.id}`,
        label: group.name,
        checked: assigned,
        run: () => setTrackVca(track.id, assigned ? null : group.id),
      });
    }
    if (groups.length < MAX_VCA_GROUPS) {
      items.push({
        id: 'vca-new',
        label: t.value.shell.arrangement.trackHeader.newVcaGroup,
        run: () => setTrackVca(track.id, addVcaGroup()),
      });
    }
  }
  const generatedPart = partForTrack(track);
  if (generatedPart !== null) {
    items.push(
      { id: 'sep-regenerate', separator: true },
      {
        id: 'regenerate',
        label: t.value.shell.arrangement.trackHeader.regenerate,
        disabledReason: frozenReason(track),
        run: () => emit('regenerateTrack', track.id, generatedPart),
      },
    );
  }
  items.push(
    { id: 'sep-3', separator: true },
    {
      id: 'delete',
      label: t.value.shell.arrangement.trackHeader.removeTrack,
      danger: true,
      run: () => void onDelete(track),
    },
  );
  openContextMenu(event.clientX, event.clientY, items);
}

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
                  @keydown.enter.prevent="commitRename"
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
