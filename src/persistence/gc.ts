/**
 * Garbage collection for the OPFS media stores (audio assets, SoundFonts).
 *
 * The asset and font stores are content-addressed and shared across every
 * project the user opens: importing the same audio twice stores one copy, and
 * loading a project repopulates the stores from its bundle. Over time the
 * stores accumulate media that no project references any more — a clip deleted
 * after import, a SoundFont swapped out — and nothing ever removes it, so OPFS
 * usage grows without bound.
 *
 * This collector reclaims that media. It is deliberately conservative about
 * what counts as referenced, because the autosave slot writes its `.szd`
 * WITHOUT a media bundle (see useAutosave.ts) and relies on the shared stores
 * to resolve ids on restore. Deleting an asset an unbundled slot still needs
 * would lose audio. So the referenced set is the UNION of:
 * - every stored project's document (each `.szd` decoded for its references), and
 * - the live document passed in (its newest, possibly unsaved, references).
 *
 * Anything not in that union is a true orphan and safe to delete. If any stored
 * project cannot be read or decoded the reference set is incomplete, so the
 * collector deletes nothing and reports {@link MediaGcResult.incompleteReferences}.
 */

import { listFonts } from '@/project/fonts';
import type { ProjectDocument } from '@/project/serialization';
import {
  deleteAudioAssetGuarded,
  deleteFontGuarded,
  leasedAudioAssetIds,
  leasedFontIds,
} from './asset-leases';
import { type AudioAssetMeta, listAssetPayloads, listAssets } from './assets';
import { collectReferencedAssetIds, collectReferencedFontIds } from './bundle';
import { withPersistenceMutationLock } from './mutation-lock';
import { isOpfsAvailable, listProjects, loadProject } from './opfs';
import { decodeSzd } from './szd';

/** Bytes per stored PCM sample (32-bit float). */
const BYTES_PER_SAMPLE = 4;

/** Options for {@link garbageCollectMedia}. */
export interface MediaGcOptions {
  /**
   * The live, possibly-unsaved document whose media must be preserved even when
   * it is not yet written to any slot. Omit to collect against stored projects
   * alone.
   */
  liveDocument?: ProjectDocument;
  /** Media ids that are not in the live document but must be retained. */
  referencedAssetIds?: Iterable<string>;
  /** SoundFont ids that are not in the live document but must be retained. */
  referencedFontIds?: Iterable<string>;
  /** When true, computes what would be removed without deleting anything. */
  dryRun?: boolean;
}

/** Outcome of a media garbage-collection pass. */
export interface MediaGcResult {
  /** Asset ids removed (or removable, when `dryRun`), sorted. */
  removedAssetIds: string[];
  /** Font ids removed (or removable, when `dryRun`), sorted. */
  removedFontIds: string[];
  /** Total bytes reclaimed (or reclaimable) across removed assets and fonts. */
  reclaimedBytes: number;
  /**
   * True when a stored project could not be read or decoded, so its references
   * are unknown. Deletion is skipped entirely in that case for data safety, and
   * the removed* arrays are empty.
   */
  incompleteReferences: boolean;
}

/** Stored size in bytes of one asset, from its frame and channel counts. */
function assetBytes(meta: Pick<AudioAssetMeta, 'numFrames' | 'numChannels'>): number {
  return meta.numFrames * meta.numChannels * BYTES_PER_SAMPLE;
}

/**
 * Collects the union of asset and font ids referenced by every stored project
 * and an optional live document.
 *
 * @param liveDocument Optional live document folded into the union.
 * @returns The referenced id sets, plus whether any project was unreadable
 *   (`complete` is false when a `.szd` could not be loaded or decoded).
 */
export async function collectReferencedMediaIds(
  liveDocument?: ProjectDocument,
  extra?: { assetIds?: Iterable<string>; fontIds?: Iterable<string> },
): Promise<{ assetIds: Set<string>; fontIds: Set<string>; complete: boolean }> {
  const assetIds = new Set<string>();
  const fontIds = new Set<string>();
  let complete = true;

  const fold = (doc: ProjectDocument): void => {
    for (const id of collectReferencedAssetIds(doc)) assetIds.add(id);
    for (const id of collectReferencedFontIds(doc)) fontIds.add(id);
  };

  if (liveDocument) fold(liveDocument);
  for (const id of extra?.assetIds ?? []) assetIds.add(id);
  for (const id of extra?.fontIds ?? []) fontIds.add(id);

  for (const info of await listProjects()) {
    try {
      fold(decodeSzd(await loadProject(info.name)));
    } catch {
      // An unreadable or malformed project leaves its references unknown; mark
      // the set incomplete so the caller refuses to delete.
      complete = false;
    }
  }

  return { assetIds, fontIds, complete };
}

