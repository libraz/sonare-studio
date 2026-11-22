/**
 * Workspace layout model: the snapshot of shell layout state that named
 * layouts capture and re-apply, plus the built-in presets and the storage
 * codec for user-saved layouts.
 *
 * The shell passes its layout refs as a {@link LayoutBindings} map; capture
 * reads them, apply writes them. The module itself never touches the DOM or
 * any store.
 */

import type { Ref } from 'vue';
import { clamp, isFiniteNumber } from '@/lib/math';

/** Editor dock tabs (mirrors the shell's dock tab union). */
export const DOCK_TABS = [
  'roll',
  'mixer',
  'mastering',
  'steps',
  'lists',
  'media',
  'sample',
] as const;

/** One editor dock tab id. */
export type DockTabId = (typeof DOCK_TABS)[number];

/** Bounds for the arrangement zone height in pixels. */
export const ARRANGE_HEIGHT_MIN_PX = 120;
export const ARRANGE_HEIGHT_MAX_PX = 2000;

/** Snapshot of the shell's workspace layout. */
export interface WorkspaceLayoutState {
  /** Arrangement zone height in pixels (the horizontal split position). */
  arrangeHeightPx: number;
  /** Active editor dock tab. */
  dockTab: DockTabId;
  /** Whether the device rack panel is visible. */
  deviceRackOpen: boolean;
  /** Whether the score panel is visible below the piano roll. */
  scoreOpen: boolean;
  /** Whether the editor dock is collapsed to its tab strip. */
  dockCollapsed: boolean;
}

/** A layout with a user-facing name (preset or user-saved). */
export interface NamedLayout {
  name: string;
  state: WorkspaceLayoutState;
}

/**
 * Resolves a layout name for display without changing its persisted identity.
 * Built-in presets use stable English ids in project/storage state; callers
 * provide the active locale's preset-name map, while user-saved names pass
 * through unchanged.
 */
export function localizedLayoutName(
  name: string,
  presetNames: Readonly<Record<string, string>>,
): string {
  return presetNames[name] ?? name;
}

/** The shell refs a layout reads from and writes to. */
export interface LayoutBindings {
  arrangeHeightPx: Ref<number>;
  dockTab: Ref<DockTabId>;
  deviceRackOpen: Ref<boolean>;
  scoreOpen: Ref<boolean>;
  dockCollapsed: Ref<boolean>;
}

/**
 * Built-in workspace presets. The arrangement is the primary surface, so its
 * zone is the larger share; Mix gives the mixer dock more room.
 */
export const LAYOUT_PRESETS: ReadonlyArray<NamedLayout> = [
  {
    name: 'Compose',
    state: {
      arrangeHeightPx: 440,
      dockTab: 'roll',
      deviceRackOpen: true,
      scoreOpen: false,
      dockCollapsed: false,
    },
  },
  {
    name: 'Mix',
    state: {
      arrangeHeightPx: 300,
      dockTab: 'mixer',
      deviceRackOpen: false,
      scoreOpen: false,
      dockCollapsed: false,
    },
  },
  {
    name: 'Score',
    state: {
      arrangeHeightPx: 320,
      dockTab: 'roll',
      deviceRackOpen: false,
      scoreOpen: true,
      dockCollapsed: false,
    },
  },
  {
    name: 'Arrange',
    state: {
      arrangeHeightPx: 600,
      dockTab: 'roll',
      deviceRackOpen: false,
      scoreOpen: false,
      dockCollapsed: true,
    },
  },
];

/** Maximum number of user-saved layouts kept in storage. */
export const MAX_USER_LAYOUTS = 32;

/** Storage schema version for the saved-layouts envelope. */
export const LAYOUTS_VERSION = 2;

/**
 * Validates a raw layout state, clamping numbers and defaulting bad fields.
 *
 * @param raw Untrusted value.
 * @returns A valid state, or null when raw is not an object at all.
 */
export function sanitizeLayoutState(raw: unknown): WorkspaceLayoutState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const fallback = LAYOUT_PRESETS[0].state;
  const height = isFiniteNumber(source.arrangeHeightPx)
    ? clamp(Math.round(source.arrangeHeightPx), ARRANGE_HEIGHT_MIN_PX, ARRANGE_HEIGHT_MAX_PX)
    : fallback.arrangeHeightPx;
  const dockTab = DOCK_TABS.includes(source.dockTab as DockTabId)
    ? (source.dockTab as DockTabId)
    : fallback.dockTab;
  return {
    arrangeHeightPx: height,
    dockTab,
    deviceRackOpen:
      typeof source.deviceRackOpen === 'boolean' ? source.deviceRackOpen : fallback.deviceRackOpen,
    scoreOpen: typeof source.scoreOpen === 'boolean' ? source.scoreOpen : fallback.scoreOpen,
    dockCollapsed:
      typeof source.dockCollapsed === 'boolean' ? source.dockCollapsed : fallback.dockCollapsed,
  };
}

/** Reads the current layout from the shell's refs. */
export function captureLayoutState(bindings: LayoutBindings): WorkspaceLayoutState {
  return {
    arrangeHeightPx: bindings.arrangeHeightPx.value,
    dockTab: bindings.dockTab.value,
    deviceRackOpen: bindings.deviceRackOpen.value,
    scoreOpen: bindings.scoreOpen.value,
    dockCollapsed: bindings.dockCollapsed.value,
  };
}

/** Writes a layout into the shell's refs (validating/clamping first). */
export function applyLayoutState(state: WorkspaceLayoutState, bindings: LayoutBindings): void {
  const safe = sanitizeLayoutState(state);
  if (safe === null) return;
  bindings.arrangeHeightPx.value = safe.arrangeHeightPx;
  bindings.dockTab.value = safe.dockTab;
  bindings.deviceRackOpen.value = safe.deviceRackOpen;
  bindings.scoreOpen.value = safe.scoreOpen;
  bindings.dockCollapsed.value = safe.dockCollapsed;
}

/** Encodes user layouts into the versioned JSON envelope for storage. */
export function encodeUserLayouts(layouts: ReadonlyArray<NamedLayout>): string {
  return JSON.stringify({ version: LAYOUTS_VERSION, layouts });
}

/**
 * Decodes stored user layouts, dropping entries that fail validation.
 *
 * @param text The stored JSON text, or null when nothing is stored.
 * @returns Valid named layouts (empty on missing/corrupt payloads).
 */
export function decodeUserLayouts(text: string | null): NamedLayout[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const list = (parsed as { layouts?: unknown }).layouts;
  if (!Array.isArray(list)) return [];
  const out: NamedLayout[] = [];
  for (const entry of list) {
    if (out.length >= MAX_USER_LAYOUTS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, state } = entry as { name?: unknown; state?: unknown };
    if (typeof name !== 'string' || name.trim() === '') continue;
    const safe = sanitizeLayoutState(state);
    if (safe === null) continue;
    if (out.some((existing) => existing.name === name)) continue;
    out.push({ name, state: safe });
  }
  return out;
}
