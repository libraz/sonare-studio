/**
 * Playhead highlight sync for the engraved score.
 *
 * Scans the Verovio timemap forward to find the note ids sounding at the
 * current playhead position and draws absolutely-positioned overlay markers
 * above the matching `<g class="note">` elements. The scan is incremental
 * (amortized O(1) per frame) and resets on every re-render or backwards seek.
 *
 * A timemap `qstamp` counts quarter notes from the start of measure 1, and
 * measure 1 begins at the clip start, so the lookup position is
 * `ppq - clipStartPpq` (constant-tempo identity in quarter-note PPQ).
 */

import { onScopeDispose, type Ref, watchEffect } from 'vue';
import type { VerovioTimemapEntry } from '@/notation/verovio';
import { nextHorizontalFollowScrollLeft } from '@/ui/arrangement/playhead-follow';

const FOLLOW_INTERVAL_MS = 120;
const MIN_SCROLL_DELTA_PX = 2;
const OVERLAY_CLASS = 'score-playhead-overlay';
const MARKER_CLASS = 'score-playhead-marker';
const POSITIONED_CLASS = 'is-positioned';
const MARKER_PAD_X = 8;
const MARKER_PAD_Y = 6;
const MARKER_MIN_WIDTH = 22;
const MARKER_MIN_HEIGHT = 24;
const PREWARM_BATCH_SIZE = 8;
const MARKER_GROUP_X_GAP = 28;

interface IdleDeadlineLike {
  timeRemaining(): number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

interface ElementBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  scrollWidth: number;
  scrollHeight: number;
}

interface ScanResult {
  ids: ReadonlySet<string>;
  measureId: string | null;
}

interface MarkerGroup {
  key: string;
  ids: string[];
  bounds: Pick<ElementBounds, 'left' | 'right' | 'top' | 'bottom'>;
  /** True for the whole-measure band drawn during playback. */
  measure?: boolean;
}

/** Options wiring the playhead sync to the rendered score. */
export interface PlayheadSyncOptions {
  /** Host element holding the rendered SVG. */
  svgHost: Ref<HTMLElement | null>;
  /** The rendered SVG string; tracked so the highlight re-applies after renders. */
  svg: Ref<string>;
  /** Reads the loaded score's timemap (paired with the current SVG's ids). */
  getTimemap: () => ReadonlyArray<VerovioTimemapEntry>;
  /** Clip start in PPQ (timemap qstamp origin). */
  getClipStartPpq: () => number;
  /** Reads the playhead position in PPQ, or undefined to disable the highlight. */
  getPositionPpq: () => (() => number) | undefined;
  /** True while the transport is playing; enables horizontal score following. */
  getIsPlaying?: () => boolean;
}

/** The playhead sync surface bound by the score panel. */
export interface PlayheadSync {
  /** Resets the incremental scan; call after every render / layout change. */
  resetScan: () => void;
}

