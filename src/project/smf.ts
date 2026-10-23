import { keyMarkerName, keySignatureFromName } from '@/compose/key-name';
import { GM_PERCUSSION_CHANNEL } from '@/compose/tracks';
import {
  type FieldDispositions,
  type LossReport,
  LossTally,
  tallyFields,
} from '@/export/loss-descriptor';
import { dbToLinear, linearToDb } from '@/lib/db';
import { clampInt } from '@/lib/math';
import { ensureWasm } from '@/lib/wasm';
import type { ProjectMidiEvent } from '@/wasm/index.js';
import {
  effectiveTrackInstrument,
  GM2_DRUM_BANK,
  GM2_DRUM_BANK_MSB,
  gmProgramForPreset,
  isGm2DrumBank,
  sf2ChannelProgram,
} from './instrument';
import { expandExpressionPoints, MIDI_PITCH_BEND_MAX } from './midi-cc';
import {
  notesToProjectMidiEvents,
  pairEventsIntoNotes,
  type SerializedMidiEvent,
} from './midi-events';
import {
  audibleMidiProjector,
  audibleMidiSourceWindow,
  MAX_LOOP_OCCURRENCES,
} from './midi-projection';
import { type MixerStrip, masteringChainIsActive, vcaOffsetDb } from './mixer';
import {
  type DocumentAutomationLane,
  type DocumentClip,
  type DocumentMarker,
  type DocumentTempoSegment,
  type DocumentTrack,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from './serialization';
import { DEFAULT_TEMPO_BPM } from './tempo-map';
import { type SmfSysExPacket, TRACK_COLOR_PALETTE } from './types';

const DEFAULT_SAMPLE_RATE = 48000;
/** First GM program of the sound-effects family; lower percussive programs map to the drum kit. */
const GM_SOUND_EFFECTS_PROGRAM = 120;
const DEFAULT_CLIP_LENGTH_PPQ = 1;
const SMF_EDGE_PAD_PPQ = 1 / 480;
const PPQ_INTEGER_EPSILON = 1 / 256;
/** Largest permitted instantaneous tempo error while approximating a ramp. */
export const SMF_TEMPO_RAMP_MAX_ERROR_BPM = 0.1;
/** Prevent pathological documents from creating an unbounded SMF meta stream. */
const MAX_SMF_TEMPO_RAMP_STEPS = 4096;
/** Bound opaque sidecar data so an imported SMF cannot bloat a project document. */
export const MAX_SMF_SYSEX_PACKETS = 4096;
export const MAX_SMF_SYSEX_BYTES = 1024 * 1024;

/**
 * Feature classes a MIDI-file export (SMF or MIDI 2.0 clip file) can drop, in
 * dialog order. Each format reports the subset its writer actually drops.
 */
export const MIDI_EXPORT_LOSS_KINDS = [
  'nonMidiTracks',
  'emptyMidiTracks',
  'emptyMidiClips',
  'mutedTracks',
  'soloedTracks',
  'trackMixLevels',
  'instrumentTracks',
  'clipGains',
  'clipFades',
  'midiFxTracks',
  'expressionMaps',
  'expressionLanes',
  'sysExPackets',
  'automationLanes',
  'mixerProcessing',
  'clampedTrackGains',
  'markers',
] as const;

export type MidiExportLossKind = (typeof MIDI_EXPORT_LOSS_KINDS)[number];

/** Mixer state a MIDI-file writer needs to resolve a track's audible level. */
export interface MidiExportTrackContext {
  /** VCA group id -> fader offset in dB. */
  vcaGainDb: ReadonlyMap<string, number>;
  /** VCA group ids that currently mute their members. */
  mutedVcaIds: ReadonlySet<string>;
}

export function midiExportTrackContext(doc: ProjectDocument): MidiExportTrackContext {
  const groups = doc.mixer?.vcaGroups ?? [];
  return {
    vcaGainDb: new Map(groups.map((group) => [group.id, group.gainDb])),
    mutedVcaIds: new Set(groups.filter((group) => group.mute === true).map((group) => group.id)),
  };
}

function enabledLaneCount(lanes: ReadonlyArray<DocumentAutomationLane> | undefined): number {
  return (lanes ?? []).filter((lane) => lane.enabled && lane.points.length > 0).length;
}

function stripHasProcessing(strip: MixerStrip | undefined): boolean {
  return (
    strip !== undefined &&
    (strip.inserts.length > 0 ||
      strip.sends.some((send) => send.enabled) ||
      strip.eq?.enabled === true ||
      strip.outputBusId !== undefined)
  );
}

/** Project fields as the SMF writer treats them. */
export const SMF_DOCUMENT_FIELDS: FieldDispositions<ProjectDocument, MidiExportLossKind> = {
  schemaVersion: 'derived',
  name: 'not-content',
  sampleRate: 'not-content',
  tempoSegments: 'written',
  timeSignatures: 'written',
  pickupLengthPpq: 'not-content',
  generationSeed: 'not-content',
  scaleHighlight: 'not-content',
  tracks: 'written',
  markers: 'written',
  // Section starts are written as cue markers.
  sections: 'written',
  masterAutomation: { lost: 'automationLanes', count: enabledLaneCount },
  chords: 'not-content',
  mixer: {
    lost: 'mixerProcessing',
    count: (mixer) =>
      mixer === undefined
        ? 0
        : mixer.buses.length +
          (stripHasProcessing(mixer.master) || mixer.master.gainDb !== 0 ? 1 : 0) +
          (masteringChainIsActive(mixer.masteringChain) ? 1 : 0),
  },
  externalMidiDefault: 'not-content',
  score: 'not-content',
  midiCcBindings: 'not-content',
  controlSurface: 'not-content',
  mixerSnapshots: 'not-content',
};

/** MIDI track fields as the SMF writer treats them. */
export const SMF_TRACK_FIELDS: FieldDispositions<
  DocumentTrack,
  MidiExportLossKind,
  MidiExportTrackContext
> = {
  name: 'written',
  musicXmlPartId: 'not-content',
  color: 'not-content',
  kind: 'written',
  mute: {
    lost: 'mutedTracks',
    count: (mute, track, context) =>
      mute || (track.vcaId !== undefined && context.mutedVcaIds.has(track.vcaId)) ? 1 : 0,
  },
  solo: { lost: 'soloedTracks' },
  // Static gain and pan are written as CC7/CC10.
  volume: 'written',
  pan: 'written',
  clips: 'written',
  // Written as bank/program preludes.
  instrument: 'written',
  externalMidiMode: 'not-content',
  midiFx: { lost: 'midiFxTracks' },
  mixer: { lost: 'mixerProcessing', count: (strip) => (stripHasProcessing(strip) ? 1 : 0) },
  automation: { lost: 'automationLanes', count: enabledLaneCount },
  groupIndex: 'not-content',
  soloSafe: 'not-content',
  percussion: 'not-content',
  generated: 'not-content',
  // Folded into CC7.
  vcaId: 'written',
  chordFollow: 'not-content',
  expressionMap: { lost: 'expressionMaps' },
  frozen: 'not-content',
  recordInputChannel: 'not-content',
  recordInputDeviceId: 'not-content',
  pitchRange: 'not-content',
  leadFollow: 'not-content',
};

/** MIDI clip fields as the SMF writer treats them. */
export const SMF_CLIP_FIELDS: FieldDispositions<DocumentClip, MidiExportLossKind> = {
  name: 'not-content',
  startPpq: 'written',
  lengthPpq: 'written',
  sourceOffsetPpq: 'written',
  // A silenced clip (gain <= 0) is written without notes, as playback does.
  gain: { lost: 'clipGains', count: (gain) => (gain > 0 && gain !== 1 ? 1 : 0) },
  loopEnabled: 'written',
  loopLengthPpq: 'written',
  notes: 'written',
  kind: 'written',
  assetId: 'not-content',
  externalStemRole: 'not-content',
  contentHash: 'not-content',
  fadeInPpq: { lost: 'clipFades', count: (fade) => ((fade ?? 0) > 0 ? 1 : 0) },
  fadeOutPpq: { lost: 'clipFades', count: (fade) => ((fade ?? 0) > 0 ? 1 : 0) },
  takes: 'not-content',
  compSegments: 'not-content',
  midiTakes: 'not-content',
  midiActiveTakeIndex: 'not-content',
  midiCompSegments: 'not-content',
  warp: 'not-content',
  ccLanes: 'written',
  pitchBendLanes: 'written',
  programChangeLanes: 'written',
  channelPressureLanes: 'written',
  polyPressureLanes: 'written',
  smfSysEx: 'written',
  scoreAnnotations: 'not-content',
};

function clipHasMidiEvents(clip: DocumentClip): boolean {
  return (
    (clip.gain > 0 && clip.notes.length > 0) ||
    (clip.ccLanes?.some((lane) => lane.points.length > 0) ?? false) ||
    (clip.pitchBendLanes?.some((lane) => lane.points.length > 0) ?? false) ||
    (clip.programChangeLanes?.some((lane) => lane.points.length > 0) ?? false) ||
    (clip.channelPressureLanes?.some((lane) => lane.points.length > 0) ?? false) ||
    (clip.polyPressureLanes?.some((lane) => lane.points.length > 0) ?? false) ||
    (clip.smfSysEx?.length ?? 0) > 0
  );
}

/**
 * CC7 value whose General MIDI curve (40 * log10(v / 127) dB) reproduces a
 * linear gain; boosts above unity clamp to 127.
 */
export function gmVolumeCc(linearGain: number): number {
  return clampInt(127 * Math.sqrt(Math.max(0, linearGain)), 0, 127);
}

const STATUS_POLY_PRESSURE = 0xa;
const STATUS_NOTE_OFF = 0x8;
const STATUS_NOTE_ON = 0x9;
const STATUS_CONTROL_CHANGE = 0xb;
const STATUS_PROGRAM_CHANGE = 0xc;
const STATUS_CHANNEL_PRESSURE = 0xd;
const STATUS_PITCH_BEND = 0xe;

const MARKER_KIND_TEXT = 1;
const MARKER_KIND_LYRIC = 2;
const MARKER_KIND_CUE_POINT = 3;
const MARKER_KIND_KEY_SIGNATURE = 4;

interface SerializedTempoSegment {
  start_ppq: number;
  bpm: number;
  end_bpm?: number;
}

interface SerializedTimeSignature {
  start_ppq: number;
  numerator: number;
  denominator: number;
}

interface SerializedTrack {
  id: number;
  kind: number;
  name: string;
}

interface SerializedClip {
  id: number;
  track_id: number;
  start_ppq: number;
  length_ppq: number;
  source_offset_ppq?: number;
  gain?: number;
  loop_mode?: number;
  loop_length_ppq?: number;
}

interface SerializedMarker {
  ppq: number;
  name: string;
  kind?: number;
  key_fifths?: number;
  key_minor?: boolean;
}

interface SerializedProjectDoc {
  tempo_segments?: SerializedTempoSegment[];
  time_signatures?: SerializedTimeSignature[];
  tracks?: SerializedTrack[];
  clips?: SerializedClip[];
  markers?: SerializedMarker[];
  midi_content?: Record<string, unknown>;
}

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

type WasmModule = typeof import('@/wasm/index.js');

function projectNameFromFileName(fileName?: string): string {
  const trimmed = (fileName ?? '').trim();
  if (!trimmed) return 'Imported MIDI';
  return trimmed.replace(/\.(midi?|smf)$/i, '') || 'Imported MIDI';
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

function smfU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function smfU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000 +
      ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>>
    0
  );
}

