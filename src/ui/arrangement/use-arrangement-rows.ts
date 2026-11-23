/**
 * Row geometry of the arrangement view: vertical scroll and lane height, the
 * automation/take/group expansion sets, the visible track rows and the row
 * layout built from them, plus the handlers that keep the scroll offset valid.
 */

import { computed, type Ref, ref, watch } from 'vue';
import { LANE_HEIGHT_PX, RULER_HEIGHT_PX } from '@/components/arrangement/theme';
import type { AutomationParam } from '@/project/automation';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import {
  AUTOMATION_LANE_HEIGHT_PX,
  buildRowLayout,
  revealRowScrollY,
  trackTakeRowCount,
} from '@/ui/arrangement/automation-rows';
import { visibleGroupRows } from '@/ui/arrangement/group-rows';
import type { TimelineRange } from '@/ui/canvas/timeline-range';

/** Bounds that keep compact overviews useful without making clips illegible. */
const MIN_LANE_HEIGHT_PX = 28;
const MAX_LANE_HEIGHT_PX = 112;

/** Configuration for {@link useArrangementRows}. */
export interface UseArrangementRowsOptions {
  /** Shared timeline range; its height defines the vertical viewport. */
  range: TimelineRange;
  /** Invalidates the views after a scroll or layout mutation. */
  bump: () => void;
}

/** State and handlers returned by {@link useArrangementRows}. */
export interface ArrangementRows {
  scrollY: Ref<number>;
  laneHeight: Ref<number>;
  automationExpandedIds: Ref<number[]>;
  automationParams: Ref<Record<number, AutomationParam>>;
  takesExpandedIds: Ref<number[]>;
  collapsedGroupIds: Ref<number[]>;
  visibleTracks: Readonly<Ref<EditorTrack[]>>;
  visibleTrackIds: Readonly<Ref<number[]>>;
  visibleClips: Readonly<Ref<ReturnType<typeof useProjectStore>['clips']>>;
  rowLayout: Readonly<Ref<ReturnType<typeof buildRowLayout>>>;
  clampScrollY(y: number): number;
  onRevealTrack(trackId: number): void;
  onToggleGroupCollapse(trackId: number, collapsed: boolean): void;
  onToggleAutomation(trackId: number, expanded: boolean): void;
  onAutomationParamChange(trackId: number, param: AutomationParam): void;
  onToggleTakes(trackId: number, expanded: boolean): void;
  zoomVertical(factor: number): void;
  onCanvasResize(): void;
}

/**
 * Owns the arrangement's vertical row state for one view.
 *
 * @param options - The shared range and redraw trigger.
 * @returns The row state refs and the handlers that mutate it.
 */
