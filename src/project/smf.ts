import { ensureWasm } from '@/lib/wasm';
import type { ProjectMidiEvent } from '@/wasm/index.js';
import { expandExpressionPoints, MIDI_PITCH_BEND_MAX } from './midi-cc';
import {
  notesToProjectMidiEvents,
  pairEventsIntoNotes,
  type SerializedMidiEvent,
} from './midi-events';
import { audibleMidiProjector } from './midi-projection';
import {
  type DocumentClip,
  type DocumentMarker,
  type DocumentTrack,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type ProjectDocument,
} from './serialization';
import { TRACK_COLOR_PALETTE } from './types';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BPM = 120;
const DEFAULT_CLIP_LENGTH_PPQ = 1;
const SMF_EDGE_PAD_PPQ = 1 / 480;
const PPQ_INTEGER_EPSILON = 1 / 256;

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

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
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

function presetForGmProgram(program: number, ch: number, bank?: number): string {
  if (ch === 9 || bank === 128) return 'drum-kit';
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
  if (program < 120) return 'drum-kit';
  return 'sine';
}

function gmProgramForPreset(preset: string): number {
  switch (preset) {
    case 'acoustic-piano':
      return 0;
    case 'e-piano':
      return 8;
    case 'organ':
      return 16;
    case 'electric-guitar':
      return 27;
    case 'sub-bass':
      return 38;
    case 'warm-pad':
      return 89;
    case 'brass':
      return 61;
    case 'saw-lead':
      return 81;
    case 'square-lead':
      return 80;
    case 'pluck':
      return 104;
    case 'drum-kit':
      return 0;
    case 'sine':
      return 120;
    default:
      return 4;
  }
}

function keySignatureLabel(fifths: number, minor: boolean): string {
  const major = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const minorKeys = [
    'Ab',
    'Eb',
    'Bb',
    'F',
    'C',
    'G',
    'D',
    'A',
    'E',
    'B',
    'F#',
    'C#',
    'G#',
    'D#',
    'A#',
  ];
  const index = fifths + 7;
  const tonic = minor ? minorKeys[index] : major[index];
  return `${tonic ?? 'C'} ${minor ? 'minor' : 'major'}`;
}

