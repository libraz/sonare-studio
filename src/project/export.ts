/**
 * MIDI export commands returning bytes plus a suggested filename. SMF export
 * is document-driven so app-level MIDI metadata (instrument, CC and imported
 * performance lanes) is not lost.
 */

import type { LossReport } from '@/export/loss-descriptor';
import { ensureFileExtension, sanitizeFilenameBase } from '@/lib/filename';
import { inspectMidi2ClipExportLoss } from './midi2-export-loss';
import {
  type DocumentClip,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  serializeProject,
} from './serialization';
import { type MidiExportLossKind, projectDocumentToSmfWithLoss } from './smf';
import { getProject, useProjectStore } from './store';

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
 * at the clip window while still preserving app-level MIDI lanes.
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
  if (clip.ccLanes !== undefined && clip.ccLanes.length > 0) {
    documentClip.ccLanes = clip.ccLanes.map((lane) => ({
      controller: lane.controller,
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.pitchBendLanes !== undefined && clip.pitchBendLanes.length > 0) {
    documentClip.pitchBendLanes = clip.pitchBendLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.programChangeLanes !== undefined && clip.programChangeLanes.length > 0) {
    documentClip.programChangeLanes = clip.programChangeLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.channelPressureLanes !== undefined && clip.channelPressureLanes.length > 0) {
    documentClip.channelPressureLanes = clip.channelPressureLanes.map((lane) => ({
      channel: lane.channel,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.polyPressureLanes !== undefined && clip.polyPressureLanes.length > 0) {
    documentClip.polyPressureLanes = clip.polyPressureLanes.map((lane) => ({
      channel: lane.channel,
      pitch: lane.pitch,
      points: lane.points.map((point) => ({ ...point })),
    }));
  }
  if (clip.smfSysEx !== undefined && clip.smfSysEx.length > 0) {
    documentClip.smfSysEx = clip.smfSysEx.map((packet) => ({
      ppq: packet.ppq,
      status: packet.status,
      data: [...packet.data],
    }));
  }

  const name = sanitizeBaseName(baseName ?? clip.name, 'clip');
  const exported = await projectDocumentToSmfWithLoss({
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name,
    sampleRate: 48000,
    tempoSegments: store.tempoSegments.map((segment) => ({ ...segment })),
    timeSignatures: store.timeSignatures.map((signature) => ({ ...signature })),
    tracks: [
      {
        name: track.name,
        color: track.color,
        kind: 'midi',
        mute: false,
        solo: false,
        volume: 1,
        pan: 0,
        ...(track.instrument ? { instrument: track.instrument } : {}),
        clips: [documentClip],
      },
    ],
    markers: [],
    sections: [],
  });
  return { ...exported, filename: ensureFileExtension(name, '.mid') };
}
