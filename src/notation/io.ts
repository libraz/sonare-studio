/**
 * Notation file I/O: MusicXML download, SMF (Standard MIDI File) import to
 * editor notes, and SMF export from a live Project.
 */

import { ensureWasm } from '@/lib/wasm';
import type { EditorNote } from '@/project/types';
import type { Project } from '@/wasm/index.js';
import { downloadBlob } from './print';

/** MIME type for MusicXML downloads. */
const MUSICXML_MIME = 'application/vnd.recordare.musicxml+xml';

/** MIME type for Standard MIDI File downloads. */
const SMF_MIME = 'audio/midi';

/** An editor-compatible note recovered from imported MIDI data (no id yet). */
export type ImportedNote = Omit<EditorNote, 'id'>;

/**
 * Appends a file extension unless the name already ends with it
 * (case-insensitive).
 *
 * @param filename File name with or without the extension.
 * @param extension Extension including the leading dot, e.g. ".musicxml".
 * @returns File name guaranteed to end with the extension.
 */
export function ensureFileExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename
    : `${filename}${extension}`;
}

/**
 * Downloads a MusicXML document as a .musicxml file.
 *
 * @param xml Serialized MusicXML text.
 * @param filename Suggested file name; ".musicxml" is appended when missing.
 */
export function exportMusicXml(xml: string, filename: string): void {
  const blob = new Blob([xml], { type: MUSICXML_MIME });
  downloadBlob(blob, ensureFileExtension(filename, '.musicxml'));
}

/** UMP message-type nibble for MIDI 1.0 channel-voice words. */
const UMP_MIDI1_CHANNEL_VOICE = 0x2;
/** MIDI 1.0 note-off status nibble. */
const STATUS_NOTE_OFF = 0x8;
/** MIDI 1.0 note-on status nibble. */
const STATUS_NOTE_ON = 0x9;

/** One serialized MIDI event inside the Project JSON document. */
interface SerializedMidiEvent {
  ppq: number;
  data0: number;
  data1: number;
}

/** Slice of the Project JSON document read back after an SMF import. */
interface SerializedProjectDoc {
  midi_content?: Record<string, unknown>;
}

/** A note-on or note-off boundary decoded from a packed UMP word. */
interface DecodedNoteEvent {
  ppq: number;
  kind: 'on' | 'off';
  channel: number;
  pitch: number;
  velocity: number;
}

/**
 * Decodes a packed UMP MIDI 1.0 channel-voice word into a note boundary.
 * A note-on with velocity 0 is treated as a note-off per MIDI 1.0 semantics.
 *
 * @param ppq Event position in PPQ.
 * @param data0 Packed 32-bit UMP word.
 * @returns The decoded boundary, or null for non-note events.
 */
function decodeNoteEvent(ppq: number, data0: number): DecodedNoteEvent | null {
  if (((data0 >>> 28) & 0xf) !== UMP_MIDI1_CHANNEL_VOICE) return null;
  const status = (data0 >>> 20) & 0xf;
  const channel = (data0 >>> 16) & 0xf;
  const pitch = (data0 >>> 8) & 0x7f;
  const velocity = data0 & 0x7f;
  if (status === STATUS_NOTE_ON && velocity > 0) {
    return { ppq, kind: 'on', channel, pitch, velocity };
  }
  if (status === STATUS_NOTE_OFF || status === STATUS_NOTE_ON) {
    return {
      ppq,
      kind: 'off',
      channel,
      pitch,
      velocity: status === STATUS_NOTE_OFF ? velocity : 0,
    };
  }
  return null;
}

/**
 * Pairs serialized note-on/note-off events into editor-compatible notes.
 *
 * Boundaries are matched FIFO per (channel, pitch); note-offs sort before
 * note-ons at the same PPQ so back-to-back repeats pair correctly. Unmatched
 * boundaries and non-note events (CC, pitch bend, ...) are dropped since the
 * editor only manages note content.
 *
 * @param events Serialized events from the Project JSON document.
 * @returns Recovered notes sorted by start position.
 */
export function pairSmfEventsIntoNotes(events: ReadonlyArray<SerializedMidiEvent>): ImportedNote[] {
  const decoded: DecodedNoteEvent[] = [];
  for (const event of events) {
    const note = decodeNoteEvent(event.ppq, event.data0);
    if (note) decoded.push(note);
  }
  decoded.sort(
    (a, b) =>
      a.ppq - b.ppq ||
      (a.kind === b.kind ? 0 : a.kind === 'off' ? -1 : 1) ||
      a.pitch - b.pitch ||
      a.channel - b.channel,
  );
  const pending = new Map<string, Array<{ startPpq: number; velocity: number }>>();
  const out: ImportedNote[] = [];
  for (const event of decoded) {
    const key = `${event.channel}:${event.pitch}`;
    if (event.kind === 'on') {
      const queue = pending.get(key) ?? [];
      queue.push({ startPpq: event.ppq, velocity: event.velocity });
      pending.set(key, queue);
      continue;
    }
    const on = pending.get(key)?.shift();
    if (!on || event.ppq <= on.startPpq) continue;
    const note: ImportedNote = {
      pitch: event.pitch,
      velocity: on.velocity,
      startPpq: on.startPpq,
      durationPpq: event.ppq - on.startPpq,
      channel: event.channel,
    };
    if (event.velocity > 0) note.offVelocity = event.velocity;
    out.push(note);
  }
  out.sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch || a.channel - b.channel);
  return out;
}

/**
 * Imports an in-memory SMF buffer and returns its notes as editor-compatible
 * note payloads (quarter-note PPQ, matching EditorNote units).
 *
 * A scratch wasm Project is created, the SMF is imported, and the events are
 * read back through the Project JSON document (the Project exposes no MIDI
 * event getter). Clip selection rule: only the FIRST imported clip — the id
 * returned by `Project.importSmf` — is converted; additional tracks/clips in
 * a multi-track file are ignored. The scratch Project is always released.
 *
 * @param bytes Raw SMF file contents.
 * @returns Recovered notes sorted by start position.
 */
export async function importSmfToNotes(bytes: Uint8Array): Promise<ImportedNote[]> {
  const mod = await ensureWasm();
  const scratch = new mod.Project();
  try {
    const clipId = scratch.importSmf(bytes);
    const doc = JSON.parse(scratch.toJson()) as SerializedProjectDoc;
    const stored = doc.midi_content?.[String(clipId)];
    const events = Array.isArray(stored) ? (stored as SerializedMidiEvent[]) : [];
    return pairSmfEventsIntoNotes(events);
  } finally {
    scratch.delete();
  }
}

/**
 * Exports a Project's tempo map and MIDI clips to an SMF byte buffer.
 *
 * @param project Live wasm Project handle (e.g. from getProject()).
 * @returns SMF file contents.
 */
export function exportSmfFromProject(project: Project): Uint8Array {
  return project.exportSmf();
}

/**
 * Downloads a Project's content as a .mid file.
 *
 * @param project Live wasm Project handle.
 * @param filename Suggested file name; ".mid" is appended when missing.
 */
export function exportSmfFile(project: Project, filename: string): void {
  const bytes = exportSmfFromProject(project);
  // Copy into a fresh buffer so the Blob never aliases wasm-owned memory.
  const blob = new Blob([new Uint8Array(bytes)], { type: SMF_MIME });
  downloadBlob(blob, ensureFileExtension(filename, '.mid'));
}
