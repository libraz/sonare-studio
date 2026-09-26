/**
 * Creates the empty lead-melody target used after arranging generated parts.
 *
 * The command is intentionally idempotent: a second request selects the
 * existing Lead/主旋律 track instead of adding another one. The track and its
 * clip are still created in one atomic history entry on the first request.
 */

import { useProjectStore } from '../store';
import { clipKind } from '../types';
import { setActiveClip } from './clips-state';
import { addGeneratedTrack } from './generate-track';
import { executeAtomic } from './history';

const DEFAULT_LEAD_NAME = 'Lead';
const LEAD_NAMES = new Set(['lead', '主旋律']);

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

interface ChordProgressionRange {
  startPpq: number;
  endPpq: number;
  lengthPpq: number;
}

function chordProgressionRange(
  store: ReturnType<typeof useProjectStore>,
): ChordProgressionRange | null {
  const regions = store.chords.filter(
    (chord) =>
      Number.isFinite(chord.startPpq) &&
      Number.isFinite(chord.endPpq) &&
      chord.endPpq > chord.startPpq,
  );
  if (regions.length === 0) return null;
  const startPpq = Math.min(...regions.map((chord) => chord.startPpq));
  const endPpq = Math.max(...regions.map((chord) => chord.endPpq));
  return endPpq > startPpq ? { startPpq, endPpq, lengthPpq: endPpq - startPpq } : null;
}

function isLeadTrack(
  track: { name: string; kind: string; frozen?: unknown },
  name: string,
): boolean {
  return (
    track.kind === 'midi' &&
    track.frozen === undefined &&
    (LEAD_NAMES.has(normalizedName(track.name)) ||
      normalizedName(track.name) === normalizedName(name))
  );
}

function clipSpansRange(
  clip: { startPpq: number; lengthPpq: number },
  range: ChordProgressionRange,
): boolean {
  return clip.startPpq <= range.startPpq && clip.startPpq + clip.lengthPpq >= range.endPpq;
}

/**
 * Creates or reuses an empty lead-melody clip spanning the chord progression.
 *
 * @param name Localized display name for a newly created lead track.
 * @returns The selected lead clip id, or null when no chord progression exists.
 */
export function createLeadMelodyCommand(name = DEFAULT_LEAD_NAME): number | null {
  const store = useProjectStore();
  const progression = chordProgressionRange(store);
  if (progression === null) return null;

  const requestedName = name.trim() || DEFAULT_LEAD_NAME;
  const leadTracks = store.tracks.filter((track) => isLeadTrack(track, requestedName));
  const leadTrack =
    leadTracks.find((track) =>
      store.clips.some(
        (clip) =>
          clip.trackId === track.id &&
          clipKind(clip) === 'midi' &&
          clipSpansRange(clip, progression),
      ),
    ) ?? leadTracks[0];

  const existingClip = leadTrack
    ? store.clips
        .filter(
          (clip) =>
            clip.trackId === leadTrack.id &&
            clipKind(clip) === 'midi' &&
            clipSpansRange(clip, progression),
        )
        .sort((a, b) => a.startPpq - b.startPpq)[0]
    : undefined;
  if (existingClip !== undefined) {
    setActiveClip(existingClip.id);
    return existingClip.id;
  }

  const clipId = executeAtomic((edit) =>
    addGeneratedTrack(
      store,
      {
        name: requestedName,
        notes: [],
        startPpq: progression.startPpq,
        lengthPpq: progression.lengthPpq,
      },
      edit,
    ),
  );
  setActiveClip(clipId);
  return clipId;
}