interface SmfHeader {
  headerLength: number;
  format: number;
  tracks: number;
  ticksPerQuarter: number;
  dataOffset: number;
}

function parseSmfHeader(bytes: Uint8Array): SmfHeader | null {
  if (bytes.length < 14 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'MThd') {
    return null;
  }
  const headerLength = smfU32(bytes, 4);
  const dataOffset = 8 + headerLength;
  if (headerLength < 6 || dataOffset > bytes.length) return null;
  const ticksPerQuarter = smfU16(bytes, 12);
  // SMPTE division has no fixed PPQ mapping; libsonare rejects it too.
  if ((ticksPerQuarter & 0x8000) !== 0 || ticksPerQuarter === 0) return null;
  return {
    headerLength,
    format: smfU16(bytes, 8),
    tracks: smfU16(bytes, 10),
    ticksPerQuarter,
    dataOffset,
  };
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

/** Returns SysEx packet and payload counts without exposing packet bodies. */
export function inspectSmfSysEx(bytes: Uint8Array): { packets: number; payloadBytes: number } {
  const packets = extractSmfSysEx(bytes);
  return {
    packets: packets.length,
    payloadBytes: packets.reduce((total, packet) => total + packet.data.length, 0),
  };
}

function eventWord(event: SerializedMidiEvent): number {
  return event.data0 >>> 0;
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

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function displayClipLength(lengthPpq: number): number {
  const rounded = Math.round(lengthPpq);
  if (Math.abs(lengthPpq - rounded) < PPQ_INTEGER_EPSILON) {
    return Math.max(DEFAULT_CLIP_LENGTH_PPQ, rounded);
  }
  return Math.max(DEFAULT_CLIP_LENGTH_PPQ, Math.ceil(lengthPpq));
}

/** Maps a GM program, channel and bank to the closest built-in synth preset. */
export function presetForGmProgram(program: number, ch: number, bank?: number): string {
  if (ch === GM_PERCUSSION_CHANNEL || isGm2DrumBank(bank)) return 'drum-kit';
  if (program === 4 || program === 5) return 'e-piano';
  if (program < 8) return 'acoustic-piano';
  if (program < 16) return 'e-piano';
  if (program < 24) return 'organ';
  if (program < 32) return 'electric-guitar';
  if (program < 40) return 'sub-bass';
  if (program < 56) return 'warm-pad';
  if (program < 64) return 'brass';
  if (program < 80) return 'organ';
  if (program === 80) return 'square-lead';
  if (program < 88) return 'saw-lead';
  if (program < 96) return 'warm-pad';
  if (program < 112) return 'pluck';
  if (program < GM_SOUND_EFFECTS_PROGRAM) return 'drum-kit';
  return 'sine';
}

function extractEvents(raw: unknown): SerializedMidiEvent[] {
  return (Array.isArray(raw) ? raw : [])
    .map((event) => event as Partial<SerializedMidiEvent>)
    .filter(
      (event): event is SerializedMidiEvent =>
        typeof event.ppq === 'number' &&
        typeof event.data0 === 'number' &&
        typeof event.data1 === 'number',
    );
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

function markerName(marker: SerializedMarker): string {
  if (marker.kind === MARKER_KIND_TEXT) return `Text: ${marker.name}`;
  if (marker.kind === MARKER_KIND_LYRIC) return `Lyric: ${marker.name}`;
  if (marker.kind === MARKER_KIND_CUE_POINT) return `Cue: ${marker.name}`;
  if (marker.kind === MARKER_KIND_KEY_SIGNATURE) {
    return keyMarkerName(marker.key_fifths ?? 0, marker.key_minor === true);
  }
  return marker.name;
}

function markerKind(marker: DocumentMarker): {
  kind: number;
  name: string;
  keyFifths?: number;
  keyMinor?: boolean;
} {
  const name = marker.name.trim();
  if (name.startsWith('Text: ')) return { kind: MARKER_KIND_TEXT, name: name.slice(6) };
  if (name.startsWith('Lyric: ')) return { kind: MARKER_KIND_LYRIC, name: name.slice(7) };
  if (name.startsWith('Cue: ')) return { kind: MARKER_KIND_CUE_POINT, name: name.slice(5) };
  if (name.startsWith('Key: ')) {
    const key = keySignatureFromName(name.slice(5));
    if (key)
      return {
        kind: MARKER_KIND_KEY_SIGNATURE,
        name: name.slice(5),
        keyFifths: key.fifths,
        keyMinor: key.minor,
      };
  }
  return { kind: 0, name };
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
  track: SerializedTrack,
  clip: SerializedClip,
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
    name: `${track.name || `MIDI ${index + 1}`}${nameSuffix}`,
    color: TRACK_COLOR_PALETTE[index % TRACK_COLOR_PALETTE.length],
    kind: 'midi',
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    ...instrument,
    clips: [clipFromEvents(track.name || 'MIDI Clip', clip.length_ppq, events)],
  };
}

function splitTrackByChannelAndProgram(
  track: SerializedTrack,
  clip: SerializedClip,
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

function documentFromProjectJson(
  json: string,
  fileName?: string,
  sysEx: ReadonlyArray<SmfSysExPacket> = [],
): ProjectDocument {
  const parsed = JSON.parse(json) as SerializedProjectDoc;
  const tracksById = new Map((parsed.tracks ?? []).map((track) => [track.id, track]));
  const tracks: DocumentTrack[] = [];
  for (const clip of parsed.clips ?? []) {
    const track = tracksById.get(clip.track_id);
    if (track?.kind !== 1) continue;
    const events = extractEvents(parsed.midi_content?.[String(clip.id)]);
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
            name: 'MIDI',
            color: TRACK_COLOR_PALETTE[0],
            kind: 'midi',
            mute: false,
            solo: false,
            volume: 1,
            pan: 0,
            clips: [clipFromEvents('MIDI Clip', 1, [])],
          },
        ];
  if (sysEx.length > 0) {
    let lastPpq = 0;
    for (const packet of sysEx) {
      if (packet.ppq > lastPpq) lastPpq = packet.ppq;
    }
    documentTracks.push({
      name: 'SMF SysEx',
      color: TRACK_COLOR_PALETTE[documentTracks.length % TRACK_COLOR_PALETTE.length],
      kind: 'midi',
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      clips: [
        {
          ...clipFromEvents('SMF SysEx', Math.max(DEFAULT_CLIP_LENGTH_PPQ, lastPpq + 1), []),
          smfSysEx: sysEx.map((packet) => ({ ...packet, data: packet.data.slice() })),
        },
      ],
    });
  }
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: projectNameFromFileName(fileName),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments: parsed.tempo_segments?.map((segment) => ({
      startPpq: segment.start_ppq,
      bpm: segment.bpm,
      ...(segment.end_bpm !== undefined && segment.end_bpm > 0 ? { endBpm: segment.end_bpm } : {}),
    })) ?? [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }],
    timeSignatures:
      parsed.time_signatures?.map((signature) => ({
        startPpq: signature.start_ppq,
        numerator: signature.numerator,
        denominator: signature.denominator,
      })) ?? [],
    tracks: documentTracks,
    markers:
      parsed.markers
        ?.map((marker) => ({ ppq: marker.ppq, name: markerName(marker) }))
        .sort((a, b) => a.ppq - b.ppq || a.name.localeCompare(b.name)) ?? [],
    sections: [],
  };
}

