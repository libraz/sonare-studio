/**
 * MIDI export commands: thin wrappers around the wasm Project export APIs
 * returning bytes plus a suggested filename. Browser download plumbing lives
 * in src/notation/io.ts (exportSmfFile); these helpers feed it or the
 * persistence layer directly.
 */

import { ensureWasm } from '@/lib/wasm';
import { ensureFileExtension } from '@/notation/io';
import { getProject, notesToProjectEvents, useProjectStore } from './store';

/** Bytes plus suggested filename produced by the export commands. */
export interface MidiExportResult {
  /** File contents (copied off wasm memory, safe to retain). */
  bytes: Uint8Array;
  /** Suggested filename including the extension. */
  filename: string;
}

/** Replaces characters that are unsafe in filenames and trims whitespace. */
function sanitizeBaseName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Copies a wasm-owned byte buffer into JS-owned memory. */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * Exports the whole project (tempo map + all MIDI clips) as a Standard MIDI
 * File via Project.exportSmf.
 *
 * @param baseName Base filename; defaults to the project name.
 * @returns SMF bytes and a ".mid" filename.
 */
export function exportProjectSmf(baseName?: string): MidiExportResult {
  const store = useProjectStore();
  const project = getProject();
  const name = sanitizeBaseName(baseName ?? store.projectName, 'project');
  return {
    bytes: copyBytes(project.exportSmf()),
    filename: ensureFileExtension(name, '.mid'),
  };
}

/**
 * Exports the whole project (tempo map + all MIDI clips) as a MIDI 2.0 Clip
 * File (SMF2CLIP) via Project.exportClipFile.
 *
 * @param baseName Base filename; defaults to the project name.
 * @returns SMF2CLIP bytes and a ".midi2" filename.
 */
export function exportProjectClipFile(baseName?: string): MidiExportResult {
  const store = useProjectStore();
  const project = getProject();
  const name = sanitizeBaseName(baseName ?? store.projectName, 'project');
  return {
    bytes: copyBytes(project.exportClipFile()),
    filename: ensureFileExtension(name, '.midi2'),
  };
}

/**
 * Exports a single clip as a Standard MIDI File.
 *
 * The Project has no per-clip export API, so a scratch Project is built with
 * the live tempo map and just this clip's audible note window (source offsets
 * applied, so the file starts at the clip start), then exported via
 * Project.exportSmf. The scratch Project is always released.
 *
 * @param clipId Id of the clip to export.
 * @param baseName Base filename; defaults to the clip name.
 * @returns SMF bytes and a ".mid" filename.
 */
export async function exportClipSmf(clipId: number, baseName?: string): Promise<MidiExportResult> {
  const store = useProjectStore();
  const project = getProject();
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip) throw new RangeError(`Unknown clip id: ${clipId}`);

  // Shift notes from source coordinates into clip-local coordinates and keep
  // only those starting inside the clip window.
  const windowEnd = clip.sourceOffsetPpq + clip.lengthPpq;
  const localNotes = clip.notes
    .filter((note) => note.startPpq >= clip.sourceOffsetPpq && note.startPpq < windowEnd)
    .map((note) => ({ ...note, startPpq: note.startPpq - clip.sourceOffsetPpq }));

  const mod = await ensureWasm();
  const scratch = new mod.Project();
  try {
    scratch.setSampleRate(project.getSampleRate());
    if (store.tempoSegments.length > 0) {
      scratch.setTempoSegments(
        store.tempoSegments.map((s) => ({
          startPpq: s.startPpq,
          bpm: s.bpm,
          endBpm: s.endBpm ?? 0,
        })),
      );
    }
    const { clipId: scratchClipId } = scratch.addMidiClip(
      0,
      Math.max(1, Math.ceil(clip.lengthPpq)),
    );
    if (localNotes.length > 0) {
      scratch.setMidiEvents(scratchClipId, notesToProjectEvents(localNotes));
    }
    const name = sanitizeBaseName(baseName ?? clip.name, 'clip');
    return {
      bytes: copyBytes(scratch.exportSmf()),
      filename: ensureFileExtension(name, '.mid'),
    };
  } finally {
    scratch.delete();
  }
}
