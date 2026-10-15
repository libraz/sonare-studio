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

import { deleteFontUnlocked, listFontPayloads, listFonts } from '@/project/fonts';
import type { ProjectDocument } from '@/project/serialization';
import {
  deleteFontGuarded,
  isAudioAssetLeased,
  isFontLeased,
  leasedAudioAssetIds,
  leasedFontIds,
  reserveMediaDeletion,
  synchronizeMediaLeases,
} from './asset-leases';
import { type AudioAssetMeta, deleteAssetUnlocked, listAssetPayloads, listAssets } from './assets';
import { collectReferencedAssetIds, collectReferencedFontIds } from './bundle';
import { withPersistenceMutationLock } from './mutation-lock';
import { isOpfsAvailable, listProjects, loadProject, type StoredProjectInfo } from './opfs';
import { decodeSzdInWorker } from './szd';

/** Bytes per stored PCM sample (32-bit float). */
const BYTES_PER_SAMPLE = 4;

interface CachedProjectReferences {
  fingerprint: string;
  assetIds: ReadonlySet<string>;
  fontIds: ReadonlySet<string>;
}

interface ReferencedMediaScan {
  assetIds: Set<string>;
  fontIds: Set<string>;
  complete: boolean;
  projects: StoredProjectInfo[];
}

/**
 * Project-reference scans are often repeated after adjacent saves. Cache the
 * small id sets by OPFS file identity; media payloads are never retained.
 */
const projectReferenceCache = new Map<string, CachedProjectReferences>();

function projectFingerprint(info: StoredProjectInfo): string | null {
  // Without a modification time, a same-sized replacement cannot be proven
  // unchanged, so deliberately skip the cache rather than risk an unsafe GC.
  return Number.isFinite(info.lastModified) ? `${info.size}:${info.lastModified}` : null;
}

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
async function scanReferencedMediaIds(
  liveDocument?: ProjectDocument,
  extra?: { assetIds?: Iterable<string>; fontIds?: Iterable<string> },
): Promise<ReferencedMediaScan> {
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

  const projects = await listProjects();
  const projectNames = new Set<string>();
  for (const info of projects) {
    projectNames.add(info.name);
    try {
      const fingerprint = projectFingerprint(info);
      const cached = fingerprint ? projectReferenceCache.get(info.name) : undefined;
      if (cached?.fingerprint === fingerprint) {
        for (const id of cached.assetIds) assetIds.add(id);
        for (const id of cached.fontIds) fontIds.add(id);
        continue;
      }
      // ZIP expansion is intentionally kept off the UI thread. Only the
      // document's tiny reference sets are cached, never decoded media bytes.
      const document = await decodeSzdInWorker(await loadProject(info.name));
      const projectAssetIds = collectReferencedAssetIds(document);
      const projectFontIds = collectReferencedFontIds(document);
      for (const id of projectAssetIds) assetIds.add(id);
      for (const id of projectFontIds) fontIds.add(id);
      if (fingerprint) {
        projectReferenceCache.set(info.name, {
          fingerprint,
          assetIds: projectAssetIds,
          fontIds: projectFontIds,
        });
      }
    } catch {
      // An unreadable or malformed project leaves its references unknown; mark
      // the set incomplete so the caller refuses to delete.
      complete = false;
    }
  }

  for (const name of projectReferenceCache.keys()) {
    if (!projectNames.has(name)) projectReferenceCache.delete(name);
  }

  return { assetIds, fontIds, complete, projects };
}

export async function collectReferencedMediaIds(
  liveDocument?: ProjectDocument,
  extra?: { assetIds?: Iterable<string>; fontIds?: Iterable<string> },
): Promise<{ assetIds: Set<string>; fontIds: Set<string>; complete: boolean }> {
  const { assetIds, fontIds, complete } = await scanReferencedMediaIds(liveDocument, extra);
  return { assetIds, fontIds, complete };
}