function clipEvents(clip: DocumentClip, wasm: WasmModule): ProjectMidiEvent[] {
  const lengthPpq = Math.max(
    DEFAULT_CLIP_LENGTH_PPQ,
    finiteNonNegative(clip.lengthPpq, DEFAULT_CLIP_LENGTH_PPQ),
  );
  const exportClip = {
    ...clip,
    lengthPpq,
    sourceOffsetPpq: finiteNonNegative(clip.sourceOffsetPpq),
    notes: clip.notes.map((note) => ({
      ...note,
      startPpq: finiteNonNegative(note.startPpq),
      durationPpq: finitePositive(note.durationPpq, DEFAULT_CLIP_LENGTH_PPQ),
    })),
  };
  // SMF has no clip-loop construct. Materialize every audible occurrence,
  // including left-trimmed sustains and a clipped final partial repeat. A
  // silenced clip plays no notes but still sends its controllers, as playback.
  const occurrences = clip.gain > 0 ? audibleMidiProjector(exportClip) : [];
  const notes = occurrences.map((occurrence) => ({
    pitch: clampInt(occurrence.note.pitch, 0, 127),
    velocity: clampInt(occurrence.note.velocity, 0, 127),
    startPpq: occurrence.clipStartPpq,
    durationPpq: occurrence.durationPpq,
    channel: clampInt(occurrence.note.channel, 0, 15),
    ...(occurrence.note.offVelocity !== undefined
      ? { offVelocity: clampInt(occurrence.note.offVelocity, 0, 127) }
      : {}),
  }));
  const events: ProjectMidiEvent[] = [...notesToProjectMidiEvents(notes, wasm)];
  // Use the shared loop window so SMF materialization has the same minimum
  // length and source-offset semantics as playback. This also prevents a
  // malformed sub-tick loop length from expanding indefinitely on export.
  const sourceWindow = audibleMidiSourceWindow(exportClip);
  const expressionLength = sourceWindow.lengthPpq;
  const looping = clip.loopEnabled === true && expressionLength < lengthPpq;
  const repeatExpression = <T extends { ppq: number }>(points: ReadonlyArray<T>): T[] => {
    if (!looping) return [...points];
    const base = points.filter((point) => point.ppq >= 0 && point.ppq < expressionLength);
    const repeated: T[] = [];
    for (
      let offset = 0, occurrence = 0;
      offset < lengthPpq && occurrence < MAX_LOOP_OCCURRENCES;
      offset += expressionLength, occurrence += 1
    ) {
      for (const point of base) {
        const ppq = offset + point.ppq;
        if (ppq <= lengthPpq) repeated.push({ ...point, ppq });
      }
    }
    return repeated;
  };
  for (const lane of clip.ccLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    const controller = clampInt(lane.controller, 0, 127);
    for (const point of repeatExpression(
      expandExpressionPoints(lane.points, expressionLength, 127),
    )) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(wasm.Project.midiCc(ppq, 0, channel, controller, clampInt(point.value, 0, 127)));
    }
  }
  for (const lane of clip.pitchBendLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    for (const point of repeatExpression(
      expandExpressionPoints(lane.points, expressionLength, MIDI_PITCH_BEND_MAX),
    )) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(
        wasm.Project.midiPitchBend(ppq, 0, channel, clampInt(point.value, 0, MIDI_PITCH_BEND_MAX)),
      );
    }
  }
  for (const lane of clip.programChangeLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    for (const point of repeatExpression(lane.points)) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(wasm.Project.midiProgram(ppq, 0, channel, clampInt(point.program, 0, 127)));
    }
  }
  for (const lane of clip.channelPressureLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    for (const point of repeatExpression(
      expandExpressionPoints(lane.points, expressionLength, 127),
    )) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(wasm.Project.midiChannelPressure(ppq, 0, channel, clampInt(point.value, 0, 127)));
    }
  }
  for (const lane of clip.polyPressureLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    const pitch = clampInt(lane.pitch, 0, 127);
    for (const point of repeatExpression(
      expandExpressionPoints(lane.points, expressionLength, 127),
    )) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(
        wasm.Project.midiPolyPressure(ppq, 0, channel, pitch, clampInt(point.value, 0, 127)),
      );
    }
  }
  events.sort((a, b) => a.ppq - b.ppq);
  return events;
}

