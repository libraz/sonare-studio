import type { Project, ProjectClip, ProjectMarker, ProjectTrack } from '@libraz/libsonare';
import { keyMarkerName } from '@/compose/key-name';
import { GM_PERCUSSION_CHANNEL } from '@/compose/tracks';
import { DEBUG_SURFACE_ENABLED } from '@/lib/debug-surface';
import { ensureWasm } from '@/lib/wasm';
import { defaultName } from '@/project/default-names';
import { PROJECT_DOCUMENT_SCHEMA_VERSION } from './document-schema';
import { GM2_DRUM_BANK, isGm2DrumBank, presetForGmProgram } from './instrument';
import { pairEventsIntoNotes, projectMidiContent, type SerializedMidiEvent } from './midi-events';
import type { DocumentClip, DocumentTrack, ProjectDocument } from './serialization';
import {
  DEFAULT_CLIP_LENGTH_PPQ,
  DEFAULT_SAMPLE_RATE,
  MAX_SMF_SYSEX_BYTES,
  MAX_SMF_SYSEX_PACKETS,
  parseSmfHeader,
  smfU32,
} from './smf-shared';
import { type SmfSysExPacket, TRACK_COLOR_PALETTE } from './types';

const PPQ_INTEGER_EPSILON = 1 / 256;
const STATUS_POLY_PRESSURE = 0xa;
const STATUS_NOTE_OFF = 0x8;
const STATUS_NOTE_ON = 0x9;
const STATUS_CONTROL_CHANGE = 0xb;
const STATUS_PROGRAM_CHANGE = 0xc;
const STATUS_CHANNEL_PRESSURE = 0xd;
const STATUS_PITCH_BEND = 0xe;

interface ProgramEntry {
  ppq: number;
  channel: number;
  program: number;
  bank?: number;
}

interface TrackGroupKey {
  channel: number;
  program?: number;
  bank?: number;
}

function projectNameFromFileName(fileName?: string): string {
  const trimmed = (fileName ?? '').trim();
  if (!trimmed) return defaultName('importedMidi');
  return trimmed.replace(/\.(midi?|smf)$/i, '') || defaultName('importedMidi');
}

function readSmfVlq(bytes: Uint8Array, offset: number, end: number): [number, number] | null {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    if (offset >= end) return null;
    const byte = bytes[offset++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset];
  }
  return null;
}

function smfFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Reads bounded opaque SysEx packets without decoding unrelated MIDI events. */
export function extractSmfSysEx(bytes: Uint8Array): SmfSysExPacket[] {
  const header = parseSmfHeader(bytes);
  if (!header) return [];
  let offset = header.dataOffset;
  const packets: SmfSysExPacket[] = [];
  let payloadBytes = 0;
  while (offset + 8 <= bytes.length) {
    const isTrack = smfFourCC(bytes, offset) === 'MTrk';
    const length = smfU32(bytes, offset + 4);
    offset += 8;
    const end = offset + length;
    if (end > bytes.length) break;
    if (!isTrack) {
      offset = end;
      continue;
    }
    let runningStatus: number | null = null;
    let absoluteTicks = 0;
    while (offset < end) {
      const delta = readSmfVlq(bytes, offset, end);
      if (!delta) break;
      offset = delta[1];
      absoluteTicks += delta[0];
      if (offset >= end) break;
      let status = bytes[offset++];
      let dataBytesAlreadyRead = 0;
      if (status < 0x80) {
        if (runningStatus === null) break;
        dataBytesAlreadyRead = 1;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      } else {
        runningStatus = null;
      }
      if (status === 0xf0 || status === 0xf7) {
        const size = readSmfVlq(bytes, offset, end);
        if (!size || size[1] + size[0] > end) break;
        payloadBytes += size[0];
        if (packets.length >= MAX_SMF_SYSEX_PACKETS || payloadBytes > MAX_SMF_SYSEX_BYTES) {
          throw new RangeError(
            `SMF SysEx exceeds ${MAX_SMF_SYSEX_PACKETS} packets or ${MAX_SMF_SYSEX_BYTES} bytes`,
          );
        }
        packets.push({
          ppq: absoluteTicks / header.ticksPerQuarter,
          status: status as 0xf0 | 0xf7,
          data: Array.from(bytes.subarray(size[1], size[1] + size[0])),
        });
        offset = size[1] + size[0];
        continue;
      }
      if (status === 0xff) {
        if (offset >= end) break;
        offset += 1; // meta type
        const size = readSmfVlq(bytes, offset, end);
        if (!size || size[1] + size[0] > end) break;
        offset = size[1] + size[0];
        continue;
      }
      const kind = status >> 4;
      const dataBytes = kind === STATUS_PROGRAM_CHANGE || kind === STATUS_CHANNEL_PRESSURE ? 1 : 2;
      if (
        kind < STATUS_NOTE_OFF ||
        kind > STATUS_PITCH_BEND ||
        offset + dataBytes - dataBytesAlreadyRead > end
      )
        break;
      offset += dataBytes - dataBytesAlreadyRead;
    }
    offset = end;
  }
  return packets;
}

