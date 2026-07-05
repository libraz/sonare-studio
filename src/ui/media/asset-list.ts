/**
 * Media browser list logic: filtering, sorting and display formatting for
 * stored audio assets. Pure logic: no DOM, no framework imports — the
 * MediaBrowser component feeds it asset metadata and renders the results.
 */

import type { AudioAssetMeta } from '@/persistence/assets';
import {
  type AssetReferenceClip,
  type AssetReferenceTrack,
  collectReferencedAudioAssetIds,
} from '@/project/asset-references';

/** Inclusive BPM bounds parsed from the BPM filter input. */
export interface BpmRange {
  /** Lower bound in BPM (inclusive); absent = unbounded. */
  min?: number;
  /** Upper bound in BPM (inclusive); absent = unbounded. */
  max?: number;
}

/**
 * Parses the BPM filter text into an inclusive range.
 *
 * Accepted forms (whitespace tolerated): `"120"` (exact), `"80-120"`,
 * `"80-"` (at least), `"-120"` (at most). Empty, unparseable or inverted
 * (`min > max`) input yields `null` (no filter); callers can flag invalid
 * non-empty input by checking `text.trim() !== '' && parse === null`.
 *
 * @param text - Raw filter input.
 * @returns The parsed range, or null when no usable range was given.
 */
export function parseBpmRange(text: string): BpmRange | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d+(?:\.\d+)?)?\s*(-)?\s*(\d+(?:\.\d+)?)?$/.exec(trimmed);
  if (!match) return null;
  const [, minText, dash, maxText] = match;
  if (minText === undefined && maxText === undefined) return null;
  if (!dash) {
    // A single number means an exact match (when no dash separates bounds).
    if (minText === undefined || maxText !== undefined) return null;
    const exact = Number(minText);
    return { min: exact, max: exact };
  }
  const range: BpmRange = {};
  if (minText !== undefined) range.min = Number(minText);
  if (maxText !== undefined) range.max = Number(maxText);
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return null;
  return range;
}

/** Duration of an asset in seconds, derived from its frame count. */
export function assetDurationSeconds(
  meta: Pick<AudioAssetMeta, 'numFrames' | 'sampleRate'>,
): number {
  if (!(meta.sampleRate > 0) || !(meta.numFrames > 0)) return 0;
  return meta.numFrames / meta.sampleRate;
}

/**
 * Formats a duration as `m:ss.d` (e.g. `0:05.3`, `1:23.0`). Non-finite or
 * negative input renders as `0:00.0`.
 */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  let minutes = Math.floor(total / 60);
  let rest = (total - minutes * 60).toFixed(1);
  if (rest === '60.0') {
    // Rounding the fractional part can carry into the next minute.
    minutes += 1;
    rest = '0.0';
  }
  return `${minutes}:${rest.padStart(4, '0')}`;
}

/** Formats a channel count for display: `mono`, `stereo` or `Nch`. */
export function formatChannels(numChannels: number): string {
  if (numChannels === 1) return 'mono';
  if (numChannels === 2) return 'stereo';
  return `${numChannels}ch`;
}

/** Formats a sample rate for display, e.g. `48 kHz` or `44.1 kHz`. */
export function formatSampleRate(sampleRate: number): string {
  return `${sampleRate / 1000} kHz`;
}

/** Formats a BPM tag rounded to one decimal, e.g. `120` or `97.5`. */
export function formatBpm(bpm: number): string {
  return `${Math.round(bpm * 10) / 10}`;
}

/** Formats an integrated-loudness tag in LUFS, e.g. `-14.2 LUFS`. */
export function formatLufs(lufs: number): string {
  return `${Math.round(lufs * 10) / 10} LUFS`;
}