/** MIDI channels that carry audible/event data in a clip.
 *
 * Instrument preludes must only be emitted on channels that are actually
 * represented by notes or expression.  Emitting a default channel 0 program
 * change creates an otherwise empty channel when a format-0 SMF is imported
 * again.
 */
function usedMidiChannels(clip: DocumentClip): Set<number> {
  const channels = new Set<number>();
  const add = (channel: number, points: ReadonlyArray<unknown>): void => {
    if (points.length > 0) channels.add(clampInt(channel, 0, 15));
  };
  for (const note of clip.notes) channels.add(clampInt(note.channel, 0, 15));
  for (const lane of clip.ccLanes ?? []) add(lane.channel, lane.points);
  for (const lane of clip.pitchBendLanes ?? []) add(lane.channel, lane.points);
  for (const lane of clip.programChangeLanes ?? []) add(lane.channel, lane.points);
  for (const lane of clip.channelPressureLanes ?? []) add(lane.channel, lane.points);
  for (const lane of clip.polyPressureLanes ?? []) add(lane.channel, lane.points);
  return channels;
}

function scratchClipLength(clip: DocumentClip): number {
  const lengthPpq = Math.max(
    DEFAULT_CLIP_LENGTH_PPQ,
    finiteNonNegative(clip.lengthPpq, DEFAULT_CLIP_LENGTH_PPQ),
  );
  const sourceOffsetPpq = finiteNonNegative(clip.sourceOffsetPpq);
  const hasEndpointEvent =
    (clip.loopEnabled === true && clip.loopLengthPpq > 0) ||
    clip.notes.some((note) => note.startPpq + note.durationPpq - sourceOffsetPpq >= lengthPpq) ||
    (clip.ccLanes ?? []).some((lane) => lane.points.some((point) => point.ppq >= lengthPpq)) ||
    (clip.pitchBendLanes ?? []).some((lane) =>
      lane.points.some((point) => point.ppq >= lengthPpq),
    ) ||
    (clip.programChangeLanes ?? []).some((lane) =>
      lane.points.some((point) => point.ppq >= lengthPpq),
    ) ||
    (clip.channelPressureLanes ?? []).some((lane) =>
      lane.points.some((point) => point.ppq >= lengthPpq),
    ) ||
    (clip.polyPressureLanes ?? []).some((lane) =>
      lane.points.some((point) => point.ppq >= lengthPpq),
    );
  return hasEndpointEvent ? lengthPpq + SMF_EDGE_PAD_PPQ : lengthPpq;
}