function eventWord(event: SerializedMidiEvent): number {
  return event.word0 >>> 0;
}

function statusNibble(event: SerializedMidiEvent): number {
  return (eventWord(event) >>> 20) & 0xf;
}

function channel(event: SerializedMidiEvent): number {
  return (eventWord(event) >>> 16) & 0xf;
}

function data1(event: SerializedMidiEvent): number {
  return (eventWord(event) >>> 8) & 0x7f;
}

function data2(event: SerializedMidiEvent): number {
  return eventWord(event) & 0x7f;
}

function displayClipLength(lengthPpq: number): number {
  const rounded = Math.round(lengthPpq);
  if (Math.abs(lengthPpq - rounded) < PPQ_INTEGER_EPSILON) {
    return Math.max(DEFAULT_CLIP_LENGTH_PPQ, rounded);
  }
  return Math.max(DEFAULT_CLIP_LENGTH_PPQ, Math.ceil(lengthPpq));
}

function programsFromEvents(events: ReadonlyArray<SerializedMidiEvent>): ProgramEntry[] {
  const bankMsb = new Map<number, number>();
  const bankLsb = new Map<number, number>();
  const programs: ProgramEntry[] = [];
  for (const event of events) {
    const ch = channel(event);
    if (statusNibble(event) === STATUS_CONTROL_CHANGE) {
      if (data1(event) === 0) bankMsb.set(ch, data2(event));
      if (data1(event) === 32) bankLsb.set(ch, data2(event));
    }
    if (statusNibble(event) === STATUS_PROGRAM_CHANGE) {
      const entry: ProgramEntry = { ppq: event.ppq, channel: ch, program: data1(event) };
      const msb = bankMsb.get(ch);
      const lsb = bankLsb.get(ch);
      if (msb !== undefined || lsb !== undefined) entry.bank = (msb ?? 0) * 128 + (lsb ?? 0);
      programs.push(entry);
    }
  }
  return programs;
}

function programAt(
  programs: ReadonlyArray<ProgramEntry>,
  ch: number,
  ppq: number,
): ProgramEntry | undefined {
  let current: ProgramEntry | undefined;
  for (const entry of programs) {
    if (entry.channel !== ch || entry.ppq > ppq) continue;
    if (!current || entry.ppq >= current.ppq) current = entry;
  }
  return current;
}

function groupKey(programs: ReadonlyArray<ProgramEntry>, ch: number, ppq: number): TrackGroupKey {
  if (ch === GM_PERCUSSION_CHANNEL) return { channel: ch, bank: GM2_DRUM_BANK, program: 0 };
  const program = programAt(programs, ch, ppq);
  return {
    channel: ch,
    program: program?.program ?? 0,
    ...(program?.bank !== undefined ? { bank: program.bank } : {}),
  };
}

