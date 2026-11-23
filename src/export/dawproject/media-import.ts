/** Resolves and ingests the audio files a DAWproject's clips reference. */

import { errorMessage } from '@/lib/errors';
import { defaultName } from '@/project/default-names';
import { audioFileRef } from './clip-import';
import type { DawprojectMediaIssue } from './import-loss';

/** One embedded DAWproject media file offered to the audio ingest callback. */
export interface DawprojectAudioMedia {
  /** Zip entry path referenced by the DAWproject File element. */
  path: string;
  /** True when the DAWproject File was marked external. */
  external: boolean;
  /** Best-effort display name for the stored asset. */
  name: string;
  /** Raw bytes of the embedded media file. */
  bytes: Uint8Array;
}

function fileNameFromPath(path: string): string {
  const clean = path.replaceAll('\\', '/');
  const slash = clean.lastIndexOf('/');
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || defaultName('importedAudio');
}

export async function ingestEmbeddedAudio(
  project: Document,
  entries: Record<string, Uint8Array>,
  ingestAudio: (media: DawprojectAudioMedia) => Promise<{ id: string }>,
  resolveExternalAudio?: (path: string) => Promise<Uint8Array | null | undefined>,
  signal?: AbortSignal,
): Promise<{
  assets: Map<string, string>;
  imported: string[];
  issues: DawprojectMediaIssue[];
}> {
  const assets = new Map<string, string>();
  const imported: string[] = [];
  const issues: DawprojectMediaIssue[] = [];
  const seen = new Set<string>();
  for (const clip of Array.from(project.querySelectorAll('Arrangement Clip'))) {
    signal?.throwIfAborted();
    if (clip.querySelector('Notes')) continue;
    const file = audioFileRef(clip);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    let bytes: Uint8Array | null | undefined;
    try {
      bytes = file.external ? await resolveExternalAudio?.(file.path) : entries[file.path];
    } catch (error) {
      issues.push({
        path: file.path,
        external: file.external,
        reason: 'resolve-failed',
        message: errorMessage(error),
      });
      continue;
    }
    signal?.throwIfAborted();
    if (!bytes) {
      issues.push({ path: file.path, external: file.external, reason: 'missing' });
      continue;
    }
    try {
      const meta = await ingestAudio({
        path: file.path,
        external: file.external,
        name: fileNameFromPath(file.path),
        bytes,
      });
      signal?.throwIfAborted();
      assets.set(file.path, meta.id);
      imported.push(file.path);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      issues.push({
        path: file.path,
        external: file.external,
        reason: 'ingest-failed',
        message: errorMessage(error),
      });
    }
  }
  return { assets, imported, issues };
}