/**
 * SMF stores tempo as instantaneous events, while Sonare supports linear
 * ramps. Approximate each ramp with held tempo steps whose maximum deviation
 * is bounded by {@link SMF_TEMPO_RAMP_MAX_ERROR_BPM}.
 */
export function sampleTempoRampsForSmf(doc: ProjectDocument): DocumentTempoSegment[] {
  const input = (
    doc.tempoSegments.length > 0 ? doc.tempoSegments : [{ startPpq: 0, bpm: DEFAULT_TEMPO_BPM }]
  )
    .map((segment) => ({
      startPpq: finiteNonNegative(segment.startPpq),
      bpm: Number.isFinite(segment.bpm) && segment.bpm > 0 ? segment.bpm : DEFAULT_TEMPO_BPM,
      ...(segment.endBpm !== undefined && Number.isFinite(segment.endBpm) && segment.endBpm > 0
        ? { endBpm: segment.endBpm }
        : {}),
    }))
    .sort((a, b) => a.startPpq - b.startPpq);
  const result: DocumentTempoSegment[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const segment = input[index];
    const next = input[index + 1];
    // Playback has no finite endpoint for a final tempo row, so its endBpm is
    // intentionally ignored. Keep SMF export identical rather than exporting
    // a ramp the project itself cannot play.
    if (next === undefined) {
      result.push({ startPpq: segment.startPpq, bpm: segment.bpm });
      continue;
    }
    const endPpq = next.startPpq;
    const endBpm = segment.endBpm;
    if (endBpm === undefined || endPpq <= segment.startPpq || endBpm === segment.bpm) {
      result.push({ startPpq: segment.startPpq, bpm: segment.bpm });
      continue;
    }
    const steps = Math.ceil(Math.abs(endBpm - segment.bpm) / SMF_TEMPO_RAMP_MAX_ERROR_BPM);
    if (steps > MAX_SMF_TEMPO_RAMP_STEPS) {
      throw new RangeError(
        `SMF tempo ramp requires ${steps} tempo events; maximum is ${MAX_SMF_TEMPO_RAMP_STEPS}`,
      );
    }
    for (let step = 0; step <= steps; step += 1) {
      // The following document segment, if any, owns the exact endpoint.
      if (step === steps) continue;
      // Each emitted tempo is held until the next event, so use the interval
      // midpoint rather than its left endpoint to avoid a one-sided timing
      // bias over an accelerating or decelerating ramp.
      const fraction = (step + 0.5) / steps;
      result.push({
        startPpq: segment.startPpq + (endPpq - segment.startPpq) * (step / steps),
        bpm: segment.bpm + (endBpm - segment.bpm) * fraction,
      });
    }
  }
  return result;
}