function groupKeyText(key: TrackGroupKey): string {
  return `${key.channel}:${key.bank ?? -1}:${key.program ?? -1}`;
}

function isNoteOn(event: SerializedMidiEvent): boolean {
  return statusNibble(event) === STATUS_NOTE_ON && data2(event) > 0;
}

function isNoteOff(event: SerializedMidiEvent): boolean {
  const status = statusNibble(event);
  return status === STATUS_NOTE_OFF || (status === STATUS_NOTE_ON && data2(event) === 0);
}

/**
 * Assigns note-off boundaries to the same import group as their note-on. This
 * keeps sustained notes intact when a Program Change occurs before note-off.
 */
function noteEventGroupOverrides(
  events: ReadonlyArray<SerializedMidiEvent>,
  programs: ReadonlyArray<ProgramEntry>,
): Map<SerializedMidiEvent, TrackGroupKey> {
  const ordered = events.map((event, index) => ({ event, index }));
  ordered.sort((a, b) => a.event.ppq - b.event.ppq || a.index - b.index);
  const pending = new Map<string, TrackGroupKey[]>();
  const overrides = new Map<SerializedMidiEvent, TrackGroupKey>();
  for (const { event } of ordered) {
    if (!isNoteOn(event) && !isNoteOff(event)) continue;
    const ch = channel(event);
    const key = `${ch}:${data1(event)}`;
    if (isNoteOn(event)) {
      const group = groupKey(programs, ch, event.ppq);
      const queue = pending.get(key) ?? [];
      queue.push(group);
      pending.set(key, queue);
      overrides.set(event, group);
      continue;
    }
    const group = pending.get(key)?.shift();
    if (group !== undefined) overrides.set(event, group);
  }
  return overrides;
}

function pushCc(
  lanes: Map<string, NonNullable<DocumentClip['ccLanes']>[number]>,
  controller: number,
  ch: number,
  ppq: number,
  value: number,
): void {
  const key = `${ch}:${controller}`;
  const lane = lanes.get(key) ?? { controller, channel: ch, points: [] };
  lane.points.push({ ppq, value });
  lanes.set(key, lane);
}

function pushBend(
  lanes: Map<string, NonNullable<DocumentClip['pitchBendLanes']>[number]>,
  ch: number,
  ppq: number,
  value: number,
): void {
  const key = String(ch);
  const lane = lanes.get(key) ?? { channel: ch, points: [] };
  lane.points.push({ ppq, value });
  lanes.set(key, lane);
}

function pushProgramChange(
  lanes: Map<string, NonNullable<DocumentClip['programChangeLanes']>[number]>,
  ch: number,
  ppq: number,
  program: number,
): void {
  const key = String(ch);
  const lane = lanes.get(key) ?? { channel: ch, points: [] };
  lane.points.push({ ppq, program });
  lanes.set(key, lane);
}

function pushChannelPressure(
  lanes: Map<string, NonNullable<DocumentClip['channelPressureLanes']>[number]>,
  ch: number,
  ppq: number,
  value: number,
): void {
  const key = String(ch);
  const lane = lanes.get(key) ?? { channel: ch, points: [] };
  lane.points.push({ ppq, value });
  lanes.set(key, lane);
}

function pushPolyPressure(
  lanes: Map<string, NonNullable<DocumentClip['polyPressureLanes']>[number]>,
  ch: number,
  pitch: number,
  ppq: number,
  value: number,
): void {
  const key = `${ch}:${pitch}`;
  const lane = lanes.get(key) ?? { channel: ch, pitch, points: [] };
  lane.points.push({ ppq, value });
  lanes.set(key, lane);
}

function sortedLanes<T extends { points: Array<{ ppq: number }> }>(lanes: Iterable<T>): T[] {
  return [...lanes].map((lane) => ({
    ...lane,
    points: [...lane.points].sort((a, b) => a.ppq - b.ppq),
  }));
}

