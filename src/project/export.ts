/**
 * MIDI export commands returning bytes plus a suggested filename. SMF export
 * is document-driven so app-level MIDI metadata (instrument, CC and imported
 * performance lanes) is not lost.
 */

import type { LossReport } from '@/export/loss-descriptor';
import { ensureFileExtension, sanitizeFilenameBase } from '@/lib/filename';
import { assignMidiLaneFields, cloneMidiLaneFields } from './midi-lane-kinds';
import { inspectMidi2ClipExportLoss } from './midi2-export-loss';
import {
  type DocumentClip,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  serializeProject,
} from './serialization';
import { type MidiExportLossKind, projectDocumentToSmfWithLoss } from './smf';
import { getProject, useProjectStore } from './store';
import { translateTempoMapForExport } from './tempo-map-export';

/** Bytes plus suggested filename produced by the export commands. */
export interface MidiExportResult {
  /** File contents (copied off wasm memory, safe to retain). */
  bytes: Uint8Array;
  /** Suggested filename including the extension. */
  filename: string;
  /** Document features the file does not carry; confirm before saving it. */
  loss: LossReport<MidiExportLossKind>;
}

/** Replaces characters that are unsafe in filenames and trims whitespace. */
function sanitizeBaseName(name: string, fallback: string): string {
  return sanitizeFilenameBase(name, fallback);
}

/** Copies a wasm-owned byte buffer into JS-owned memory. */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * Exports the whole project (tempo map + all MIDI clips) as a Standard MIDI
 * File.
 *
 * @param baseName Base filename; defaults to the project name.
 * @returns SMF bytes and a ".mid" filename.
 */
export async function exportProjectSmf(baseName?: string): Promise<MidiExportResult> {
  const store = useProjectStore();
  const name = sanitizeBaseName(baseName ?? store.projectName, 'project');
  const exported = await projectDocumentToSmfWithLoss(serializeProject());
  return { ...exported, filename: ensureFileExtension(name, '.mid') };
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
    loss: inspectMidi2ClipExportLoss(serializeProject()),
  };
}

/**
 * Exports a single clip as a Standard MIDI File.
 *
 * Source offsets are kept on the document clip, so the resulting file starts
 * at the clip window while still preserving app-level MIDI lanes. The tempo
 * and meter maps are rebased to the clip start.
 *
 * @param clipId Id of the clip to export.
 * @param baseName Base filename; defaults to the clip name.
 * @returns SMF bytes and a ".mid" filename.
 */
export async function exportClipSmf(clipId: number, baseName?: string): Promise<MidiExportResult> {
  const store = useProjectStore();
  const clip = store.clips.find((c) => c.id === clipId);
  if (!clip) throw new RangeError(`Unknown clip id: ${clipId}`);
  if ((clip.kind ?? 'midi') !== 'midi') throw new RangeError(`Clip ${clipId} is not a MIDI clip`);
  const track = store.tracks.find((entry) => entry.id === clip.trackId);
  if (!track) throw new RangeError(`Unknown track id: ${clip.trackId}`);
  const documentClip: DocumentClip = {
    name: clip.name,
    startPpq: 0,
    lengthPpq: clip.lengthPpq,
    sourceOffsetPpq: clip.sourceOffsetPpq,
    gain: clip.gain,
    loopEnabled: clip.loopEnabled,
    loopLengthPpq: clip.loopLengthPpq,
    notes: clip.notes.map(({ id: _id, ...note }) => note),
    kind: 'midi',
  };
  if (clip.fadeInPpq !== undefined) documentClip.fadeInPpq = clip.fadeInPpq;
  if (clip.fadeOutPpq !== undefined) documentClip.fadeOutPpq = clip.fadeOutPpq;
  assignMidiLaneFields(documentClip, cloneMidiLaneFields(clip));
  if (clip.smfSysEx !== undefined && clip.smfSysEx.length > 0) {
    documentClip.smfSysEx = clip.smfSysEx.map((packet) => ({
      ppq: packet.ppq,
      status: packet.status,
      data: [...packet.data],
    }));
  }

  const name = sanitizeBaseName(baseName ?? clip.name, 'clip');
  const tempoMap = translateTempoMapForExport(
    store.tempoSegments,
    store.timeSignatures,
    clip.startPpq,
  );
  // The real track's configuration comes from the serialized document, so the
  // setup events match the whole-project export of the same track.
  const source = serializeProject();
  const documentTrack = source.tracks[store.tracks.findIndex((entry) => entry.id === track.id)];
  const exported = await projectDocumentToSmfWithLoss({
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: tempoMap.tempoSegments,
    timeSignatures: tempoMap.timeSignatures,
    tracks: [{ ...documentTrack, mute: false, solo: false, clips: [documentClip] }],
    markers: [],
    sections: [],
    ...(source.externalMidiDefault ? { externalMidiDefault: source.externalMidiDefault } : {}),
    ...(source.mixer ? { mixer: source.mixer } : {}),
  });
  return { ...exported, filename: ensureFileExtension(name, '.mid') };
}
