import { ensureWasm } from '@/lib/wasm';
import { loadAsset } from '@/persistence/assets';
import { useProjectStore } from '../store';
import { alignClipWarp, type TakeAlignmentRefusal } from '../take-alignment';
import { normalizeTempoMap } from '../tempo-map';
import { type EditorClip, isAudioClip } from '../types';
import { setClipWarp } from './clips-state';
import { requireClip } from './utils';

/** Why an alignment was not applied. */
export type AlignClipRefusal = TakeAlignmentRefusal | 'takes' | 'stale';

/** Outcome of aligning a clip to a reference clip. */
export type AlignClipOutcome =
  | { applied: true; meanResidualFrames: number }
  | { applied: false; reason: AlignClipRefusal };

/** Everything the alignment read, so a concurrent edit invalidates the result. */
function sourceToken(clip: EditorClip, reference: EditorClip): string {
  const store = useProjectStore();
  return JSON.stringify({
    clip,
    reference,
    tempoBpm: store.tempoBpm,
    tempoSegments: store.tempoSegments,
  });
}

/**
 * Warps an audio clip so its timing follows a reference clip over the clip's
 * window, as one undoable warp edit (see {@link alignClipWarp}). A comped clip
 * is refused because warp applies to single-take clips only.
 *
 * @param clipId Audio clip to align (the take).
 * @param referenceClipId Audio clip whose timing the take follows.
 */
export async function alignClipToReference(
  clipId: number,
  referenceClipId: number,
): Promise<AlignClipOutcome> {
  const store = useProjectStore();
  const clip = requireClip(store, clipId);
  const reference = requireClip(store, referenceClipId);
  if (!isAudioClip(clip) || !isAudioClip(reference)) {
    throw new RangeError('Only audio clips can be aligned');
  }
  if ((clip.takes?.length ?? 0) > 0) return { applied: false, reason: 'takes' };
  const token = sourceToken(clip, reference);
  const wasm = await ensureWasm();
  const result = await alignClipWarp(
    clip,
    reference,
    normalizeTempoMap(store.tempoSegments, store.tempoBpm),
    { loadAudioAsset: loadAsset, align: (request) => wasm.alignTakeToReference(request) },
  );
  if (typeof result === 'string') return { applied: false, reason: result };
  const currentClip = store.clips.find((entry) => entry.id === clipId);
  const currentReference = store.clips.find((entry) => entry.id === referenceClipId);
  if (!currentClip || !currentReference || sourceToken(currentClip, currentReference) !== token) {
    return { applied: false, reason: 'stale' };
  }
  setClipWarp(clipId, result.warp);
  return { applied: true, meanResidualFrames: result.meanResidualFrames };
}