/** The unique key tags across the given assets, sorted for a dropdown. */
export function collectKeyTags(assets: ReadonlyArray<AudioAssetMeta>): string[] {
  const keys = new Set<string>();
  for (const asset of assets) {
    if (asset.tags?.key) keys.add(asset.tags.key);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Filter criteria applied by {@link filterAssets}; absent fields match all. */
export interface AssetFilter {
  /** Case-insensitive substring match on the asset name. */
  text?: string;
  /** Exact match on the key tag (assets without a key tag are excluded). */
  key?: string;
  /** Inclusive BPM bounds (assets without a bpm tag are excluded). */
  bpm?: BpmRange | null;
}

/**
 * Filters assets by name text, key tag and BPM range. Tag-based criteria
 * exclude untagged assets (an active BPM range only matches assets that
 * carry a bpm tag, likewise for key).
 *
 * @param assets - Asset metadata to filter.
 * @param filter - Active criteria; empty/absent fields match everything.
 * @returns The matching assets in input order.
 */
export function filterAssets(
  assets: ReadonlyArray<AudioAssetMeta>,
  filter: AssetFilter,
): AudioAssetMeta[] {
  const text = filter.text?.trim().toLowerCase() ?? '';
  return assets.filter((asset) => {
    if (text.length > 0 && !asset.name.toLowerCase().includes(text)) return false;
    if (filter.key && asset.tags?.key !== filter.key) return false;
    if (filter.bpm) {
      const bpm = asset.tags?.bpm;
      if (bpm === undefined) return false;
      if (filter.bpm.min !== undefined && bpm < filter.bpm.min) return false;
      if (filter.bpm.max !== undefined && bpm > filter.bpm.max) return false;
    }
    return true;
  });
}

/** Sort orders offered by the media browser. */
export type AssetSortKey = 'name' | 'duration' | 'bpm' | 'loudness';

/**
 * Returns a sorted copy of the assets. `'name'` sorts alphabetically,
 * `'duration'` shortest-first, `'bpm'` slowest-first, `'loudness'`
 * loudest-first (highest LUFS), all with untagged assets last; every order
 * breaks ties by name then id, so sorting is deterministic.
 *
 * @param assets - Asset metadata to sort.
 * @param sortKey - The requested order.
 * @returns A new sorted array (the input is not mutated).
 */
export function sortAssets(
  assets: ReadonlyArray<AudioAssetMeta>,
  sortKey: AssetSortKey,
): AudioAssetMeta[] {
  const byName = (a: AudioAssetMeta, b: AudioAssetMeta) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const sorted = [...assets];
  switch (sortKey) {
    case 'duration':
      sorted.sort((a, b) => assetDurationSeconds(a) - assetDurationSeconds(b) || byName(a, b));
      break;
    case 'bpm':
      sorted.sort((a, b) => {
        const bpmA = a.tags?.bpm ?? Number.POSITIVE_INFINITY;
        const bpmB = b.tags?.bpm ?? Number.POSITIVE_INFINITY;
        return bpmA - bpmB || byName(a, b);
      });
      break;
    case 'loudness':
      sorted.sort((a, b) => {
        const lufsA = a.tags?.lufs ?? Number.NEGATIVE_INFINITY;
        const lufsB = b.tags?.lufs ?? Number.NEGATIVE_INFINITY;
        return lufsB - lufsA || byName(a, b);
      });
      break;
    default:
      sorted.sort(byName);
      break;
  }
  return sorted;
}

/**
 * Collects the asset ids referenced anywhere in the project: active clip
 * audio, every comp take (including non-selected ones) and frozen-track
 * renders. The media browser blocks deletion of referenced assets so a
 * project never loses audio held only by an inactive take or a frozen track.
 *
 * This must stay in lockstep with {@link collectReferencedAssetIds} in
 * `src/persistence/bundle.ts`, which performs the same walk over the
 * serialized document for disk bundling.
 *
 * @param clips - Clip mirrors (`assetId` and `takes` are read).
 * @param tracks - Track mirrors (`frozen.assetId` is read); defaults to none.
 * @returns The set of referenced asset ids.
 */
export function referencedAssetIds(
  clips: Iterable<AssetReferenceClip>,
  tracks: Iterable<AssetReferenceTrack> = [],
): Set<string> {
  return collectReferencedAudioAssetIds(clips, tracks);
}