/** Rewrites every channel-voice event of the clip onto one MIDI channel. */
function clipOnChannel(clip: DocumentClip, channel: number): DocumentClip {
  const remapLanes = <T extends { channel: number }>(lanes: T[] | undefined): T[] | undefined =>
    lanes?.map((lane) => ({ ...lane, channel }));
  const out: DocumentClip = {
    ...clip,
    notes: clip.notes.map((note) => ({ ...note, channel })),
  };
  if (clip.ccLanes) out.ccLanes = remapLanes(clip.ccLanes);
  if (clip.pitchBendLanes) out.pitchBendLanes = remapLanes(clip.pitchBendLanes);
  if (clip.programChangeLanes) out.programChangeLanes = remapLanes(clip.programChangeLanes);
  if (clip.channelPressureLanes) out.channelPressureLanes = remapLanes(clip.channelPressureLanes);
  if (clip.polyPressureLanes) out.polyPressureLanes = remapLanes(clip.polyPressureLanes);
  return out;
}

/**
 * Stacks the track's static level on the clip's own CC7/CC10 lanes: a lane
 * value would otherwise replace the static CC for the rest of the file, while
 * playback keeps the fader and pan as separate stages.
 */
function clipWithStaticMix(
  clip: DocumentClip,
  staticVolume: number,
  staticPan: number,
): DocumentClip {
  if (!clip.ccLanes?.some((lane) => lane.controller === 7 || lane.controller === 10)) return clip;
  const volumeScale = gmVolumeCc(staticVolume) / 127;
  const panShift = staticPan * 63.5;
  return {
    ...clip,
    ccLanes: clip.ccLanes.map((lane) => {
      if (lane.controller === 7 && staticVolume !== 1) {
        return {
          ...lane,
          points: lane.points.map((p) => ({
            ...p,
            value: clampInt(p.value * volumeScale, 0, 127),
          })),
        };
      }
      if (lane.controller === 10 && staticPan !== 0) {
        return {
          ...lane,
          points: lane.points.map((p) => ({ ...p, value: clampInt(p.value + panShift, 0, 127) })),
        };
      }
      return lane;
    }),
  };
}

/**
 * Builds the setup of one track from its configuration: the transmit channel
 * of an external-MIDI instrument, the CC7/CC10 mix of fader, strip gain, pan
 * and VCA, and the bank/program selection per channel. Returns the clips as
 * written and the setup events that lead the track.
 */
function trackSetup(
  track: DocumentTrack,
  midiClips: DocumentClip[],
  externalMidiDefault: ProjectDocument['externalMidiDefault'],
  trackContext: MidiExportTrackContext,
  wasm: WasmModule,
  loss: LossTally<MidiExportLossKind>,
): { clips: DocumentClip[]; prelude: ProjectMidiEvent[][] } {
  const prelude: ProjectMidiEvent[][] = [];
  const instrument = track.instrument;
  const transmit = effectiveTrackInstrument(track, externalMidiDefault);
  const transmitChannel =
    transmit.kind === 'external-midi' ? clampInt(transmit.channel, 0, 15) : undefined;
  const preset =
    instrument?.kind === 'synth-preset'
      ? instrument.preset
      : instrument?.kind === 'synth-patch' && instrument.patch.preset
        ? instrument.patch.preset
        : undefined;
  // CC7 and CC10 are the interoperable SMF equivalents of Sonare's static
  // track gain/pan. Emit them before program and note events so external
  // sequencers reproduce the mix balance even though SMF has no strip model.
  const staticVolume = dbToLinear(
    linearToDb(track.volume) +
      (track.mixer?.gainDb ?? 0) +
      vcaOffsetDb(track.vcaId, trackContext.vcaGainDb),
  );
  const staticPan = track.mixer?.pan ?? track.pan;
  const clips = midiClips.map((clip) =>
    clipWithStaticMix(
      transmitChannel === undefined ? clip : clipOnChannel(clip, transmitChannel),
      staticVolume,
      staticPan,
    ),
  );
  const channels = new Set(clips.flatMap((clip) => [...usedMidiChannels(clip)]));
  if (staticVolume > 1 && channels.size > 0) loss.add('clampedTrackGains', 1, track.name);
  if (staticVolume !== 1 || staticPan !== 0) {
    for (const ch of channels) {
      if (staticPan !== 0) {
        prelude.push([wasm.Project.midiCc(0, 0, ch, 10, clampInt((staticPan + 1) * 63.5, 0, 127))]);
      }
      if (staticVolume !== 1) {
        prelude.push([wasm.Project.midiCc(0, 0, ch, 7, gmVolumeCc(staticVolume))]);
      }
    }
  }
  if (preset) {
    const importedBank =
      instrument?.kind === 'synth-preset' && instrument.gmBank !== undefined
        ? clampInt(instrument.gmBank, 0, 16383)
        : undefined;
    const program =
      instrument?.kind === 'synth-preset' && instrument.gmProgram !== undefined
        ? clampInt(instrument.gmProgram, 0, 127)
        : clampInt(gmProgramForPreset(preset), 0, 127);
    for (const ch of channels) {
      if (importedBank !== undefined) {
        prelude.push(
          wasm.Project.midiBankProgram(0, 0, ch, importedBank >> 7, importedBank & 0x7f, program),
        );
      } else if (preset === 'drum-kit') {
        prelude.push(wasm.Project.midiBankProgram(0, 0, ch, GM2_DRUM_BANK_MSB, 0, program));
      } else {
        prelude.push([wasm.Project.midiProgram(0, 0, ch, program)]);
      }
    }
  } else if (instrument?.kind === 'sf2') {
    for (const ch of channels) {
      const selection = sf2ChannelProgram(instrument, ch);
      if (!selection) continue;
      const program = clampInt(selection.program ?? 0, 0, 127);
      if (selection.bank === undefined) {
        prelude.push([wasm.Project.midiProgram(0, 0, ch, program)]);
      } else {
        const bank = clampInt(selection.bank, 0, 16383);
        prelude.push(wasm.Project.midiBankProgram(0, 0, ch, bank >> 7, bank & 0x7f, program));
      }
    }
  }
  return { clips, prelude };
}