function markerName(marker: ProjectMarker): string {
  const name = marker.name ?? '';
  if (marker.kind === 'text') return `Text: ${name}`;
  if (marker.kind === 'lyric') return `Lyric: ${name}`;
  if (marker.kind === 'cuePoint') return `Cue: ${name}`;
  if (marker.kind === 'keySignature') return keyMarkerName(marker.keyFifths, marker.keyMinor);
  return name;
}

function clipFromEvents(
  name: string,
  lengthPpq: number,
  events: ReadonlyArray<SerializedMidiEvent>,
): DocumentClip {
  const notes = pairEventsIntoNotes(events);
  const cc = new Map<string, NonNullable<DocumentClip['ccLanes']>[number]>();
  const bends = new Map<string, NonNullable<DocumentClip['pitchBendLanes']>[number]>();
  const programChanges = new Map<string, NonNullable<DocumentClip['programChangeLanes']>[number]>();
  const channelPressures = new Map<
    string,
    NonNullable<DocumentClip['channelPressureLanes']>[number]
  >();
  const polyPressures = new Map<string, NonNullable<DocumentClip['polyPressureLanes']>[number]>();
  for (const event of events) {
    const ch = channel(event);
    const status = statusNibble(event);
    if (status === STATUS_CONTROL_CHANGE) pushCc(cc, data1(event), ch, event.ppq, data2(event));
    if (status === STATUS_PITCH_BEND)
      pushBend(bends, ch, event.ppq, data1(event) | (data2(event) << 7));
    if (status === STATUS_PROGRAM_CHANGE)
      pushProgramChange(programChanges, ch, event.ppq, data1(event));
    if (status === STATUS_CHANNEL_PRESSURE)
      pushChannelPressure(channelPressures, ch, event.ppq, data1(event));
    if (status === STATUS_POLY_PRESSURE)
      pushPolyPressure(polyPressures, ch, data1(event), event.ppq, data2(event));
  }
  let maximumEventPpq = lengthPpq;
  for (const note of notes) {
    const noteEndPpq = note.startPpq + note.durationPpq;
    if (noteEndPpq > maximumEventPpq) maximumEventPpq = noteEndPpq;
  }
  for (const event of events) {
    if (event.ppq > maximumEventPpq) maximumEventPpq = event.ppq;
  }
  const clip: DocumentClip = {
    name,
    startPpq: 0,
    lengthPpq: displayClipLength(maximumEventPpq),
    sourceOffsetPpq: 0,
    gain: 1,
    loopEnabled: false,
    loopLengthPpq: 0,
    kind: 'midi',
    notes,
  };
  const ccLanes = sortedLanes(cc.values()).sort(
    (a, b) => a.channel - b.channel || a.controller - b.controller,
  );
  const pitchBendLanes = sortedLanes(bends.values()).sort((a, b) => a.channel - b.channel);
  const programChangeLanes = sortedLanes(programChanges.values()).sort(
    (a, b) => a.channel - b.channel,
  );
  const channelPressureLanes = sortedLanes(channelPressures.values()).sort(
    (a, b) => a.channel - b.channel,
  );
  const polyPressureLanes = sortedLanes(polyPressures.values()).sort(
    (a, b) => a.channel - b.channel || a.pitch - b.pitch,
  );
  if (ccLanes.length > 0) clip.ccLanes = ccLanes;
  if (pitchBendLanes.length > 0) clip.pitchBendLanes = pitchBendLanes;
  if (programChangeLanes.length > 0) clip.programChangeLanes = programChangeLanes;
  if (channelPressureLanes.length > 0) clip.channelPressureLanes = channelPressureLanes;
  if (polyPressureLanes.length > 0) clip.polyPressureLanes = polyPressureLanes;
  return clip;
}