/** Wires the playhead highlight to the rendered score and timemap. */
export function usePlayheadSync(options: PlayheadSyncOptions): PlayheadSync {
  // Incremental timemap scan state (reset on every render / backwards seek).
  let scanIndex = 0;
  let scanQstamp = Number.NEGATIVE_INFINITY;
  let currentMeasureId: string | null = null;
  const soundingIds = new Set<string>();
  const noteElements = new Map<string, Element>();
  const measureElements = new Map<string, Element>();
  const boundsCache = new Map<string, ElementBounds>();
  const markerElements = new Map<string, HTMLElement>();
  let indexedSvg = '';
  let followedTargetKey: string | null = null;
  let lastFollowMs = Number.NEGATIVE_INFINITY;
  let prewarmToken = 0;

  function clearMarkers(): void {
    for (const marker of markerElements.values()) marker.remove();
    markerElements.clear();
  }

  function resetScan(): void {
    clearMarkers();
    scanIndex = 0;
    scanQstamp = Number.NEGATIVE_INFINITY;
    currentMeasureId = null;
    soundingIds.clear();
    noteElements.clear();
    measureElements.clear();
    boundsCache.clear();
    indexedSvg = '';
    followedTargetKey = null;
    lastFollowMs = Number.NEGATIVE_INFINITY;
    prewarmToken++;
  }

  function ensureOverlay(host: HTMLElement): HTMLElement {
    const existing = host.querySelector(`.${OVERLAY_CLASS}`);
    if (existing instanceof HTMLElement) return existing;
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('aria-hidden', 'true');
    host.append(overlay);
    return overlay;
  }

  function buildElementIndex(host: HTMLElement): void {
    const svg = options.svg.value;
    if (svg === indexedSvg && noteElements.size > 0) return;
    clearMarkers();
    noteElements.clear();
    measureElements.clear();
    boundsCache.clear();
    followedTargetKey = null;
    indexedSvg = svg;

    const allById = new Map<string, Element>();
    for (const el of host.querySelectorAll('[id]')) {
      const id = el.getAttribute('id');
      if (id) allById.set(id, el);
    }
    for (const el of host.querySelectorAll('g.note[id]')) {
      const id = el.getAttribute('id');
      if (id) noteElements.set(id, el);
    }
    for (const entry of options.getTimemap()) {
      if (!entry.measureOn || measureElements.has(entry.measureOn)) continue;
      const el = allById.get(entry.measureOn);
      if (el) measureElements.set(entry.measureOn, el);
    }
    scheduleMeasureBoundsPrewarm(host);
  }

  function scheduleIdle(callback: IdleCallback): void {
    const requestIdle = (
      globalThis as {
        requestIdleCallback?: (callback: IdleCallback) => number;
      }
    ).requestIdleCallback;
    if (requestIdle) {
      requestIdle(callback);
      return;
    }
    window.setTimeout(() => callback({ timeRemaining: () => 8 }), 0);
  }

  function scheduleMeasureBoundsPrewarm(host: HTMLElement): void {
    if (measureElements.size === 0) return;
    const token = ++prewarmToken;
    const entries = [...measureElements.entries()];
    let index = 0;
    const run: IdleCallback = (deadline) => {
      if (token !== prewarmToken) return;
      let measured = 0;
      while (
        index < entries.length &&
        (deadline.timeRemaining() > 2 || measured < PREWARM_BATCH_SIZE)
      ) {
        const [id, el] = entries[index++];
        elementBounds(host, `measure:${id}`, el);
        measured++;
      }
      if (index < entries.length) scheduleIdle(run);
    };
    scheduleIdle(run);
  }

  function elementBounds(host: HTMLElement, key: string, el: Element): ElementBounds | null {
    const cached = boundsCache.get(key);
    if (
      cached &&
      cached.scrollWidth === host.scrollWidth &&
      cached.scrollHeight === host.scrollHeight
    ) {
      return cached;
    }
    const hostRect = host.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const left = host.scrollLeft + elRect.left - hostRect.left;
    const right = host.scrollLeft + elRect.right - hostRect.left;
    const top = host.scrollTop + elRect.top - hostRect.top;
    const bottom = host.scrollTop + elRect.bottom - hostRect.top;
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      !Number.isFinite(top) ||
      !Number.isFinite(bottom)
    ) {
      return null;
    }
    const bounds = {
      left,
      right,
      top,
      bottom,
      scrollWidth: host.scrollWidth,
      scrollHeight: host.scrollHeight,
    };
    boundsCache.set(key, bounds);
    return bounds;
  }

  /** Note ids sounding at a quarter-note position (amortized forward scan). */
  function scanAt(qpos: number): ScanResult {
    const timemap = options.getTimemap();
    if (qpos < scanQstamp) {
      scanIndex = 0;
      currentMeasureId = null;
      soundingIds.clear();
    }
    scanQstamp = qpos;
    while (scanIndex < timemap.length && timemap[scanIndex].qstamp <= qpos) {
      const entry = timemap[scanIndex];
      if (entry.measureOn) currentMeasureId = entry.measureOn;
      for (const id of entry.off ?? []) soundingIds.delete(id);
      for (const id of entry.on ?? []) soundingIds.add(id);
      scanIndex++;
    }
    return { ids: soundingIds, measureId: currentMeasureId };
  }

  function markerGroups(host: HTMLElement, result: ScanResult, playing: boolean): MarkerGroup[] {
    if (playing && result.measureId) {
      const el = measureElements.get(result.measureId);
      const bounds = el ? elementBounds(host, `measure:${result.measureId}`, el) : null;
      if (bounds) {
        return [
          {
            // Stable key (not per-measure) so the same element is reused and
            // glides from measure to measure instead of popping in fresh.
            key: 'measure',
            ids: [...result.ids],
            bounds,
            measure: true,
          },
        ];
      }
    }
    const items = [...result.ids]
      .map((id) => {
        const el = noteElements.get(id);
        if (!el) return null;
        const bounds = elementBounds(host, `note:${id}`, el);
        return bounds ? { id, bounds } : null;
      })
      .filter((item) => item !== null)
      .sort((a, b) => a.bounds.left - b.bounds.left || a.bounds.top - b.bounds.top);
    const groups: MarkerGroup[] = [];
    for (const item of items) {
      const group = groups.at(-1);
      if (group && item.bounds.left <= group.bounds.right + MARKER_GROUP_X_GAP) {
        group.ids.push(item.id);
        group.bounds.left = Math.min(group.bounds.left, item.bounds.left);
        group.bounds.right = Math.max(group.bounds.right, item.bounds.right);
        group.bounds.top = Math.min(group.bounds.top, item.bounds.top);
        group.bounds.bottom = Math.max(group.bounds.bottom, item.bounds.bottom);
      } else {
        groups.push({
          key: `group:${groups.length}`,
          ids: [item.id],
          bounds: { ...item.bounds },
        });
      }
    }
    return groups;
  }

  function updateMarkers(host: HTMLElement, result: ScanResult, playing: boolean): void {
    const overlay = ensureOverlay(host);
    const groups = markerGroups(host, result, playing);
    const activeKeys = new Set(groups.map((group) => group.key));
    for (const [key, marker] of [...markerElements]) {
      if (!activeKeys.has(key)) {
        marker.remove();
        markerElements.delete(key);
      }
    }
    for (const group of groups) {
      const { bounds } = group;
      const existing = markerElements.get(group.key);
      const marker = existing ?? document.createElement('div');
      if (!existing) {
        marker.className = `${MARKER_CLASS} ${
          group.measure ? `${MARKER_CLASS}-measure` : `${MARKER_CLASS}-note`
        }`;
        overlay.append(marker);
        markerElements.set(group.key, marker);
      }
      marker.dataset.noteIds = group.ids.join(' ');
      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      const markerWidth = Math.max(MARKER_MIN_WIDTH, width + MARKER_PAD_X * 2);
      const markerHeight = Math.max(MARKER_MIN_HEIGHT, height + MARKER_PAD_Y * 2);
      const markerLeft = bounds.left + width / 2 - markerWidth / 2;
      const markerTop = bounds.top + height / 2 - markerHeight / 2;
      // Enable the glide only once the marker has been placed; the first frame
      // positions it without a transition so it never animates from the origin.
      if (existing) marker.classList.add(POSITIONED_CLASS);
      marker.style.transform = `translate(${markerLeft}px, ${markerTop}px)`;
      marker.style.width = `${markerWidth}px`;
      marker.style.height = `${markerHeight}px`;
    }
  }

  /** Updates the overlay marker and score follow target to match the playhead. */
  function updatePlayhead(ppq: number): void {
    const host = options.svgHost.value;
    if (!host) return;
    buildElementIndex(host);
    const next = scanAt(ppq - options.getClipStartPpq());
    const playing = options.getIsPlaying?.() === true;
    updateMarkers(host, next, playing);
    if (playing) followHighlightedItem(host, next);
  }

  /** Horizontally scrolls the score by measure when possible, note otherwise. */
  function followHighlightedItem(host: HTMLElement, result: ScanResult): void {
    const target =
      result.measureId && measureElements.has(result.measureId)
        ? { key: `measure:${result.measureId}`, el: measureElements.get(result.measureId) }
        : (() => {
            const id = result.ids.values().next().value;
            return id === undefined ? null : { key: `note:${id}`, el: noteElements.get(id) };
          })();
    if (!target?.el) return;
    if (target.key === followedTargetKey) return;
    const now = performance.now();
    if (now - lastFollowMs < FOLLOW_INTERVAL_MS) return;
    const bounds = elementBounds(host, target.key, target.el);
    if (!bounds) return;
    followedTargetKey = target.key;
    lastFollowMs = now;
    const nextScroll = nextHorizontalFollowScrollLeft(
      host.clientWidth,
      host.scrollLeft,
      bounds.left,
      bounds.right,
    );
    if (nextScroll !== null && Math.abs(nextScroll - host.scrollLeft) >= MIN_SCROLL_DELTA_PX) {
      host.scrollLeft = nextScroll;
    }
  }

  watchEffect(() => {
    // Track both the rendered SVG and the playhead position.
    void options.svg.value;
    const getter = options.getPositionPpq();
    if (!getter) return;
    updatePlayhead(getter());
  });

  onScopeDispose(resetScan);

  return { resetScan };
}