function keySignaturePayload(label: string): { fifths: number; minor: boolean } | null {
  const match = label.trim().match(/^([A-G](?:b|#)?)\s+(major|minor)$/i);
  if (!match) return null;
  const tonic = match[1].replace(/[a-g]/, (letter) => letter.toUpperCase());
  const mode = match[2].toLowerCase();
  const major = new Map([
    ['Cb', -7],
    ['Gb', -6],
    ['Db', -5],
    ['Ab', -4],
    ['Eb', -3],
    ['Bb', -2],
    ['F', -1],
    ['C', 0],
    ['G', 1],
    ['D', 2],
    ['A', 3],
    ['E', 4],
    ['B', 5],
    ['F#', 6],
    ['C#', 7],
  ]);
  const minor = new Map([
    ['Ab', -7],
    ['Eb', -6],
    ['Bb', -5],
    ['F', -4],
    ['C', -3],
    ['G', -2],
    ['D', -1],
    ['A', 0],
    ['E', 1],
    ['B', 2],
    ['F#', 3],
    ['C#', 4],
    ['G#', 5],
    ['D#', 6],
    ['A#', 7],
  ]);
  const fifths = mode === 'major' ? major.get(tonic) : minor.get(tonic);
  return fifths === undefined ? null : { fifths, minor: mode === 'minor' };
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
  if (ch === 9) return { channel: ch, bank: 128, program: 0 };
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
    return `Key: ${keySignatureLabel(marker.key_fifths ?? 0, marker.key_minor === true)}`;
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
    const key = keySignaturePayload(name.slice(5));
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
  const clip: DocumentClip = {
    name,
    startPpq: 0,
    lengthPpq: displayClipLength(
      Math.max(
        lengthPpq,
        ...notes.map((note) => note.startPpq + note.durationPpq),
        ...events.map((event) => event.ppq),
      ),
    ),
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
    programs.find((entry) => entry.channel === 9 || entry.bank === 128) ??
    programs[0] ??
    defaultProgram ??
    (events.some((event) => channel(event) === 9)
      ? { ppq: 0, channel: 9, program: 0, bank: 128 }
      : undefined);
  const instrument = firstProgram
    ? {
        instrument: {
          kind: 'synth-preset' as const,
          preset: presetForGmProgram(firstProgram.program, firstProgram.channel, firstProgram.bank),
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
        group.key.channel === 9 || group.key.bank === 128
          ? ` Ch ${group.key.channel + 1} Drums`
          : ` Ch ${group.key.channel + 1} ${presetForGmProgram(group.key.program ?? 0, group.key.channel, group.key.bank)}`;
      return trackDocument(track, clip, group.events, index + offset, suffix);
    });
}

function documentFromProjectJson(json: string, fileName?: string): ProjectDocument {
  const parsed = JSON.parse(json) as SerializedProjectDoc;
  const tracksById = new Map((parsed.tracks ?? []).map((track) => [track.id, track]));
  const tracks: DocumentTrack[] = [];
  for (const clip of parsed.clips ?? []) {
    const track = tracksById.get(clip.track_id);
    if (track?.kind !== 1) continue;
    const events = extractEvents(parsed.midi_content?.[String(clip.id)]);
    tracks.push(...splitTrackByChannelAndProgram(track, clip, events, tracks.length));
  }
  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    name: projectNameFromFileName(fileName),
    sampleRate: DEFAULT_SAMPLE_RATE,
    tempoSegments: parsed.tempo_segments?.map((segment) => ({
      startPpq: segment.start_ppq,
      bpm: segment.bpm,
      ...(segment.end_bpm !== undefined && segment.end_bpm > 0 ? { endBpm: segment.end_bpm } : {}),
    })) ?? [{ startPpq: 0, bpm: DEFAULT_BPM }],
    timeSignatures:
      parsed.time_signatures?.map((signature) => ({
        startPpq: signature.start_ppq,
        numerator: signature.numerator,
        denominator: signature.denominator,
      })) ?? [],
    tracks:
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
          ],
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
  // including left-trimmed sustains and a clipped final partial repeat.
  const notes = audibleMidiProjector(exportClip).map((occurrence) => ({
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
  const loopLength = finiteNonNegative(clip.loopLengthPpq);
  const looping = clip.loopEnabled === true && loopLength > 0 && loopLength < lengthPpq;
  const expressionLength = looping ? loopLength : lengthPpq;
  const repeatExpression = <T extends { ppq: number }>(points: ReadonlyArray<T>): T[] => {
    if (!looping) return [...points];
    const base = points.filter((point) => point.ppq >= 0 && point.ppq < expressionLength);
    const repeated: T[] = [];
    for (let offset = 0; offset < lengthPpq; offset += expressionLength) {
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

async function projectFromDocument(
  doc: ProjectDocument,
): Promise<InstanceType<WasmModule['Project']>> {
  const wasm = await ensureWasm();
  const project = new wasm.Project();
  project.setSampleRate(doc.sampleRate > 0 ? doc.sampleRate : DEFAULT_SAMPLE_RATE);
  project.setTempoSegments(
    (doc.tempoSegments.length > 0 ? doc.tempoSegments : [{ startPpq: 0, bpm: DEFAULT_BPM }]).map(
      (segment) => ({
        startPpq: Number.isFinite(segment.startPpq) ? Math.max(0, segment.startPpq) : 0,
        bpm: Number.isFinite(segment.bpm) && segment.bpm > 0 ? segment.bpm : DEFAULT_BPM,
        endBpm:
          segment.endBpm && Number.isFinite(segment.endBpm) && segment.endBpm > 0
            ? segment.endBpm
            : 0,
      }),
    ),
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
  for (const track of doc.tracks.filter((entry) => entry.kind === 'midi')) {
    const trackId = project.addTrack({ kind: 'midi', name: track.name });
    for (const clip of track.clips.filter((entry) => (entry.kind ?? 'midi') === 'midi')) {
      const lengthPpq = scratchClipLength(clip);
      const clipId = project.addClip({
        trackId,
        isMidi: true,
        startPpq: finiteNonNegative(clip.startPpq),
        lengthPpq,
        sourceOffsetPpq: 0,
        gain: Number.isFinite(clip.gain) && clip.gain >= 0 ? clip.gain : 1,
      });
      const events = clipEvents(clip, wasm);
      const instrument = track.instrument;
      const preset =
        instrument?.kind === 'synth-preset'
          ? instrument.preset
          : instrument?.kind === 'synth-patch' && instrument.patch.preset
            ? instrument.patch.preset
            : undefined;
      if (preset) {
        const importedBank =
          instrument?.kind === 'synth-preset' && instrument.gmBank !== undefined
            ? clampInt(instrument.gmBank, 0, 16383)
            : undefined;
        const program =
          instrument?.kind === 'synth-preset' && instrument.gmProgram !== undefined
            ? clampInt(instrument.gmProgram, 0, 127)
            : clampInt(gmProgramForPreset(preset), 0, 127);
        const channels = usedMidiChannels(clip);
        for (const ch of channels) {
          if (importedBank !== undefined) {
            events.unshift(
              ...wasm.Project.midiBankProgram(
                0,
                0,
                ch,
                importedBank >> 7,
                importedBank & 0x7f,
                program,
              ),
            );
          } else if (preset === 'drum-kit') {
            events.unshift(...wasm.Project.midiBankProgram(0, 0, ch, 1, 0, program));
          } else {
            events.unshift(wasm.Project.midiProgram(0, 0, ch, program));
          }
        }
      } else if (instrument?.kind === 'sf2') {
        const bank = clampInt(instrument.bank ?? 0, 0, 16383);
        const program = clampInt(instrument.program ?? 0, 0, 127);
        const channels = usedMidiChannels(clip);
        for (const ch of channels) {
          events.unshift(
            ...wasm.Project.midiBankProgram(0, 0, ch, bank >> 7, bank & 0x7f, program),
          );
        }
      }
      project.setMidiEvents(clipId, events);
    }
  }
  return project;
}

/** Imports SMF through libsonare, then adapts the native Project JSON to the app document. */
export async function smfToProjectDocument(
  bytes: ArrayBuffer | Uint8Array,
  fileName?: string,
): Promise<ProjectDocument> {
  const wasm = await ensureWasm();
  const project = new wasm.Project();
  try {
    project.importSmf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return documentFromProjectJson(project.toJson(), fileName);
  } finally {
    project.delete();
  }
}

/** Exports an app project document as SMF through libsonare. */
export async function projectDocumentToSmf(doc: ProjectDocument): Promise<Uint8Array> {
  const project = await projectFromDocument(doc);
  try {
    return new Uint8Array(project.exportSmf());
  } finally {
    project.delete();
  }
}