function trackDocument(
  track: ProjectTrack,
  clip: ProjectClip,
  events: SerializedMidiEvent[],
  index: number,
  nameSuffix = '',
): DocumentTrack {
  const programs = programsFromEvents(events);
  const defaultProgram =
    programs.length === 0 && events.some((event) => isNoteOn(event))
      ? {
          ppq: 0,
          channel: channel(events.find((event) => isNoteOn(event)) as SerializedMidiEvent),
          program: 0,
        }
      : undefined;
  const firstProgram =
    programs.find(
      (entry) => entry.channel === GM_PERCUSSION_CHANNEL || isGm2DrumBank(entry.bank),
    ) ??
    programs[0] ??
    defaultProgram ??
    (events.some((event) => channel(event) === GM_PERCUSSION_CHANNEL)
      ? { ppq: 0, channel: GM_PERCUSSION_CHANNEL, program: 0, bank: GM2_DRUM_BANK }
      : undefined);
  const instrument = firstProgram
    ? {
        instrument: {
          kind: 'synth-preset' as const,
          preset: presetForGmProgram(firstProgram.program, firstProgram.channel, firstProgram.bank),
          useGmPrograms: true,
          ...(firstProgram.bank !== undefined ? { gmBank: firstProgram.bank } : {}),
          gmProgram: firstProgram.program,
        },
      }
    : {};
  return {
    name: `${track.name || defaultName('midiTrack', { number: index + 1 })}${nameSuffix}`,
    color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    ...instrument,
    clips: [clipFromEvents(track.name || defaultName('midiClip'), clip.lengthPpq, events)],
  };
}

function splitTrackByChannelAndProgram(
  track: ProjectTrack,
  clip: ProjectClip,
  events: SerializedMidiEvent[],
  index: number,
): DocumentTrack[] {
  const programs = programsFromEvents(events);
  const noteGroups = noteEventGroupOverrides(events, programs);
  const groups = new Map<string, { key: TrackGroupKey; events: SerializedMidiEvent[] }>();
  for (const event of events) {
    const ch = channel(event);
    const key = noteGroups.get(event) ?? groupKey(programs, ch, event.ppq);
    const text = groupKeyText(key);
    const group = groups.get(text) ?? { key, events: [] };
    group.events.push(event);
    groups.set(text, group);
  }
  if (groups.size <= 1) return [trackDocument(track, clip, events, index)];
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.key.channel - b.key.channel ||
        (a.key.bank ?? -1) - (b.key.bank ?? -1) ||
        (a.key.program ?? -1) - (b.key.program ?? -1),
    )
    .map((group, offset) => {
      const suffix =
        group.key.channel === GM_PERCUSSION_CHANNEL || isGm2DrumBank(group.key.bank)
          ? ` Ch ${group.key.channel + 1} Drums`
          : ` Ch ${group.key.channel + 1} ${presetForGmProgram(group.key.program ?? 0, group.key.channel, group.key.bank)}`;
      return trackDocument(track, clip, group.events, index + offset, suffix);
    });
}

