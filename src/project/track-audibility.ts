/**
 * Track audibility under the solo/mute rules, shared by live mixer sync and
 * the offline export renderer so both silence the same tracks.
 */

import type { EditorTrack } from './types';

/** The mute/solo subset of a track relevant to audibility. */
export type TrackAudibilityState = Pick<EditorTrack, 'mute' | 'solo' | 'soloSafe'>;

/**
 * Optional group-membership hooks used to expand a soloed folder/submix track
 * to the member lanes whose audio actually feeds that group.
 */
export interface TrackSoloExpansionOptions<T extends TrackAudibilityState> {
  /** True when the track is a folder/submix group track. */
  isGroup?: (track: T, index: number) => boolean;
  /** Stable key identifying a group track. */
  groupKey?: (track: T, index: number) => number | string | undefined;
  /** Stable key of the group this member routes into, if any. */
  memberGroupKey?: (track: T, index: number) => number | string | undefined;
}

/**
 * Computes the effective solo group after expanding soloed group tracks to
 * their routed members and adding solo-safe lanes while any solo is active.
 *
 * @param tracks All tracks in project/lane order.
 * @param options Optional group membership extractors.
 * @returns One effective solo flag per track index.
 */
export function expandedSoloStates<T extends TrackAudibilityState>(
  tracks: ReadonlyArray<T>,
  options: TrackSoloExpansionOptions<T> = {},
): boolean[] {
  const anySolo = tracks.some((track) => track.solo);
  const soloedGroups = new Set<number | string>();
  if (options.isGroup && options.groupKey) {
    tracks.forEach((track, index) => {
      if (!track.solo || !options.isGroup?.(track, index)) return;
      const key = options.groupKey?.(track, index);
      if (key !== undefined) soloedGroups.add(key);
    });
  }
  return tracks.map((track, index) => {
    const memberGroup = options.memberGroupKey?.(track, index);
    return (
      track.solo ||
      (memberGroup !== undefined && soloedGroups.has(memberGroup)) ||
      (anySolo && track.soloSafe === true)
    );
  });
}

/**
 * Decides audibility for every track under the solo/mute rules in one pass:
 * when any track is soloed only (expanded) soloed and solo-safe tracks play,
 * and mute always silences a track (mute wins over its own solo/solo-safe
 * status).
 *
 * @param tracks All tracks in project/lane order.
 * @param options Optional group membership extractors.
 * @returns One audible flag per track index.
 */
export function trackAudibilityStates<T extends TrackAudibilityState>(
  tracks: ReadonlyArray<T>,
  options: TrackSoloExpansionOptions<T> = {},
): boolean[] {
  const anySolo = tracks.some((t) => t.solo);
  const soloStates = anySolo ? expandedSoloStates(tracks, options) : undefined;
  return tracks.map((track, index) => !track.mute && (soloStates?.[index] ?? true));
}