async function projectFromDocument(
  doc: ProjectDocument,
  loss: LossTally<MidiExportLossKind>,
): Promise<InstanceType<WasmModule['Project']>> {
  const wasm = await ensureWasm();
  const project = new wasm.Project();
  project.setSampleRate(doc.sampleRate > 0 ? doc.sampleRate : DEFAULT_SAMPLE_RATE);
  project.setTempoSegments(
    sampleTempoRampsForSmf(doc).map((segment) => ({
      startPpq: segment.startPpq,
      bpm: segment.bpm,
      endBpm: 0,
    })),
  );
  if (doc.timeSignatures.length > 0) {
    project.setTimeSignatures(
      doc.timeSignatures.map((signature) => {
        const denominator = [1, 2, 4, 8, 16, 32, 64, 128].includes(signature.denominator)
          ? signature.denominator
          : 4;
        return {
          startPpq: Number.isFinite(signature.startPpq) ? Math.max(0, signature.startPpq) : 0,
          numerator: clampInt(signature.numerator, 1, 255),
          denominator,
        };
      }),
    );
  }
  for (const marker of doc.markers) {
    const meta = markerKind(marker);
    project.setMarkerEx({
      id: 0,
      ppq: finiteNonNegative(marker.ppq),
      name: meta.name,
      kind: meta.kind,
      keyFifths: meta.keyFifths,
      keyMinor: meta.keyMinor,
    });
  }
  // SMF has no native section-range construct. Preserve each section's cue at
  // its start as a marker so external DAWs and a later SMF import still expose
  // the arrangement landmarks.
  for (const section of doc.sections) {
    if (!section.name.trim()) continue;
    project.setMarkerEx({
      id: 0,
      ppq: finiteNonNegative(section.startPpq),
      name: section.name,
      kind: MARKER_KIND_CUE_POINT,
    });
  }
  tallyFields(loss, SMF_DOCUMENT_FIELDS, doc, undefined);
  const trackContext = midiExportTrackContext(doc);
  for (const track of doc.tracks) {
    if (track.kind !== 'midi' && track.clips.length > 0) loss.add('nonMidiTracks', 1, track.name);
  }
  for (const track of doc.tracks.filter((entry) => entry.kind === 'midi')) {
    tallyFields(loss, SMF_TRACK_FIELDS, track, trackContext);
    const trackId = project.addTrack({ kind: 'midi', name: track.name });
    const midiClips = track.clips.filter((entry) => (entry.kind ?? 'midi') === 'midi');
    for (const clip of midiClips) {
      tallyFields(loss, SMF_CLIP_FIELDS, clip, undefined);
      if (!clipHasMidiEvents(clip)) loss.add('emptyMidiClips', 1, clip.name);
    }
    if (!midiClips.some(clipHasMidiEvents)) loss.add('emptyMidiTracks', 1, track.name);
    const setup = trackSetup(track, midiClips, doc.externalMidiDefault, trackContext, wasm, loss);
    const clips = setup.clips;
    // SMF tracks are linear event streams, not arrangement clip containers.
    // Materialize all clips from one project track into one spanning scratch
    // clip so libsonare writes one MTrk and a later import retains track count.
    // SMF has no separate empty-clip representation. The scratch clip gives
    // native exporters a bounded timeline, but an event-free track can still
    // be omitted by an SMF writer; callers must treat it as a lossy boundary.
    let startPpq = 0;
    let endPpq = DEFAULT_CLIP_LENGTH_PPQ;
    if (clips.length > 0) {
      startPpq = Number.POSITIVE_INFINITY;
      endPpq = 0;
      for (const clip of clips) {
        const clipStartPpq = finiteNonNegative(clip.startPpq);
        startPpq = Math.min(startPpq, clipStartPpq);
        endPpq = Math.max(endPpq, clipStartPpq + scratchClipLength(clip));
      }
    }
    const clipId = project.addClip({
      trackId,
      isMidi: true,
      startPpq,
      lengthPpq: Math.max(DEFAULT_CLIP_LENGTH_PPQ, endPpq - startPpq),
      sourceOffsetPpq: 0,
      gain: 1,
    });
    const events = setup.clips.flatMap((clip) => {
      const offset = finiteNonNegative(clip.startPpq) - startPpq;
      return clipEvents(clip, wasm).map((event) => ({ ...event, ppq: event.ppq + offset }));
    });
    // Setup events lead the track; each chunk lands ahead of the previous one.
    const ordered = [...setup.prelude.reverse().flat(), ...events];
    ordered.sort((a, b) => a.ppq - b.ppq);
    project.setMidiEvents(clipId, ordered);
  }
  return project;
}

