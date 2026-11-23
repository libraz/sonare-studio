import { computed, type Ref, ref } from 'vue';
import { readLocalStorage, writeLocalStorage } from '@/lib/local-storage';
import {
  ARRANGE_HEIGHT_MAX_PX,
  ARRANGE_HEIGHT_MIN_PX,
  type LayoutBindings,
} from '@/ui/settings/layouts';

const ARRANGE_HEIGHT_KEY = 'sonare-studio.arrangeHeightPx';
const ARRANGE_DEFAULT_HEIGHT = 440;
const DEVICE_RACK_OPEN_KEY = 'sonare-studio.deviceRackOpen';
const DOCK_COLLAPSED_KEY = 'sonare-studio.dockCollapsed';
const DOCK_TAB_KEY = 'sonare-studio.dockTab';
const SCORE_HEIGHT_KEY = 'sonare-studio.scoreHeightPx';
const SCORE_VISIBLE_KEY = 'sonare-studio.scoreVisible';
/** The score is a single continuous line, so it needs only a modest height. */
const SCORE_HEIGHT_MIN_PX = 120;
const SCORE_DEFAULT_HEIGHT = 240;
// Reserve room for the dock tabs, editing toolbars, a useful piano-roll canvas,
// and the transport. Without this the editor canvas collapses at 720px height.
const ARRANGE_VIEWPORT_RESERVE_PX = 490;
const SCORE_VIEWPORT_RESERVE_PX = 360;

export type DockTab = 'roll' | 'mixer' | 'mastering' | 'steps' | 'lists' | 'media' | 'sample';

const DOCK_TABS: ReadonlySet<DockTab> = new Set([
  'roll',
  'mixer',
  'mastering',
  'steps',
  'lists',
  'media',
  'sample',
]);

/** Viewport-aware upper bound that keeps the editor canvas usable. */
export function maximumArrangementHeight(viewportHeight: number): number {
  const height = Number.isFinite(viewportHeight) ? viewportHeight : ARRANGE_DEFAULT_HEIGHT;
  return Math.max(
    ARRANGE_HEIGHT_MIN_PX,
    Math.min(ARRANGE_HEIGHT_MAX_PX, height - ARRANGE_VIEWPORT_RESERVE_PX),
  );
}

/** Clamps a stored, dragged or layout-applied arrangement height to the viewport. */
export function clampArrangementHeight(next: number, viewportHeight: number): number {
  return Math.min(maximumArrangementHeight(viewportHeight), Math.max(ARRANGE_HEIGHT_MIN_PX, next));
}