/**
 * Removes audio assets and SoundFonts that no project references, reclaiming
 * OPFS space. No-op (empty result) when OPFS is unavailable.
 *
 * Safe by construction: media referenced by any stored project or the live
 * document is kept, and if any project cannot be read nothing is deleted (see
 * {@link MediaGcResult.incompleteReferences}).
 *
 * @param options Live document to preserve and an optional dry-run flag.
 * @returns What was removed (or would be), and the reclaimed byte count.
 */
async function garbageCollectMediaUnlocked(options: MediaGcOptions = {}): Promise<MediaGcResult> {
  const empty: MediaGcResult = {
    removedAssetIds: [],
    removedFontIds: [],
    reclaimedBytes: 0,
    incompleteReferences: false,
  };
  if (!isOpfsAvailable()) return empty;

  const extraAssetIds = new Set(options.referencedAssetIds ?? []);
  const extraFontIds = new Set(options.referencedFontIds ?? []);
  const protectedAssetIds = (): Set<string> =>
    new Set([...extraAssetIds, ...leasedAudioAssetIds()]);
  // Fold every live tab's leased fonts in, so another tab's unsaved SoundFont
  // (autosave writes no media bundle, and may be up to 30s behind) is preserved.
  const protectedFontIds = (): Set<string> => new Set([...extraFontIds, ...leasedFontIds()]);
  const { assetIds, fontIds, complete } = await collectReferencedMediaIds(options.liveDocument, {
    assetIds: protectedAssetIds(),
    fontIds: protectedFontIds(),
  });
  if (!complete) return { ...empty, incompleteReferences: true };

  const [assets, assetPayloads, fonts] = await Promise.all([
    listAssets(),
    listAssetPayloads(),
    listFonts(),
  ]);
  const assetMetaIds = new Set(assets.map((meta) => meta.id));
  const orphanAssets = assets.filter((meta) => !assetIds.has(meta.id));
  const orphanPayloads = assetPayloads.filter(
    (payload) => !assetMetaIds.has(payload.id) && !assetIds.has(payload.id),
  );
  const orphanFonts = fonts.filter((meta) => !fontIds.has(meta.id));

  if (options.dryRun) {
    return {
      removedAssetIds: [
        ...orphanAssets.map((meta) => meta.id),
        ...orphanPayloads.map((payload) => payload.id),
      ].sort(),
      removedFontIds: orphanFonts.map((meta) => meta.id).sort(),
      reclaimedBytes:
        orphanAssets.reduce((total, meta) => total + assetBytes(meta), 0) +
        orphanPayloads.reduce((total, payload) => total + payload.byteLength, 0) +
        orphanFonts.reduce((total, meta) => total + meta.byteLength, 0),
      incompleteReferences: false,
    };
  }

  const removedAssetIds: string[] = [];
  const removedFontIds: string[] = [];
  let reclaimedBytes = 0;
  let incompleteReferences = false;
  const deleteCandidate = async (assetId: string, byteLength: number): Promise<void> => {
    const deleted = await deleteAudioAssetGuarded(
      assetId,
      async () => {
        const current = await collectReferencedMediaIds(options.liveDocument, {
          assetIds: protectedAssetIds(),
          fontIds: protectedFontIds(),
        });
        if (!current.complete) {
          incompleteReferences = true;
          return true;
        }
        return current.assetIds.has(assetId);
      },
      true,
    );
    if (deleted) {
      removedAssetIds.push(assetId);
      reclaimedBytes += byteLength;
    }
  };
  for (const meta of orphanAssets) await deleteCandidate(meta.id, assetBytes(meta));
  for (const payload of orphanPayloads) await deleteCandidate(payload.id, payload.byteLength);
  for (const meta of orphanFonts) {
    const deleted = await deleteFontGuarded(
      meta.id,
      async () => {
        const current = await collectReferencedMediaIds(options.liveDocument, {
          assetIds: protectedAssetIds(),
          fontIds: protectedFontIds(),
        });
        if (!current.complete) {
          incompleteReferences = true;
          return true;
        }
        return current.fontIds.has(meta.id);
      },
      true,
    );
    if (deleted) {
      removedFontIds.push(meta.id);
      reclaimedBytes += meta.byteLength;
    }
  }
  return {
    removedAssetIds: removedAssetIds.sort(),
    removedFontIds: removedFontIds.sort(),
    reclaimedBytes,
    incompleteReferences,
  };
}

export function garbageCollectMedia(options: MediaGcOptions = {}): Promise<MediaGcResult> {
  return withPersistenceMutationLock(() => garbageCollectMediaUnlocked(options));
}