/** Imports SMF through libsonare, then adapts the native Project JSON to the app document. */
export async function smfToProjectDocument(
  bytes: ArrayBuffer | Uint8Array,
  fileName?: string,
): Promise<ProjectDocument> {
  const smfBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sysEx = extractSmfSysEx(smfBytes);
  const wasm = await ensureWasm();
  const project = new wasm.Project();
  try {
    project.importSmf(smfBytes);
    return documentFromProjectJson(project.toJson(), fileName, sysEx);
  } finally {
    project.delete();
  }
}

function writeSmfVlq(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError(`SMF delta time is outside the four-byte VLQ range: ${value}`);
  }
  const bytes = [value & 0x7f];
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) {
    bytes.unshift((remaining & 0x7f) | 0x80);
  }
  return bytes;
}

function writeSmfU16(value: number): [number, number] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function writeSmfU32(value: number): [number, number, number, number] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

interface TimelineSysExPacket extends SmfSysExPacket {
  timelinePpq: number;
  order: number;
}

function documentSysExPackets(doc: ProjectDocument): TimelineSysExPacket[] {
  const packets: TimelineSysExPacket[] = [];
  let totalBytes = 0;
  for (const track of doc.tracks) {
    if (track.kind !== 'midi') continue;
    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') !== 'midi') continue;
      for (const packet of clip.smfSysEx ?? []) {
        if (
          !Number.isFinite(packet.ppq) ||
          packet.ppq < 0 ||
          (packet.status !== 0xf0 && packet.status !== 0xf7) ||
          !Array.isArray(packet.data) ||
          !packet.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)
        ) {
          throw new RangeError('Project contains an invalid SMF SysEx packet');
        }
        totalBytes += packet.data.length;
        if (packets.length >= MAX_SMF_SYSEX_PACKETS || totalBytes > MAX_SMF_SYSEX_BYTES) {
          throw new RangeError(
            `SMF SysEx exceeds ${MAX_SMF_SYSEX_PACKETS} packets or ${MAX_SMF_SYSEX_BYTES} bytes`,
          );
        }
        packets.push({
          ppq: packet.ppq,
          status: packet.status,
          data: packet.data.slice(),
          timelinePpq: finiteNonNegative(clip.startPpq) + packet.ppq,
          order: packets.length,
        });
      }
    }
  }
  return packets.sort((a, b) => a.timelinePpq - b.timelinePpq || a.order - b.order);
}

/**
 * Adds an opaque, standards-compliant SysEx-only MTrk to native SMF output.
 * The native Project ABI cannot create SysEx events, but a separate SMF track
 * carries the original F0/F7 stream at the same musical times without altering
 * notes, channels, or the native writer's track layout.
 */
function appendDocumentSysEx(nativeSmf: Uint8Array, doc: ProjectDocument): Uint8Array {
  const packets = documentSysExPackets(doc);
  if (packets.length === 0) return nativeSmf;
  const header = parseSmfHeader(nativeSmf);
  if (!header || header.tracks >= 0xffff) {
    throw new RangeError('Cannot append SysEx to an invalid or track-saturated SMF');
  }
  const trackData: number[] = [];
  let previousTick = 0;
  for (const packet of packets) {
    const tick = Math.max(0, Math.round(packet.timelinePpq * header.ticksPerQuarter));
    const delta = writeSmfVlq(tick - previousTick);
    for (const byte of delta) trackData.push(byte);
    trackData.push(packet.status);
    const payloadLength = writeSmfVlq(packet.data.length);
    for (const byte of payloadLength) trackData.push(byte);
    for (const byte of packet.data) trackData.push(byte);
    previousTick = tick;
  }
  trackData.push(0, 0xff, 0x2f, 0);
  const appended = new Uint8Array(8 + trackData.length);
  appended.set([0x4d, 0x54, 0x72, 0x6b, ...writeSmfU32(trackData.length)]);
  appended.set(trackData, 8);

  const output = new Uint8Array(nativeSmf.length + appended.length);
  output.set(nativeSmf);
  output.set(appended, nativeSmf.length);
  // Multiple tracks require format 1; preserve format 1/2 output unchanged.
  output.set(writeSmfU16(header.format === 0 ? 1 : header.format), 8);
  output.set(writeSmfU16(header.tracks + 1), 10);
  return output;
}

/**
 * Exports an app project document as SMF through libsonare, with every
 * feature the writer dropped recorded in the returned loss report.
 */
export async function projectDocumentToSmfWithLoss(
  doc: ProjectDocument,
): Promise<{ bytes: Uint8Array; loss: LossReport<MidiExportLossKind> }> {
  const loss = new LossTally(MIDI_EXPORT_LOSS_KINDS);
  const project = await projectFromDocument(doc, loss);
  try {
    const nativeSmf = new Uint8Array(project.exportSmf());
    return { bytes: appendDocumentSysEx(nativeSmf, doc), loss: loss.report() };
  } finally {
    project.delete();
  }
}

/** Exports an app project document as SMF through libsonare. */
export async function projectDocumentToSmf(doc: ProjectDocument): Promise<Uint8Array> {
  return (await projectDocumentToSmfWithLoss(doc)).bytes;
}