function documentFromProject(
  project: Project,
  fileName?: string,
  sysEx: ReadonlyArray<SmfSysExPacket> = [],
): ProjectDocument {
  const tracksById = new Map(project.tracks().map((track) => [track.id, track]));
  const midiContent = projectMidiContent(project);
  const tracks: DocumentTrack[] = [];
  for (const clip of project.clips()) {
    const track = tracksById.get(clip.trackId);
    if (track?.kind !== 'midi') continue;
    const events = [...(midiContent[String(clip.id)] ?? [])];
    // A valid SMF can split into one derived track per channel/bank/program
    // group. Append iteratively rather than expanding an unbounded list as
    // call arguments, which has a much smaller engine-specific limit than the
    // accepted SMF event/file limits.
    for (const derived of splitTrackByChannelAndProgram(track, clip, events, tracks.length)) {
      tracks.push(derived);
    }
  }
  const documentTracks: DocumentTrack[] =
    tracks.length > 0
      ? tracks
      : [
          {
            name: defaultName('midiFallbackTrack'),
            color: TRACK_COLOR_PALETTE[0],
            kind: 'midi',
            mute: false,
            solo: false,
            volume: 1,
            pan: 0,
            clips: [clipFromEvents(defaultName('midiClip'), 1, [])],
          },
        ];
  if (sysEx.length > 0) {
    let lastPpq = 0;
    for (const packet of sysEx) {
      if (packet.ppq > lastPpq) lastPpq = packet.ppq;
    }
    documentTracks.push({
      name: defaultName('smfSysex'),
      color: TRACK_COLOR_PALETTE[documentTracks.length % TRACK_COLOR_PALETTE.length],
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [
        {
          ...clipFromEvents(
            defaultName('smfSysex'),
            Math.max(DEFAULT_CLIP_LENGTH_PPQ, lastPpq + 1),
            [],
          ),
          smfSysEx: sysEx.map((packet) => ({ ...packet, data: packet.data.slice() })),
        },
      ],
    });
  }
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: projectNameFromFileName(fileName),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments: project.tempoSegments().map((segment) => ({
      startPpq: segment.startPpq,
      bpm: segment.bpm,
      ...(segment.endBpm !== undefined && segment.endBpm > 0 ? { endBpm: segment.endBpm } : {}),
    })),
    timeSignatures: project.timeSignatures().map((signature) => ({
      startPpq: signature.startPpq,
      numerator: signature.numerator,
      denominator: signature.denominator,
    })),
    tracks: documentTracks,
    markers: project
      .markers()
      .map((marker) => ({ ppq: marker.ppq, name: markerName(marker) }))
      .sort((a, b) => a.ppq - b.ppq || a.name.localeCompare(b.name)),
    sections: [],
  };
}

/** The 8-byte header that opens a MIDI 2.0 Clip File. */
const CLIP_FILE_HEADER = 'SMF2CLIP';

let lastImportEvents: Record<string, SerializedMidiEvent[]> | null = null;

/** The engine's events from the last MIDI import, before document adaptation; debug surface only. */
export function lastMidiImportEvents(): Record<string, SerializedMidiEvent[]> | null {
  return lastImportEvents;
}

/** Forgets the recorded events of the last MIDI import. */
export function clearLastMidiImportEvents(): void {
  lastImportEvents = null;
}

function isClipFile(bytes: Uint8Array): boolean {
  if (bytes.length < CLIP_FILE_HEADER.length) return false;
  for (let i = 0; i < CLIP_FILE_HEADER.length; i += 1) {
    if (bytes[i] !== CLIP_FILE_HEADER.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Imports a Standard MIDI File or a MIDI 2.0 Clip File through libsonare,
 * chosen by the file's own header, then adapts the native Project JSON to the
 * app document. The document stores 7-bit values, so MIDI 2.0 velocities and
 * controllers are narrowed in the adaptation.
 */
export async function midiFileToProjectDocument(
  bytes: ArrayBuffer | Uint8Array,
  fileName?: string,
): Promise<ProjectDocument> {
  const fileBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const clipFile = isClipFile(fileBytes);
  const sysEx = clipFile ? [] : extractSmfSysEx(fileBytes);
  const wasm = await ensureWasm();
  const project = new wasm.Project();
  try {
    if (!clipFile) {
      project.importSmf(fileBytes);
      if (DEBUG_SURFACE_ENABLED) lastImportEvents = projectMidiContent(project);
      return documentFromProject(project, fileName, sysEx);
    }
    project.importClipFile(fileBytes);
    if (DEBUG_SURFACE_ENABLED) lastImportEvents = projectMidiContent(project);
    // The document holds MIDI 1.0 values; the engine's own SMF writer narrows the clip to them.
    const narrowed = new wasm.Project();
    try {
      narrowed.importSmf(project.exportSmf());
      return documentFromProject(narrowed, fileName, sysEx);
    } finally {
      narrowed.destroy();
    }
  } finally {
    project.destroy();
  }
}
