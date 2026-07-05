/**
 * Bridges the OPFS media stores (audio assets, SoundFonts) and the .szd codec
 * so disk export/import carries a project's media with it.
 *
 * OPFS save slots leave media out-of-band (the document only references ids),
 * which is fine on one machine. A disk export shared with someone else, or an
 * OPFS-less restore, has no shared store to resolve those ids against — so the
 * referenced assets and fonts are gathered into the archive on export and
 * written back into the stores on import.
 */

import { collectReferencedAudioAssetIds } from '@/project/asset-references';
import { loadFont, loadFontMeta, type SoundFontMeta, saveFont } from '@/project/fonts';
import type { ProjectDocument } from '@/project/serialization';
import { type AudioAssetMeta, interleaveChannels, loadAsset, saveAsset } from './assets';
import type { SzdMediaBundle } from './szd';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Collects every audio-asset id the document references (clips, takes, freezes). */
export function collectReferencedAssetIds(doc: ProjectDocument): Set<string> {
  return collectReferencedAudioAssetIds(
    doc.tracks.flatMap((track) => track.clips),
    doc.tracks,
  );
}

/** Collects every SoundFont id the document references (SF2 instruments). */
export function collectReferencedFontIds(doc: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const track of doc.tracks) {
    if (track.instrument?.kind === 'sf2' && track.instrument.fontId) {
      ids.add(track.instrument.fontId);
    }
  }
  return ids;
}

/** Raw interleaved-PCM bytes view of planar channels (a fresh copy). */
function pcmBytes(channels: ReadonlyArray<Float32Array>): Uint8Array {
  const interleaved = interleaveChannels(channels);
  return new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength).slice();
}

/**
 * Gathers the OPFS media referenced by a document into a bundle for
 * {@link encodeSzd}. Ids that are not stored (or unreadable) are skipped, so a
 * partial project still exports rather than failing outright.
 *
 * @param doc The document being exported.
 * @returns The referenced assets and fonts that could be read.
 */
export async function gatherProjectBundle(doc: ProjectDocument): Promise<SzdMediaBundle> {
  const assets = [];
  for (const id of collectReferencedAssetIds(doc)) {
    try {
      const loaded = await loadAsset(id);
      assets.push({
        id,
        meta: textEncoder.encode(JSON.stringify(loaded.meta)),
        pcm: pcmBytes(loaded.channels),
      });
    } catch {
      // Missing/unreadable asset: skip it (the clip stays silent on import).
    }
  }
  const fonts = [];
  for (const id of collectReferencedFontIds(doc)) {
    try {
      const [data, meta] = await Promise.all([loadFont(id), loadFontMeta(id)]);
      fonts.push({ id, meta: textEncoder.encode(JSON.stringify(meta)), sf2: data });
    } catch {
      // Missing/unreadable font: skip it.
    }
  }
  return { assets, fonts };
}

/** Reconstructs a Float32Array from interleaved-PCM bytes (alignment-safe). */
function floatsFromPcm(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

/**
 * Writes a bundle's media back into the OPFS stores so the document's ids
 * resolve after a disk import. Best-effort per entry: a single malformed entry
 * is skipped rather than aborting the whole import.
 *
 * @param bundle The media extracted by {@link decodeSzdBundle}.
 */
export async function restoreProjectBundle(bundle: SzdMediaBundle): Promise<void> {
  for (const entry of bundle.assets) {
    try {
      const meta = JSON.parse(textDecoder.decode(entry.meta)) as AudioAssetMeta;
      await saveAsset(
        {
          id: entry.id,
          name: meta.name,
          sampleRate: meta.sampleRate,
          numChannels: meta.numChannels,
          ...(meta.tags ? { tags: meta.tags } : {}),
        },
        floatsFromPcm(entry.pcm),
      );
    } catch {
      // Skip an entry we cannot decode/store; the rest of the import proceeds.
    }
  }
  for (const entry of bundle.fonts) {
    try {
      const meta = JSON.parse(textDecoder.decode(entry.meta)) as SoundFontMeta;
      await saveFont({ id: entry.id, name: meta.name }, entry.sf2);
    } catch {
      // Skip an entry we cannot decode/store.
    }
  }
}
