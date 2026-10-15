import { audioAssetUri } from '@/persistence/assets';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import type { ClipTake } from '../types';
import { makeRoomForRecordingWithin } from './clip-lane';
import { executeAtomic } from './history';
import { requireEditableTrack, validatePpq } from './utils';

/** One destination prepared by the recording workflow for atomic placement. */
export interface AddRecordedAudioClipInput {
  trackId: number;
  assetId: string;
  startPpq: number;
  lengthPpq: number;
  name: string;
  takes?: ClipTake[];
}

interface PreparedRecordedAudioClip extends AddRecordedAudioClipInput {
  takes?: ClipTake[];
  activeTakeIndex: number;
}

/** Validates every destination before the first native Project mutation. */
function prepareInput(input: AddRecordedAudioClipInput): PreparedRecordedAudioClip {
  const store = useProjectStore();
  requireEditableTrack(store, input.trackId);
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    throw new RangeError('Recorded audio clip assetId must not be empty');
  }
  validatePpq(input.startPpq, 'Recorded clip startPpq');
  if (!Number.isFinite(input.lengthPpq) || input.lengthPpq <= 0) {
    throw new RangeError(`Recorded clip lengthPpq must be finite and > 0, got ${input.lengthPpq}`);
  }
  const takes = input.takes?.map((take) => ({ ...take }));
  if (takes?.some((take) => typeof take.assetId !== 'string' || take.assetId.length === 0)) {
    throw new RangeError('Recorded clip take assetId must not be empty');
  }
  const activeTakeIndex = takes && takes.length > 0 ? takes.length - 1 : 0;
  if (takes && takes.length > 0 && takes[activeTakeIndex].assetId !== input.assetId) {
    throw new RangeError('Recorded clip assetId must reference its final take');
  }
  return { ...input, ...(takes ? { takes } : {}), activeTakeIndex };
}

/**
 * Publishes every route of one audio recording as one atomic undo entry.
 *
 * Under the disallow overlap policy, clips already under a recorded range are
 * split around it and their covered part removed, so the take always lands. All inputs are validated first. If
 * any later native placement or mirror update fails, executeAtomic reverses
 * every completed Project edit and restores the exact pre-recording mirror
 * snapshot.
 */
export function addRecordedAudioClips(inputs: readonly AddRecordedAudioClipInput[]): number[] {
  if (inputs.length === 0) return [];
  const prepared = inputs.map(prepareInput);
  const store = useProjectStore();
  const project = getProject();

  return executeAtomic((edit) => {
    const clipIds: number[] = [];
    // Make room on every destination before the first clip lands so the
    // mirror stays in step.
    for (const input of prepared) {
      makeRoomForRecordingWithin(
        edit,
        input.trackId,
        input.startPpq,
        input.startPpq + input.lengthPpq,
      );
    }
    for (const input of prepared) {
      const known = getAudioSourceId(input.assetId);
      const sourceId =
        known !== undefined && known >= 1 && known <= project.sourceCount() ? known : undefined;
      const clipId = edit(1, () =>
        project.addClip({
          trackId: input.trackId,
          isMidi: false,
          startPpq: input.startPpq,
          lengthPpq: input.lengthPpq,
          ...placeholderSourceAudio(),
          ...(sourceId === undefined ? { sourceUri: audioAssetUri(input.assetId) } : {}),
        }),
      );
      if (sourceId === undefined) setAudioSourceId(input.assetId, project.sourceCount());
      else edit(1, () => project.setClipSource(clipId, sourceId));

      store.clips = [
        ...store.clips,
        {
          id: clipId,
          trackId: input.trackId,
          name: input.name,
          startPpq: input.startPpq,
          lengthPpq: input.lengthPpq,
          sourceOffsetPpq: 0,
          gain: 1,
          loopEnabled: false,
          loopLengthPpq: 0,
          notes: [],
          kind: 'audio',
          assetId: input.assetId,
          ...(input.takes && input.takes.length > 0
            ? {
                takes: input.takes,
                compSegments: [{ startPpq: 0, takeIndex: input.activeTakeIndex }],
              }
            : {}),
        },
      ];
      clipIds.push(clipId);
    }
    store.refresh();
    return clipIds;
  });
}
