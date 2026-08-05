import { clipKind, type EditorClip } from './types';

/**
 * Crossfades between neighbouring audio clips.
 *
 * A crossfade is not a separate object: it is the pair of clip fades that
 * covers the region where two clips of the same track overlap. Both clips play
 * through that region, so a fade-out on the earlier clip and a fade-in of the
 * same length on the later one sum to a continuous transition.
 *
 * Clips that merely touch have nothing to fade over. They can still be
 * crossfaded when the earlier clip has unused source material past its window:
 * the plan then extends that clip so an overlap exists.
 */

/** Crossfade length used when the editor has no grid to derive one from. */
export const DEFAULT_CLIP_CROSSFADE_PPQ = 0.25;

/** Why two clips cannot be crossfaded. */
export type CrossfadeBlockReason =
  /** One of the clips is not audio (MIDI clips have no fades). */
  | 'not-audio'
  /** The clips live on different tracks and never sum. */
  | 'different-track'
  /** A looping clip repeats its window; fades would apply per repeat. */
  | 'loop'
  /** The clips neither overlap nor touch. */
  | 'gap'
  /** One clip sits entirely inside the other, so no fade pair lines up. */
  | 'contained'
  /** The clips touch but the earlier one has no source material left. */
  | 'no-source';

/** A resolved crossfade: the fades to write, plus any window extension. */
export interface CrossfadePlan {
  /** Earlier clip; takes the fade-out. */
  leftClipId: number;
  /** Later clip; takes the fade-in. */
  rightClipId: number;
  /** Timeline position where both clips start sounding together. */
  startPpq: number;
  /** Crossfade length in PPQ (> 0). */
  lengthPpq: number;
  /** Timeline length the earlier clip needs; equals its current length when no extension is required. */
  leftLengthPpq: number;
}

/** Ordering-independent pair, earliest clip first. */
function order(a: EditorClip, b: EditorClip): [EditorClip, EditorClip] {
  return a.startPpq <= b.startPpq ? [a, b] : [b, a];
}

const EPSILON = 1e-9;

/**
 * Resolves the crossfade between two clips.
 *
 * @param a One clip of the pair (order does not matter).
 * @param b The other clip.
 * @param options.lengthPpq Crossfade length used when the clips only touch.
 * @param options.leftSourceEndPpq Timeline position the earlier clip's source
 * material ends at; enables extending a touching clip into the later one.
 * @returns The plan, or the reason the pair cannot be crossfaded.
 */
export function planClipCrossfade(
  a: EditorClip,
  b: EditorClip,
  options: { lengthPpq?: number; leftSourceEndPpq?: number } = {},
): CrossfadePlan | { reason: CrossfadeBlockReason } {
  if (clipKind(a) !== 'audio' || clipKind(b) !== 'audio') return { reason: 'not-audio' };
  if (a.trackId !== b.trackId) return { reason: 'different-track' };
  if (a.loopEnabled || b.loopEnabled) return { reason: 'loop' };
  const [left, right] = order(a, b);
  const leftEnd = left.startPpq + left.lengthPpq;
  const rightEnd = right.startPpq + right.lengthPpq;
  const overlap = leftEnd - right.startPpq;
  if (overlap < -EPSILON) return { reason: 'gap' };
  // The fade-out is anchored at the earlier clip's end, so it only lines up
  // with the fade-in while the later clip outlasts it.
  if (rightEnd <= leftEnd + EPSILON && overlap > EPSILON) return { reason: 'contained' };

  if (overlap > EPSILON) {
    const lengthPpq = clampFadeLength(overlap, left, right);
    if (lengthPpq <= EPSILON) return { reason: 'gap' };
    return {
      leftClipId: left.id,
      rightClipId: right.id,
      startPpq: right.startPpq,
      lengthPpq,
      leftLengthPpq: left.lengthPpq,
    };
  }

  // The clips touch: extend the earlier one into whatever source is left.
  const available = Math.max(0, (options.leftSourceEndPpq ?? leftEnd) - leftEnd);
  const requested = options.lengthPpq !== undefined ? Math.max(0, options.lengthPpq) : available;
  const extension = Math.min(available, requested, right.lengthPpq);
  if (extension <= EPSILON) return { reason: 'no-source' };
  const extended = { ...left, lengthPpq: left.lengthPpq + extension };
  const lengthPpq = clampFadeLength(extension, extended, right);
  if (lengthPpq <= EPSILON) return { reason: 'no-source' };
  return {
    leftClipId: left.id,
    rightClipId: right.id,
    startPpq: right.startPpq,
    lengthPpq,
    leftLengthPpq: extended.lengthPpq,
  };
}

/** Shortens a crossfade so neither clip's fade pair exceeds its own window. */
function clampFadeLength(lengthPpq: number, left: EditorClip, right: EditorClip): number {
  const leftRoom = left.lengthPpq - (left.fadeInPpq ?? 0);
  const rightRoom = right.lengthPpq - (right.fadeOutPpq ?? 0);
  return Math.max(0, Math.min(lengthPpq, leftRoom, rightRoom));
}

/**
 * Finds the clip a crossfade would pair with: the nearest audio clip of the
 * same track that starts later and overlaps or touches the given clip.
 *
 * @param clip Clip the user acted on.
 * @param clips All clips of the project.
 */
export function crossfadePartner(
  clip: EditorClip,
  clips: readonly EditorClip[],
): EditorClip | null {
  if (clipKind(clip) !== 'audio') return null;
  const end = clip.startPpq + clip.lengthPpq;
  let best: EditorClip | null = null;
  for (const other of clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (clipKind(other) !== 'audio') continue;
    if (other.startPpq < clip.startPpq - EPSILON) continue;
    if (other.startPpq > end + EPSILON) continue;
    if (best === null || other.startPpq < best.startPpq) best = other;
  }
  return best;
}
