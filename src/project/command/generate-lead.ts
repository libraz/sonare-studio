/**
 * Creates the empty lead-melody target used after arranging generated parts.
 *
 * The command is intentionally idempotent: a second request selects the
 * existing lead track (named in any message language) instead of adding another one; when that track has
 * no clip spanning the progression, it receives one. A new track and its clip
 * are created in one atomic history entry on the first request.
 */

import { maxOf, minOf } from '@/lib/math';
import { MESSAGES } from '@/ui/i18n/messages';
import { defaultName } from '../default-names';
import { useProjectStore } from '../store';
import { clipKind, type TrackRole } from '../types';
import { addMidiClip } from './clips-create';
import { setActiveClip } from './clips-state';
import { addGeneratedTrack } from './generate-track';
import { executeAtomic } from './history';

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** The lead track name in every message language, normalized. */
const LEAD_NAMES: ReadonlySet<string> = new Set(
  Object.values(MESSAGES).map(({ common }) => normalizedName(common.defaultNames.lead)),
);

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
  const startPpq = minOf(regions.map((chord) => chord.startPpq));
  const endPpq = maxOf(regions.map((chord) => chord.endPpq));
  return endPpq > startPpq ? { startPpq, endPpq, lengthPpq: endPpq - startPpq } : null;
}

function isLeadTrack(track: {
  name: string;
  kind: string;
  frozen?: unknown;
  role?: TrackRole;
}): boolean {
  if (track.kind !== 'midi' || track.frozen !== undefined) return false;
  return (
    track.role === 'lead' ||
    (track.role === undefined && LEAD_NAMES.has(normalizedName(track.name)))
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
 * @returns The selected lead clip id, or null when no chord progression exists.
 */
export function createLeadMelodyCommand(): number | null {
  const store = useProjectStore();
  const progression = chordProgressionRange(store);
  if (progression === null) return null;

  const nameOrRoleTracks = store.tracks.filter(isLeadTrack);
  // A track carrying the lead role outranks every track matched only by name.
  const roleTracks = nameOrRoleTracks.filter((track) => track.role === 'lead');
  const leadTracks = roleTracks.length > 0 ? roleTracks : nameOrRoleTracks;
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

  if (leadTrack !== undefined) {
    const clipId = addMidiClip({
      trackId: leadTrack.id,
      startPpq: progression.startPpq,
      lengthPpq: progression.lengthPpq,
      name: defaultName('lead'),
    });
    setActiveClip(clipId);
    return clipId;
  }

  const clipId = executeAtomic((edit) =>
    addGeneratedTrack(
      store,
      {
        name: defaultName('lead'),
        notes: [],
        startPpq: progression.startPpq,
        lengthPpq: progression.lengthPpq,
        role: 'lead',
      },
      edit,
    ),
  );
  setActiveClip(clipId);
  return clipId;
}