export function useArrangementRows(options: UseArrangementRowsOptions): ArrangementRows {
  const { range, bump } = options;
  const store = useProjectStore();

  /** Vertical scroll offset of the track lanes in px (shared with the headers). */
  const scrollY = ref(0);
  /** View-local track-row height, shared by the canvas and track-header column. */
  const laneHeight = ref(LANE_HEIGHT_PX);

  // --- Automation sublane state ----------------------------------------------

  /** Ids of tracks whose automation sublane is expanded (view-local state). */
  const automationExpandedIds = ref<number[]>([]);

  /** Selected automation parameter per track id (absent = 'faderDb'). */
  const automationParams = ref<Record<number, AutomationParam>>({});

  /** Ids of tracks whose take sub-rows are expanded (view-local state). */
  const takesExpandedIds = ref<number[]>([]);

  /** Group tracks whose member rows are hidden in this arrangement view. */
  const collapsedGroupIds = ref<number[]>([]);

  /** Tracks participating in the current visual row layout. */
  const visibleTracks = computed(() => {
    return visibleGroupRows(store.tracks, new Set(collapsedGroupIds.value));
  });

  /** Ids of the visible tracks in row order. */
  const visibleTrackIds = computed(() => visibleTracks.value.map((track) => track.id));

  /** Clips drawn and hit-tested in the currently visible track rows. */
  const visibleClips = computed(() => {
    const ids = new Set(visibleTrackIds.value);
    return store.clips.filter((clip) => ids.has(clip.trackId));
  });

  /** Row layout reflecting which tracks show take sub-rows or an automation sublane. */
  const rowLayout = computed(() => {
    const expanded = new Set(automationExpandedIds.value);
    const takesExpanded = new Set(takesExpandedIds.value);
    return buildRowLayout(
      visibleTracks.value.map((track) => expanded.has(track.id)),
      laneHeight.value,
      AUTOMATION_LANE_HEIGHT_PX,
      visibleTracks.value.map((track) =>
        takesExpanded.has(track.id) ? trackTakeRowCount(store.clips, track.id) : 0,
      ),
    );
  });

  /**
   * Scrolls the shared vertical offset so `trackId`'s row is fully visible.
   * The header column has no scroll state of its own (see TrackHeaderList's
   * `revealTrack` emit), so this is the only place a row is brought into view.
   */
  function onRevealTrack(trackId: number): void {
    const index = visibleTracks.value.findIndex((track) => track.id === trackId);
    if (index < 0) return;
    const viewport = Math.max(0, range.heightPx - RULER_HEIGHT_PX);
    const next = revealRowScrollY(rowLayout.value, index, scrollY.value, viewport);
    if (next === null) return;
    scrollY.value = clampScrollY(next);
    bump();
  }

  // A clip added from the media browser can create a track below the viewport.
  // Keep the newly selected track and its clip visible without moving the view
  // again while the user edits other clips on that track.
  watch(
    () => store.activeTrackId,
    (trackId) => onRevealTrack(trackId),
    { flush: 'post' },
  );

  function onToggleGroupCollapse(trackId: number, collapsed: boolean): void {
    const ids = collapsedGroupIds.value.filter((id) => id !== trackId);
    if (collapsed) ids.push(trackId);
    collapsedGroupIds.value = ids;
    scrollY.value = clampScrollY(scrollY.value);
    bump();
  }

  watch(
    () => store.tracks.map((track) => ({ id: track.id, kind: track.kind })),
    (tracks) => {
      const groupIds = new Set(
        tracks.filter((track) => track.kind === 'group').map((track) => track.id),
      );
      const next = collapsedGroupIds.value.filter((id) => groupIds.has(id));
      if (next.length !== collapsedGroupIds.value.length) collapsedGroupIds.value = next;
    },
  );

  function onToggleAutomation(trackId: number, expanded: boolean): void {
    const ids = automationExpandedIds.value.filter((id) => id !== trackId);
    if (expanded) ids.push(trackId);
    automationExpandedIds.value = ids;
    // Collapsing shrinks the content extent below the current scroll offset.
    scrollY.value = clampScrollY(scrollY.value);
    bump();
  }

  function onAutomationParamChange(trackId: number, param: AutomationParam): void {
    automationParams.value = { ...automationParams.value, [trackId]: param };
  }

  function onToggleTakes(trackId: number, expanded: boolean): void {
    const ids = takesExpandedIds.value.filter((id) => id !== trackId);
    if (expanded) ids.push(trackId);
    takesExpandedIds.value = ids;
    // Collapsing shrinks the content extent below the current scroll offset.
    scrollY.value = clampScrollY(scrollY.value);
    bump();
  }

  /** Clamps the lane scroll offset to the track content extent. */
  function clampScrollY(y: number): number {
    const viewport = Math.max(0, range.heightPx - RULER_HEIGHT_PX);
    const content = rowLayout.value.totalHeight;
    return Math.min(Math.max(0, content - viewport), Math.max(0, y));
  }

  /** Zooms track rows vertically while keeping the current viewport position stable. */
  function zoomVertical(factor: number): void {
    const previous = laneHeight.value;
    const next = Math.min(
      MAX_LANE_HEIGHT_PX,
      Math.max(MIN_LANE_HEIGHT_PX, Math.round(previous * factor)),
    );
    if (next === previous) return;
    laneHeight.value = next;
    scrollY.value = clampScrollY(scrollY.value * (next / previous));
    bump();
  }

  function onCanvasResize(): void {
    scrollY.value = clampScrollY(scrollY.value);
    bump();
  }

  // Track removal or take-lane changes (e.g. flattening a comp) can shrink the
  // content extent below the current scroll.
  watch(
    () => rowLayout.value.totalHeight,
    () => {
      scrollY.value = clampScrollY(scrollY.value);
      bump();
    },
  );

  return {
    scrollY,
    laneHeight,
    automationExpandedIds,
    automationParams,
    takesExpandedIds,
    collapsedGroupIds,
    visibleTracks,
    visibleTrackIds,
    visibleClips,
    rowLayout,
    clampScrollY,
    onRevealTrack,
    onToggleGroupCollapse,
    onToggleAutomation,
    onAutomationParamChange,
    onToggleTakes,
    zoomVertical,
    onCanvasResize,
  };
}
