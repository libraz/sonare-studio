/**
 * Keeps the common silence of every comped audio clip whose take sub-rows are
 * open, for drawing and for snapping comp edges. Results are cached by what
 * they were computed from (the takes, the clip window and the tempo map), so a
 * redraw or an unrelated edit reuses them and only a changed clip re-scans.
 */

import { type ShallowRef, shallowRef, watch } from 'vue';
import {
  commonTakeSilence,
  type PpqSpan,
  snapToCommonSilence,
  type TakeSilenceDeps,
} from '@/project/take-silence';
import type { NormalizedTempoMap } from '@/project/tempo-map';
import { type EditorClip, isAudioClip } from '@/project/types';

/** Configuration for {@link useCommonTakeSilence}. */
export interface UseCommonTakeSilenceOptions {
  clips: () => ReadonlyArray<EditorClip>;
  /** Tracks whose take sub-rows are open; only their clips are scanned. */
  expandedTrackIds: () => readonly number[];
  tempo: () => NormalizedTempoMap;
  /** Resolves the scan's dependencies, or null when the engine lacks them. */
  deps: () => Promise<TakeSilenceDeps | null>;
}

/** Common silence per open comped clip, plus the comp-edge snap built on it. */
export interface CommonTakeSilence {
  byClip: ShallowRef<ReadonlyMap<number, ReadonlyArray<PpqSpan>>>;
  /** Snaps a clip-relative comp edge into the centre of a shared silence. */
  snapEdge(clipId: number, ppq: number): number;
}

// Serialized by content, memoized by identity: edits replace the takes array and
// the tempo map, so an unchanged object is never re-serialized.
const takesKeys = new WeakMap<object, string>();
const tempoKeys = new WeakMap<NormalizedTempoMap, string>();

function memoJson<K extends object>(cache: WeakMap<K, string>, value: K): string {
  let key = cache.get(value);
  if (key === undefined) {
    key = JSON.stringify(value);
    cache.set(value, key);
  }
  return key;
}

function scanKey(clip: EditorClip, tempo: NormalizedTempoMap): string {
  const takes = clip.takes ? memoJson(takesKeys, clip.takes) : '';
  return [
    takes,
    clip.startPpq,
    clip.lengthPpq,
    clip.sourceOffsetPpq,
    clip.loopEnabled,
    memoJson(tempoKeys, tempo),
  ].join('|');
}

export function useCommonTakeSilence(options: UseCommonTakeSilenceOptions): CommonTakeSilence {
  const byClip = shallowRef<ReadonlyMap<number, ReadonlyArray<PpqSpan>>>(new Map());
  const cache = new Map<string, Promise<PpqSpan[]>>();
  let generation = 0;

  function comped(): EditorClip[] {
    const open = new Set(options.expandedTrackIds());
    return options
      .clips()
      .filter(
        (clip) => open.has(clip.trackId) && isAudioClip(clip) && (clip.takes?.length ?? 0) >= 2,
      );
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    const clips = comped();
    if (clips.length === 0) {
      byClip.value = new Map();
      return;
    }
    const deps = await options.deps();
    if (!deps || current !== generation) return;
    const tempo = options.tempo();
    const keyed = clips.map((clip) => ({ clip, key: scanKey(clip, tempo) }));
    const keys = new Set(keyed.map((entry) => entry.key));
    for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    const entries = await Promise.all(
      keyed.map(async ({ clip, key }): Promise<[number, PpqSpan[]]> => {
        let scan = cache.get(key);
        if (!scan) {
          scan = commonTakeSilence(clip, tempo, deps).catch(() => []);
          cache.set(key, scan);
        }
        return [clip.id, await scan];
      }),
    );
    if (current === generation) byClip.value = new Map(entries);
  }

  watch(
    () => comped().map((clip) => `${clip.id}:${scanKey(clip, options.tempo())}`),
    () => void refresh(),
    { immediate: true },
  );

  return {
    byClip,
    snapEdge: (clipId, ppq) => snapToCommonSilence(byClip.value.get(clipId) ?? [], ppq),
  };
}
