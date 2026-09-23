/**
 * The project's key timeline: the declared scale-highlight key from beat 0,
 * overridden from each `Key:` marker position onward.
 *
 * Markers are the source of truth for a key change and are read regardless of
 * whether scale highlighting is enabled (decision #8) -- only the region
 * before the first marker falls back to "no key" when highlighting is off.
 * `keyFromFifths` only knows the natural-minor mask, so a marker restating the
 * declared tonic's harmonic/melodic minor keeps the declared mask rather than
 * flattening it to natural minor.
 *
 * Pure module (no Vue/Pinia).
 */

import { isMinorKey, type KeyScale, keyFromFifths } from '@libraz/libcantus';
import type { EditorMarker, ScaleHighlightConfig } from '@/project/types';
import { effectiveKeyScale, keyScaleToKeyFifths } from './key';
import { keySignatureFromMarker } from './key-name';

/** One half-open span of the key timeline, in absolute PPQ. */
export interface KeyMapRegion {
  startPpq: number;
  /** Exclusive region end; `Infinity` for the last region. */
  endPpq: number;
  /** The key in effect, or null when no key is set. */
  key: KeyScale | null;
  /** Whether the key came from the project's declared scale or a marker. */
  source: 'declared' | 'marker';
}

/** Queryable key timeline built by {@link buildKeyMap}. */
export interface KeyMap {
  regions: KeyMapRegion[];
  /** The key in effect at an absolute PPQ position, or null when unset. */
  at(absPpq: number): KeyScale | null;
  /** Whether a key is set at an absolute PPQ position. */
  keySetAt(absPpq: number): boolean;
  /** The region's key-signature fifths at an absolute PPQ position, 0 when unset. */
  keyFifthsAt(absPpq: number): number;
}

/** Normalizes a pitch class to 0..11. */
function pitchClass(pc: number): number {
  return ((pc % 12) + 12) % 12;
}

/** True when two keys share a tonic pitch class and major/minor quality. */
export function sameKeyName(a: KeyScale, b: KeyScale): boolean {
  return pitchClass(a.rootPc) === pitchClass(b.rootPc) && isMinorKey(a) === isMinorKey(b);
}

/**
 * Builds the project's key map from its scale-highlight config and timeline
 * markers. Non-`Key:` markers are ignored; when two `Key:` markers share a
 * position, the one with the larger id wins.
 *
 * @param scaleHighlight The project's declared scale-highlight config.
 * @param markers Timeline markers (any kind; only `Key:` markers matter here).
 */
export function buildKeyMap(
  scaleHighlight: ScaleHighlightConfig,
  markers: ReadonlyArray<EditorMarker>,
): KeyMap {
  const declaredKey: KeyScale | null = scaleHighlight.enabled
    ? effectiveKeyScale(scaleHighlight)
    : null;

  const byPosition = new Map<number, EditorMarker>();
  for (const marker of markers) {
    if (keySignatureFromMarker(marker.name) === null) continue;
    const existing = byPosition.get(marker.ppq);
    if (existing === undefined || marker.id > existing.id) byPosition.set(marker.ppq, marker);
  }
  const sortedMarkers = [...byPosition.values()].sort((a, b) => a.ppq - b.ppq);

  const regions: KeyMapRegion[] = [];
  // Parallel to `regions`: each region's key-signature fifths, kept separately
  // so a marker region reports the fifths it was written with rather than one
  // re-derived (and possibly re-spelled) from its KeyScale.
  const regionFifths: number[] = [];

  if (sortedMarkers.length === 0 || sortedMarkers[0].ppq > 0) {
    regions.push({
      startPpq: 0,
      endPpq: sortedMarkers[0]?.ppq ?? Number.POSITIVE_INFINITY,
      key: declaredKey,
      source: 'declared',
    });
    regionFifths.push(declaredKey === null ? 0 : keyScaleToKeyFifths(declaredKey));
  }

  for (let i = 0; i < sortedMarkers.length; i++) {
    const marker = sortedMarkers[i];
    const keySig = keySignatureFromMarker(marker.name);
    if (keySig === null) continue; // unreachable: filtered into byPosition above
    let key = keyFromFifths(keySig.fifths, keySig.minor ? 'minor' : 'major').key;
    if (declaredKey !== null && isMinorKey(declaredKey) && sameKeyName(key, declaredKey)) {
      key = declaredKey;
    }
    regions.push({
      startPpq: marker.ppq,
      endPpq: sortedMarkers[i + 1]?.ppq ?? Number.POSITIVE_INFINITY,
      key,
      source: 'marker',
    });
    regionFifths.push(keySig.fifths);
  }

  function regionIndexAt(absPpq: number): number {
    for (let i = 0; i < regions.length; i++) {
      if (absPpq >= regions[i].startPpq && absPpq < regions[i].endPpq) return i;
    }
    return -1;
  }

  return {
    regions,
    at(absPpq) {
      const index = regionIndexAt(absPpq);
      return index === -1 ? null : regions[index].key;
    },
    keySetAt(absPpq) {
      const index = regionIndexAt(absPpq);
      return index !== -1 && regions[index].key !== null;
    },
    keyFifthsAt(absPpq) {
      const index = regionIndexAt(absPpq);
      return index === -1 ? 0 : regionFifths[index];
    },
  };
}