function readStoredNumber(key: string, min: number, fallback: number): number {
  const raw = readLocalStorage(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/** Reads a stored number, or null when absent/invalid (to detect "never set"). */
function readStoredNumberOrNull(key: string, min: number): number | null {
  const raw = readLocalStorage(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : null;
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  const value = readLocalStorage(key);
  return value === null ? fallback : value === '1';
}

function writeStoredFlag(key: string, value: boolean): void {
  writeLocalStorage(key, value ? '1' : '0');
}

function readStoredDockTab(): DockTab {
  const tab = readLocalStorage(DOCK_TAB_KEY);
  return tab !== null && DOCK_TABS.has(tab as DockTab) ? (tab as DockTab) : 'roll';
}

function persistDockTab(tab: DockTab): void {
  writeLocalStorage(DOCK_TAB_KEY, tab);
}

export function useAppShellLayout() {
  const arrangeHeight = ref(
    clampArrangementHeight(
      readStoredNumber(ARRANGE_HEIGHT_KEY, ARRANGE_HEIGHT_MIN_PX, ARRANGE_DEFAULT_HEIGHT),
      window.innerHeight,
    ),
  );
  const deviceRackOpen = ref(readStoredFlag(DEVICE_RACK_OPEN_KEY, false));
  const dockTab = ref<DockTab>(readStoredDockTab());
  const dockCollapsed = ref(readStoredFlag(DOCK_COLLAPSED_KEY, false));
  const scoreVisible = ref(readStoredFlag(SCORE_VISIBLE_KEY, false));
  // Until the user drags the splitter, the score uses a 40% CSS default (tracks
  // the window). The first drag captures the current pixel height and switches
  // to pixel sizing (persisted), so "40%" holds across window sizes.
  const storedScoreHeight = readStoredNumberOrNull(SCORE_HEIGHT_KEY, SCORE_HEIGHT_MIN_PX);
  const scoreResized = ref(storedScoreHeight !== null);
  const scoreHeight = ref(
    Math.min(
      Math.max(SCORE_HEIGHT_MIN_PX, window.innerHeight - SCORE_VIEWPORT_RESERVE_PX),
      storedScoreHeight ?? SCORE_DEFAULT_HEIGHT,
    ),
  );

  let dividerDrag: { startY: number; startHeight: number } | null = null;
  let dividerRaf = 0;
  let dividerPendingY = 0;

  let scoreDrag: { startY: number; startHeight: number } | null = null;
  let scoreRaf = 0;
  let scorePendingY = 0;

  function clampArrangeHeight(next: number): number {
    return clampArrangementHeight(next, window.innerHeight);
  }

  function persistArrangeHeight(): void {
    writeLocalStorage(ARRANGE_HEIGHT_KEY, String(Math.round(arrangeHeight.value)));
  }

  function onDividerPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dividerDrag = { startY: event.clientY, startHeight: arrangeHeight.value };
  }

  function applyDividerSample(): void {
    if (!dividerDrag) return;
    arrangeHeight.value = clampArrangeHeight(
      dividerDrag.startHeight + (dividerPendingY - dividerDrag.startY),
    );
  }

  function onDividerPointerMove(event: PointerEvent): void {
    if (!dividerDrag) return;
    dividerPendingY = event.clientY;
    if (dividerRaf !== 0) return;
    dividerRaf = requestAnimationFrame(() => {
      dividerRaf = 0;
      applyDividerSample();
    });
  }

  function onDividerPointerUp(): void {
    if (!dividerDrag) return;
    if (dividerRaf !== 0) {
      // The release can land before the queued frame: apply its sample now.
      cancelAnimationFrame(dividerRaf);
      dividerRaf = 0;
      applyDividerSample();
    }
    dividerDrag = null;
    persistArrangeHeight();
  }

  function onDividerKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 4 : 16;
    let next: number;
    if (event.key === 'Home') next = ARRANGE_HEIGHT_MIN_PX;
    else if (event.key === 'End') next = maximumArrangementHeight(window.innerHeight);
    else if (event.key === 'ArrowUp') next = arrangeHeight.value - step;
    else if (event.key === 'ArrowDown') next = arrangeHeight.value + step;
    else return;
    event.preventDefault();
    arrangeHeight.value = clampArrangeHeight(next);
    persistArrangeHeight();
  }

  /** Upper bound: keep at least ~240px of editor above the score panel. */
  function maxScoreHeight(): number {
    return Math.max(SCORE_HEIGHT_MIN_PX, window.innerHeight - SCORE_VIEWPORT_RESERVE_PX);
  }

  function clampScoreHeight(next: number): number {
    return Math.min(maxScoreHeight(), Math.max(SCORE_HEIGHT_MIN_PX, next));
  }

  function persistScoreHeight(): void {
    writeLocalStorage(SCORE_HEIGHT_KEY, String(Math.round(scoreHeight.value)));
  }

  /** Current rendered pixel height of the score panel (the divider's next sibling). */
  function scoreElementHeight(divider: HTMLElement): number {
    const el = divider.nextElementSibling as HTMLElement | null;
    return el ? el.getBoundingClientRect().height : scoreHeight.value;
  }

  function onScoreDividerPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const divider = event.currentTarget as HTMLElement;
    divider.setPointerCapture(event.pointerId);
    // Seed from the actual height so switching from the 40% default to pixel
    // sizing does not jump, then take over with pixels.
    const startHeight = clampScoreHeight(scoreElementHeight(divider));
    scoreHeight.value = startHeight;
    scoreResized.value = true;
    scoreDrag = { startY: event.clientY, startHeight };
  }

  function applyScoreSample(): void {
    if (!scoreDrag) return;
    // The divider sits above the score: dragging up (smaller clientY) grows it.
    scoreHeight.value = clampScoreHeight(
      scoreDrag.startHeight + (scoreDrag.startY - scorePendingY),
    );
  }

  function onScoreDividerPointerMove(event: PointerEvent): void {
    if (!scoreDrag) return;
    scorePendingY = event.clientY;
    if (scoreRaf !== 0) return;
    scoreRaf = requestAnimationFrame(() => {
      scoreRaf = 0;
      applyScoreSample();
    });
  }

  function onScoreDividerPointerUp(): void {
    if (!scoreDrag) return;
    if (scoreRaf !== 0) {
      // The release can land before the queued frame: apply its sample now.
      cancelAnimationFrame(scoreRaf);
      scoreRaf = 0;
      applyScoreSample();
    }
    scoreDrag = null;
    persistScoreHeight();
  }

  function onScoreDividerKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 4 : 16;
    if (event.key === 'Home') {
      event.preventDefault();
      scoreResized.value = true;
      scoreHeight.value = SCORE_HEIGHT_MIN_PX;
      persistScoreHeight();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      scoreResized.value = true;
      scoreHeight.value = maxScoreHeight();
      persistScoreHeight();
      return;
    }
    let delta: number;
    if (event.key === 'ArrowUp') delta = step;
    else if (event.key === 'ArrowDown') delta = -step;
    else return;
    event.preventDefault();
    // Seed from the rendered height on the first keyboard resize (still in the
    // 40% default), then take over with pixels.
    const base = scoreResized.value
      ? scoreHeight.value
      : clampScoreHeight(scoreElementHeight(event.currentTarget as HTMLElement));
    scoreResized.value = true;
    scoreHeight.value = clampScoreHeight(base + delta);
    persistScoreHeight();
  }

  function toggleDeviceRack(): void {
    deviceRackOpen.value = !deviceRackOpen.value;
    writeStoredFlag(DEVICE_RACK_OPEN_KEY, deviceRackOpen.value);
  }

  function persistDockCollapsed(): void {
    writeStoredFlag(DOCK_COLLAPSED_KEY, dockCollapsed.value);
  }

  function toggleDockCollapsed(): void {
    dockCollapsed.value = !dockCollapsed.value;
    persistDockCollapsed();
  }

  function selectDockTab(tab: DockTab): void {
    dockTab.value = tab;
    persistDockTab(tab);
    if (dockCollapsed.value) {
      dockCollapsed.value = false;
      persistDockCollapsed();
    }
  }

  function toggleScorePanel(): void {
    scoreVisible.value = !scoreVisible.value;
    writeStoredFlag(SCORE_VISIBLE_KEY, scoreVisible.value);
    if (scoreVisible.value) selectDockTab('roll');
  }

  function persistDeviceRackOpen(): void {
    writeStoredFlag(DEVICE_RACK_OPEN_KEY, deviceRackOpen.value);
  }

  /** Keeps persisted and currently applied split positions reachable after resize. */
  function clampLayoutToViewport(): void {
    const nextArrangeHeight = clampArrangeHeight(arrangeHeight.value);
    if (nextArrangeHeight !== arrangeHeight.value) {
      arrangeHeight.value = nextArrangeHeight;
      persistArrangeHeight();
    }
    if (scoreResized.value) {
      const nextScoreHeight = clampScoreHeight(scoreHeight.value);
      if (nextScoreHeight !== scoreHeight.value) {
        scoreHeight.value = nextScoreHeight;
        persistScoreHeight();
      }
    }
  }

  window.addEventListener('resize', clampLayoutToViewport);

  function disposeLayout(): void {
    window.removeEventListener('resize', clampLayoutToViewport);
    if (dividerRaf !== 0) {
      cancelAnimationFrame(dividerRaf);
      dividerRaf = 0;
    }
    if (scoreRaf !== 0) {
      cancelAnimationFrame(scoreRaf);
      scoreRaf = 0;
    }
  }

  const layoutArrangeHeight = computed({
    get: () => arrangeHeight.value,
    set: (next: number) => {
      arrangeHeight.value = clampArrangeHeight(next);
      persistArrangeHeight();
    },
  });

  // Every field a layout writes is persisted by its binding, so the Layout
  // menu and Settings apply paths both survive a reload.
  const persistedFlag = (flag: Ref<boolean>, key: string) =>
    computed({
      get: () => flag.value,
      set: (next: boolean) => {
        flag.value = next;
        writeStoredFlag(key, next);
      },
    });

  const layoutBindings: LayoutBindings = {
    arrangeHeightPx: layoutArrangeHeight,
    dockTab: computed({
      get: () => dockTab.value,
      set: (next: DockTab) => {
        dockTab.value = next;
        persistDockTab(next);
      },
    }),
    deviceRackOpen: persistedFlag(deviceRackOpen, DEVICE_RACK_OPEN_KEY),
    scoreOpen: persistedFlag(scoreVisible, SCORE_VISIBLE_KEY),
    dockCollapsed: persistedFlag(dockCollapsed, DOCK_COLLAPSED_KEY),
  };

  return {
    arrangeHeight,
    deviceRackOpen,
    dockTab,
    dockCollapsed,
    arrangeHeightMin: ARRANGE_HEIGHT_MIN_PX,
    arrangeHeightMax: ARRANGE_HEIGHT_MAX_PX,
    scoreVisible,
    scoreHeight,
    scoreResized,
    scoreHeightMin: SCORE_HEIGHT_MIN_PX,
    scoreHeightMax: computed(() => maxScoreHeight()),
    layoutBindings,
    onDividerPointerDown,
    onDividerPointerMove,
    onDividerPointerUp,
    onDividerKeydown,
    onScoreDividerPointerDown,
    onScoreDividerPointerMove,
    onScoreDividerPointerUp,
    onScoreDividerKeydown,
    persistArrangeHeight,
    persistDeviceRackOpen,
    persistDockCollapsed,
    disposeLayout,
    toggleDeviceRack,
    toggleDockCollapsed,
    selectDockTab,
    toggleScorePanel,
  };
}
