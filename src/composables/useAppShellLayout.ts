import { ref } from 'vue';
import {
  ARRANGE_HEIGHT_MAX_PX,
  ARRANGE_HEIGHT_MIN_PX,
  type LayoutBindings,
} from '@/ui/settings/layouts';

const ARRANGE_HEIGHT_KEY = 'sonare-studio.arrangeHeightPx';
const ARRANGE_DEFAULT_HEIGHT = 440;
const DEVICE_RACK_OPEN_KEY = 'sonare-studio.deviceRackOpen';
const DOCK_COLLAPSED_KEY = 'sonare-studio.dockCollapsed';
const SCORE_HEIGHT_KEY = 'sonare-studio.scoreHeightPx';
/** The score is a single continuous line, so it needs only a modest height. */
const SCORE_HEIGHT_MIN_PX = 120;
const SCORE_DEFAULT_HEIGHT = 240;

export type DockTab = 'roll' | 'mixer' | 'mastering' | 'steps' | 'lists' | 'media' | 'sample';

function readStoredNumber(key: string, min: number, fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    if (Number.isFinite(value) && value >= min) return value;
  } catch {
    // Storage access can be denied; fall through to the default.
  }
  return fallback;
}

/** Reads a stored number, or null when absent/invalid (to detect "never set"). */
function readStoredNumberOrNull(key: string, min: number): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= min) return value;
  } catch {
    // Storage access can be denied.
  }
  return null;
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function writeStoredFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Persisting the panel state is best-effort only.
  }
}

export function useAppShellLayout() {
  const arrangeHeight = ref(
    readStoredNumber(ARRANGE_HEIGHT_KEY, ARRANGE_HEIGHT_MIN_PX, ARRANGE_DEFAULT_HEIGHT),
  );
  const deviceRackOpen = ref(readStoredFlag(DEVICE_RACK_OPEN_KEY, false));
  const dockTab = ref<DockTab>('roll');
  const dockCollapsed = ref(readStoredFlag(DOCK_COLLAPSED_KEY, false));
  const scoreVisible = ref(false);
  // Until the user drags the splitter, the score uses a 40% CSS default (tracks
  // the window). The first drag captures the current pixel height and switches
  // to pixel sizing (persisted), so "40%" holds across window sizes.
  const storedScoreHeight = readStoredNumberOrNull(SCORE_HEIGHT_KEY, SCORE_HEIGHT_MIN_PX);
  const scoreResized = ref(storedScoreHeight !== null);
  const scoreHeight = ref(storedScoreHeight ?? SCORE_DEFAULT_HEIGHT);

  let dividerDrag: { startY: number; startHeight: number } | null = null;
  let dividerRaf = 0;
  let dividerPendingY = 0;

  let scoreDrag: { startY: number; startHeight: number } | null = null;
  let scoreRaf = 0;
  let scorePendingY = 0;

  function maxArrangeHeight(): number {
    return Math.max(ARRANGE_HEIGHT_MIN_PX, window.innerHeight - 240);
  }

  function clampArrangeHeight(next: number): number {
    return Math.min(maxArrangeHeight(), Math.max(ARRANGE_HEIGHT_MIN_PX, next));
  }

  function persistArrangeHeight(): void {
    try {
      window.localStorage.setItem(ARRANGE_HEIGHT_KEY, String(Math.round(arrangeHeight.value)));
    } catch {
      // Persisting the height is best-effort only.
    }
  }

  function onDividerPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dividerDrag = { startY: event.clientY, startHeight: arrangeHeight.value };
  }

  function onDividerPointerMove(event: PointerEvent): void {
    if (!dividerDrag) return;
    dividerPendingY = event.clientY;
    if (dividerRaf !== 0) return;
    dividerRaf = requestAnimationFrame(() => {
      dividerRaf = 0;
      if (!dividerDrag) return;
      arrangeHeight.value = clampArrangeHeight(
        dividerDrag.startHeight + (dividerPendingY - dividerDrag.startY),
      );
    });
  }

  function onDividerPointerUp(): void {
    if (!dividerDrag) return;
    dividerDrag = null;
    if (dividerRaf !== 0) {
      cancelAnimationFrame(dividerRaf);
      dividerRaf = 0;
    }
    persistArrangeHeight();
  }

  function onDividerKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 4 : 16;
    let delta = 0;
    if (event.key === 'ArrowUp') delta = -step;
    else if (event.key === 'ArrowDown') delta = step;
    else return;
    event.preventDefault();
    arrangeHeight.value = clampArrangeHeight(arrangeHeight.value + delta);
    persistArrangeHeight();
  }

  /** Upper bound: keep at least ~240px of editor above the score panel. */
  function maxScoreHeight(): number {
    return Math.max(SCORE_HEIGHT_MIN_PX, window.innerHeight - 360);
  }

  function clampScoreHeight(next: number): number {
    return Math.min(maxScoreHeight(), Math.max(SCORE_HEIGHT_MIN_PX, next));
  }

  function persistScoreHeight(): void {
    try {
      window.localStorage.setItem(SCORE_HEIGHT_KEY, String(Math.round(scoreHeight.value)));
    } catch {
      // Persisting the height is best-effort only.
    }
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

  function onScoreDividerPointerMove(event: PointerEvent): void {
    if (!scoreDrag) return;
    scorePendingY = event.clientY;
    if (scoreRaf !== 0) return;
    scoreRaf = requestAnimationFrame(() => {
      scoreRaf = 0;
      if (!scoreDrag) return;
      // The divider sits above the score: dragging up (smaller clientY) grows it.
      scoreHeight.value = clampScoreHeight(
        scoreDrag.startHeight + (scoreDrag.startY - scorePendingY),
      );
    });
  }

  function onScoreDividerPointerUp(): void {
    if (!scoreDrag) return;
    scoreDrag = null;
    if (scoreRaf !== 0) {
      cancelAnimationFrame(scoreRaf);
      scoreRaf = 0;
    }
    persistScoreHeight();
  }

  function onScoreDividerKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 4 : 16;
    let delta = 0;
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
    if (dockCollapsed.value) {
      dockCollapsed.value = false;
      persistDockCollapsed();
    }
  }

  function toggleScorePanel(): void {
    scoreVisible.value = !scoreVisible.value;
    if (scoreVisible.value) selectDockTab('roll');
  }

  function persistDeviceRackOpen(): void {
    writeStoredFlag(DEVICE_RACK_OPEN_KEY, deviceRackOpen.value);
  }

  function disposeLayout(): void {
    if (dividerRaf !== 0) {
      cancelAnimationFrame(dividerRaf);
      dividerRaf = 0;
    }
    if (scoreRaf !== 0) {
      cancelAnimationFrame(scoreRaf);
      scoreRaf = 0;
    }
  }

  const layoutBindings: LayoutBindings = {
    arrangeHeightPx: arrangeHeight,
    dockTab,
    deviceRackOpen,
    scoreOpen: scoreVisible,
    dockCollapsed,
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
