import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import { type AudioAssetMeta, audioAssetUri } from '@/persistence/assets';
import { createAssetReferenceGuard } from '../asset-references';
import { type ExternalStemRole, externalStemTrackName } from '../external-stems';
import { assertCanAddTracks } from '../mixer';
import {
  getAudioSourceId,
  getProject,
  placeholderSourceAudio,
  setAudioSourceId,
  useProjectStore,
} from '../store';
import { normalizeTempoMap, ppqToSeconds, secondsToPpq } from '../tempo-map';
import { TRACK_COLOR_PALETTE } from '../types';
import { executeAtomic } from './history';
import { validatePpq } from './utils';

/** One already-decoded stem produced by an external separation tool. */
export interface ExternalStemImport {
  /** Planar channel buffers of equal length (>= 1 channel). */
  channels: Float32Array[];
  /** Sample rate of the channels, in Hz (> 0). */
  sampleRate: number;
  /** Display name of the source file, used for the asset and the clip. */
  name: string;
  /** Role this stem plays in the mix (see src/project/external-stems.ts). */
  role: ExternalStemRole;
}

/** Placement options for {@link importExternalStems}. */
export interface ImportExternalStemsOptions {
  /** Timeline position every stem is placed at, in PPQ (>= 0). */
  startPpq: number;
}

/**
 * Imports externally separated stems: each stem becomes an audio asset laid
 * down as one clip on its own audio track, as a single undoable edit.
 *
 * Every stem starts at the same timeline position, so a separator's output
 * stays sample-aligned with itself. The asset stores run first under one
 * lease-backed transaction; the tracks, sources and clips are then created
 * inside a single `executeAtomic`, and each stem's asset id and role are
 * written onto its audio source as the source's content hash / stem role so
 * the provenance survives in the native project.
 *
 * @param stems Decoded stems in the order they should be laid down.
 * @param options Timeline placement shared by every stem.
 * @returns The new clip ids, one per placed stem (empty when nothing placed).
 * @throws RangeError when the position or a stem's audio is unusable.
 */
export async function importExternalStems(
  stems: ReadonlyArray<ExternalStemImport>,
  options: ImportExternalStemsOptions,
): Promise<number[]> {
  const store = useProjectStore();
  validatePpq(options.startPpq, 'Stem startPpq');
  for (const stem of stems) {
    if (stem.channels.length === 0 || stem.channels[0].length === 0) {
      throw new RangeError(`Stem "${stem.name}" has no audio`);
    }
    if (!Number.isFinite(stem.sampleRate) || stem.sampleRate <= 0) {
      throw new RangeError(`Stem "${stem.name}" sample rate must be finite and > 0`);
    }
  }
  if (stems.length === 0) return [];
  assertCanAddTracks(store.tracks.length, stems.length);

  const project = getProject();
  const startPpq = options.startPpq;
  const tempoMap = normalizeTempoMap(store.tempoSegments, store.tempoBpm);
  const startSeconds = ppqToSeconds(tempoMap, startPpq);

  // Store every stem under one lease-backed transaction before touching the
  // Project. Any save/placement failure removes only newly-created content.
  const assets = createAudioAssetTransaction();
  const isReferenced = createAssetReferenceGuard(store);
  try {
    const saved: { stem: ExternalStemImport; meta: AudioAssetMeta }[] = [];
    for (const stem of stems) {
      const meta = await assets.save(
        { name: stem.name, sampleRate: stem.sampleRate },
        stem.channels,
      );
      saved.push({ stem, meta });
    }

    const sourceCount = project.sources().length;
    const plans = saved.map(({ stem, meta }) => {
      const known = getAudioSourceId(meta.id);
      const sourceId =
        known !== undefined && known >= 1 && known <= sourceCount ? known : undefined;
      const durationSeconds = meta.numFrames / meta.sampleRate;
      const lengthPpq = secondsToPpq(tempoMap, startSeconds + durationSeconds) - startPpq;
      return { stem, meta, sourceId, lengthPpq };
    });

    const result = executeAtomic((edit) => {
      const newClipIds: number[] = [];
      for (const { stem, meta, sourceId, lengthPpq } of plans) {
        const trackName = externalStemTrackName(stem.role);
        const color = TRACK_COLOR_PALETTE[store.tracks.length % TRACK_COLOR_PALETTE.length];
        const trackId = edit(1, () => project.addTrack({ kind: 'audio', name: trackName }));
        store.tracks = [
          ...store.tracks,
          {
            id: trackId,
            name: trackName,
            color,
            kind: 'audio',
            mute: false,
            solo: false,
            volume: 1,
            pan: 0,
            order: store.tracks.length,
          },
        ];
        const newClipId = edit(1, () =>
          project.addClip({
            trackId,
            isMidi: false,
            startPpq,
            lengthPpq,
            gain: 1,
            ...placeholderSourceAudio(),
            ...(sourceId === undefined ? { sourceUri: audioAssetUri(meta.id) } : {}),
          }),
        );
        const clipSourceId = sourceId ?? project.sources().length;
        if (sourceId === undefined) setAudioSourceId(meta.id, clipSourceId);
        else edit(1, () => project.setClipSource(newClipId, sourceId));
        // The asset id is the audio's deterministic content hash, so it is what
        // the source's owning content hash records.
        edit(1, () =>
          project.setAudioSourceMetadata({
            sourceId: clipSourceId,
            contentHash: meta.id,
            externalStemRole: stem.role,
          }),
        );
        store.clips = [
          ...store.clips,
          {
            id: newClipId,
            trackId,
            name: stem.name,
            startPpq,
            lengthPpq,
            sourceOffsetPpq: 0,
            gain: 1,
            loopEnabled: false,
            loopLengthPpq: 0,
            notes: [],
            kind: 'audio',
            assetId: meta.id,
            externalStemRole: stem.role,
            contentHash: meta.id,
          },
        ];
        newClipIds.push(newClipId);
      }
      store.refresh();
      return newClipIds;
    });
    assets.commit();
    return result;
  } catch (error) {
    await assets.rollback(isReferenced);
    throw error;
  }
}