/** True only when no project changed between an unlocked scan and the lock. */
async function projectInventoryMatches(previous: readonly StoredProjectInfo[]): Promise<boolean> {
  const current = await listProjects();
  if (current.length !== previous.length) return false;
  return current.every((info, index) => {
    const before = previous[index];
    // Missing modification timestamps cannot establish an unchanged file.
    return (
      before !== undefined &&
      info.name === before.name &&
      info.size === before.size &&
      info.lastModified !== undefined &&
      before.lastModified !== undefined &&
      info.lastModified === before.lastModified
    );
  });
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
async function garbageCollectMediaUnlocked(
  options: MediaGcOptions = {},
  preparedScan?: ReferencedMediaScan,
): Promise<MediaGcResult> {
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
  let scan = preparedScan;
  if (!scan || !(await projectInventoryMatches(scan.projects))) {
    scan = await scanReferencedMediaIds(options.liveDocument, {
      assetIds: protectedAssetIds(),
      fontIds: protectedFontIds(),
    });
  }
  const { assetIds, fontIds, complete } = scan;
  if (!complete) return { ...empty, incompleteReferences: true };

  const [assets, assetPayloads, fonts, fontPayloads] = await Promise.all([
    listAssets(),
    listAssetPayloads(),
    listFonts(),
    listFontPayloads(),
  ]);
  const assetMetaIds = new Set(assets.map((meta) => meta.id));
  const orphanAssets = assets.filter((meta) => !assetIds.has(meta.id));
  const orphanPayloads = assetPayloads.filter(
    (payload) => !assetMetaIds.has(payload.id) && !assetIds.has(payload.id),
  );
  const fontMetaIds = new Set(fonts.map((meta) => meta.id));
  const orphanFonts = fonts.filter((meta) => !fontIds.has(meta.id));
  const orphanFontPayloads = fontPayloads.filter(
    (payload) => !fontMetaIds.has(payload.id) && !fontIds.has(payload.id),
  );

  if (options.dryRun) {
    return {
      removedAssetIds: [
        ...orphanAssets.map((meta) => meta.id),
        ...orphanPayloads.map((payload) => payload.id),
      ].sort(),
      removedFontIds: [
        ...orphanFonts.map((meta) => meta.id),
        ...orphanFontPayloads.map((payload) => payload.id),
      ].sort(),
      reclaimedBytes:
        orphanAssets.reduce((total, meta) => total + assetBytes(meta), 0) +
        orphanPayloads.reduce((total, payload) => total + payload.byteLength, 0) +
        orphanFonts.reduce((total, meta) => total + meta.byteLength, 0) +
        orphanFontPayloads.reduce((total, payload) => total + payload.byteLength, 0),
      incompleteReferences: false,
    };
  }

  const removedAssetIds: string[] = [];
  const removedFontIds: string[] = [];
  let reclaimedBytes = 0;
  let incompleteReferences = false;
  // Reserve every candidate before asking peers for their latest lease set.
  // A peer that receives this intent cannot acquire one of these ids after the
  // synchronization window opens, so one shared synchronization safely covers
  // the entire batch.
  const deletionReservation = reserveMediaDeletion(
    [...orphanAssets, ...orphanPayloads].map((entry) => entry.id),
    [...orphanFonts, ...orphanFontPayloads].map((entry) => entry.id),
  );
  const deleteCandidate = async (assetId: string, byteLength: number): Promise<void> => {
    if (!deletionReservation.audioAssetIds.has(assetId)) return;
    if (!complete) {
      incompleteReferences = true;
      return;
    }
    if (isAudioAssetLeased(assetId) || assetIds.has(assetId) || protectedAssetIds().has(assetId)) {
      return;
    }
    await deleteAssetUnlocked(assetId);
    removedAssetIds.push(assetId);
    reclaimedBytes += byteLength;
  };
  const deleteFontCandidate = async (fontId: string, byteLength: number): Promise<void> => {
    if (!deletionReservation.fontIds.has(fontId)) return;
    if (!complete) {
      incompleteReferences = true;
      return;
    }
    if (isFontLeased(fontId) || fontIds.has(fontId) || protectedFontIds().has(fontId)) return;
    await deleteFontUnlocked(fontId);
    removedFontIds.push(fontId);
    reclaimedBytes += byteLength;
  };
  try {
    await synchronizeMediaLeases();
    for (const meta of orphanAssets) await deleteCandidate(meta.id, assetBytes(meta));
    for (const payload of orphanPayloads) await deleteCandidate(payload.id, payload.byteLength);
    for (const meta of orphanFonts) await deleteFontCandidate(meta.id, meta.byteLength);
    for (const payload of orphanFontPayloads)
      await deleteFontCandidate(payload.id, payload.byteLength);
  } finally {
    deletionReservation.release();
  }
  return {
    removedAssetIds: removedAssetIds.sort(),
    removedFontIds: removedFontIds.sort(),
    reclaimedBytes,
    incompleteReferences,
  };
}

export function garbageCollectMedia(options: MediaGcOptions = {}): Promise<MediaGcResult> {
  return (async () => {
    if (!isOpfsAvailable()) return garbageCollectMediaUnlocked(options);
    // Archive reads/decompression are intentionally outside the origin-wide
    // mutation lock. Once acquired, the project inventory is rechecked before
    // any deletion, falling back to an in-lock scan only after a real change.
    const scan = await scanReferencedMediaIds(options.liveDocument, {
      assetIds: [...new Set(options.referencedAssetIds ?? []), ...leasedAudioAssetIds()],
      fontIds: [...new Set(options.referencedFontIds ?? []), ...leasedFontIds()],
    });
    return withPersistenceMutationLock(() => garbageCollectMediaUnlocked(options, scan));
  })();
}

/**
 * Deletes one stored SoundFont only when neither the live document nor any
 * stored project, revision or autosave slot references it. An incomplete
 * reference scan refuses the deletion.
 *
 * @returns True when the font was removed.
 */
export function deleteSoundFontIfUnreferenced(
  fontId: string,
  isLiveReferenced: () => boolean,
): Promise<boolean> {
  return deleteFontGuarded(fontId, async () => {
    if (isLiveReferenced()) return true;
    const scan = await collectReferencedMediaIds();
    return !scan.complete || scan.fontIds.has(fontId);
  });
}
