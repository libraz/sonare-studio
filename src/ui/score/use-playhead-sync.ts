/**
 * Playhead highlight sync for the engraved score.
 *
 * Scans the Verovio timemap forward to find the note ids sounding at the
 * current playhead position and toggles the `score-note-playing` CSS class on
 * the matching `<g class="note">` elements in the rendered SVG. The scan is
 * incremental (amortized O(1) per frame) and resets on every re-render or
 * backwards seek.
 *
 * A timemap `qstamp` counts quarter notes from the start of measure 1, and
 * measure 1 begins at the clip start, so the lookup position is
 * `ppq - clipStartPpq` (constant-tempo identity in quarter-note PPQ).
 */

import { type Ref, watchEffect } from 'vue';
import type { VerovioTimemapEntry } from '@/notation/verovio';

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
  const soundingIds = new Set<string>();
  const highlightedIds = new Set<string>();

  function resetScan(): void {
    scanIndex = 0;
    scanQstamp = Number.NEGATIVE_INFINITY;
    soundingIds.clear();
    highlightedIds.clear();
  }

  /** Note ids sounding at a quarter-note position (amortized forward scan). */
  function soundingIdsAt(qpos: number): ReadonlySet<string> {
    const timemap = options.getTimemap();
    if (qpos < scanQstamp) {
      scanIndex = 0;
      soundingIds.clear();
    }
    scanQstamp = qpos;
    while (scanIndex < timemap.length && timemap[scanIndex].qstamp <= qpos) {
      const entry = timemap[scanIndex];
      for (const id of entry.off ?? []) soundingIds.delete(id);
      for (const id of entry.on ?? []) soundingIds.add(id);
      scanIndex++;
    }
    return soundingIds;
  }

  /** Toggles the playing CSS class on SVG note groups to match the playhead. */
  function updatePlayhead(ppq: number): void {
    const host = options.svgHost.value;
    if (!host) return;
    const next = soundingIdsAt(ppq - options.getClipStartPpq());
    for (const id of [...highlightedIds]) {
      if (!next.has(id)) {
        host.querySelector(`#${CSS.escape(id)}`)?.classList.remove('score-note-playing');
        highlightedIds.delete(id);
      }
    }
    for (const id of next) {
      if (!highlightedIds.has(id)) {
        const el = host.querySelector(`#${CSS.escape(id)}`);
        if (el) {
          el.classList.add('score-note-playing');
          highlightedIds.add(id);
        }
      }
    }
  }

  watchEffect(() => {
    // Track both the rendered SVG and the playhead position.
    void options.svg.value;
    const getter = options.getPositionPpq();
    if (!getter) return;
    updatePlayhead(getter());
  });

  return { resetScan };
}
