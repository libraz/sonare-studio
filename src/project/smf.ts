import type { ProjectMarkerKind, ProjectMidiEvent } from '@libraz/libsonare';
import { keySignatureFromName } from '@/compose/key-name';
import { type LossReport, LossTally, tallyFields } from '@/export/loss-descriptor';
import { dbToLinear, linearToDb } from '@/lib/db';
import { clampInt } from '@/lib/math';
import { ensureWasm } from '@/lib/wasm';
import {
  effectiveTrackInstrument,
  GM2_DRUM_BANK_MSB,
  gmProgramForPreset,
  sf2ChannelProgram,
} from './instrument';
import { expandExpressionPoints, MIDI_PITCH_BEND_MAX } from './midi-cc';
import { notesToProjectMidiEvents } from './midi-events';
import {
  audibleMidiProjector,
  audibleMidiSourceWindow,
  MAX_LOOP_OCCURRENCES,
} from './midi-projection';
import { vcaOffsetDb } from './mixer';
import type {
  DocumentClip,
  DocumentMarker,
  DocumentTempoSegment,
  DocumentTrack,
  ProjectDocument,
} from './serialization';
import {
  MIDI_EXPORT_LOSS_KINDS,
  type MidiExportLossKind,
  type MidiExportTrackContext,
  midiExportTrackContext,
  SMF_CLIP_FIELDS,
  SMF_DOCUMENT_FIELDS,
  SMF_TRACK_FIELDS,
} from './smf-export-loss';
import {
  DEFAULT_CLIP_LENGTH_PPQ,
  DEFAULT_SAMPLE_RATE,
  MAX_SMF_SYSEX_BYTES,
  MAX_SMF_SYSEX_PACKETS,
  parseSmfHeader,
} from './smf-shared';
import { DEFAULT_TEMPO_BPM } from './tempo-map';
import type { SmfSysExPacket } from './types';

export {
  extractSmfSysEx,
  inspectSmfSysEx,
  smfToProjectDocument,
} from './smf-import';
export { MAX_SMF_SYSEX_BYTES, MAX_SMF_SYSEX_PACKETS } from './smf-shared';

const SMF_EDGE_PAD_PPQ = 1 / 480;
/** Largest permitted instantaneous tempo error while approximating a ramp. */
export const SMF_TEMPO_RAMP_MAX_ERROR_BPM = 0.1;
/** Prevent pathological documents from creating an unbounded SMF meta stream. */
const MAX_SMF_TEMPO_RAMP_STEPS = 4096;

export {
  MIDI_EXPORT_LOSS_KINDS,
  type MidiExportLossKind,
  type MidiExportTrackContext,
  midiExportTrackContext,
  SMF_CLIP_FIELDS,
  SMF_DOCUMENT_FIELDS,
  SMF_TRACK_FIELDS,
} from './smf-export-loss';

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

type WasmModule = typeof import('@libraz/libsonare');

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function markerKind(marker: DocumentMarker): {
  kind: ProjectMarkerKind;
  name: string;
  keyFifths?: number;
  keyMinor?: boolean;
} {
  const name = marker.name.trim();
  if (name.startsWith('Text: ')) return { kind: 'text', name: name.slice(6) };
  if (name.startsWith('Lyric: ')) return { kind: 'lyric', name: name.slice(7) };
  if (name.startsWith('Cue: ')) return { kind: 'cuePoint', name: name.slice(5) };
  if (name.startsWith('Key: ')) {
    const key = keySignatureFromName(name.slice(5));
    if (key)
      return {
        kind: 'keySignature',
        name: name.slice(5),
        keyFifths: key.fifths,
        keyMinor: key.minor,
      };
  }
  return { kind: 'marker', name };
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
      events.push(
        wasm.midiCc({
          ppq,
          group: 0,
          channel,
          controller,
          value: clampInt(point.value, 0, 127),
        }),
      );
    }
  }
  for (const lane of clip.pitchBendLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    for (const point of repeatExpression(
      expandExpressionPoints(lane.points, expressionLength, MIDI_PITCH_BEND_MAX),
    )) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(
        wasm.midiPitchBend({
          ppq,
          group: 0,
          channel,
          bend: clampInt(point.value, 0, MIDI_PITCH_BEND_MAX),
        }),
      );
    }
  }
  for (const lane of clip.programChangeLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    for (const point of repeatExpression(lane.points)) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(
        wasm.midiProgram({ ppq, group: 0, channel, program: clampInt(point.program, 0, 127) }),
      );
    }
  }
  for (const lane of clip.channelPressureLanes ?? []) {
    const channel = clampInt(lane.channel, 0, 15);
    for (const point of repeatExpression(
      expandExpressionPoints(lane.points, expressionLength, 127),
    )) {
      const ppq = finiteNonNegative(point.ppq, -1);
      events.push(
        wasm.midiChannelPressure({
          ppq,
          group: 0,
          channel,
          pressure: clampInt(point.value, 0, 127),
        }),
      );
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
        wasm.midiPolyPressure({
          ppq,
          group: 0,
          channel,
          note: pitch,
          pressure: clampInt(point.value, 0, 127),
        }),
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
        prelude.push([
          wasm.midiCc({
            ppq: 0,
            group: 0,
            channel: ch,
            controller: 10,
            value: clampInt((staticPan + 1) * 63.5, 0, 127),
          }),
        ]);
      }
      if (staticVolume !== 1) {
        prelude.push([
          wasm.midiCc({
            ppq: 0,
            group: 0,
            channel: ch,
            controller: 7,
            value: gmVolumeCc(staticVolume),
          }),
        ]);
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
          wasm.midiBankProgram({
            ppq: 0,
            group: 0,
            channel: ch,
            program,
            bank: { msb: importedBank >> 7, lsb: importedBank & 0x7f },
          }),
        );
      } else if (preset === 'drumKit') {
        prelude.push(
          wasm.midiBankProgram({
            ppq: 0,
            group: 0,
            channel: ch,
            program,
            bank: { msb: GM2_DRUM_BANK_MSB, lsb: 0 },
          }),
        );
      } else {
        prelude.push([wasm.midiProgram({ ppq: 0, group: 0, channel: ch, program })]);
      }
    }
  } else if (instrument?.kind === 'sf2') {
    for (const ch of channels) {
      const selection = sf2ChannelProgram(instrument, ch);
      if (!selection) continue;
      const program = clampInt(selection.program ?? 0, 0, 127);
      if (selection.bank === undefined) {
        prelude.push([wasm.midiProgram({ ppq: 0, group: 0, channel: ch, program })]);
      } else {
        const bank = clampInt(selection.bank, 0, 16383);
        prelude.push(
          wasm.midiBankProgram({
            ppq: 0,
            group: 0,
            channel: ch,
            program,
            bank: { msb: bank >> 7, lsb: bank & 0x7f },
          }),
        );
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
    project.setMarker({
      ppq: finiteNonNegative(marker.ppq),
      ...(meta.name !== '' ? { name: meta.name } : {}),
      kind: meta.kind,
      ...(meta.keyFifths !== undefined ? { keyFifths: meta.keyFifths } : {}),
      ...(meta.keyMinor !== undefined ? { keyMinor: meta.keyMinor } : {}),
    });
  }
  // SMF has no native section-range construct. Preserve each section's cue at
  // its start as a marker so external DAWs and a later SMF import still expose
  // the arrangement landmarks.
  for (const section of doc.sections) {
    if (!section.name.trim()) continue;
    project.setMarker({
      ppq: finiteNonNegative(section.startPpq),
      name: section.name,
      kind: 'cuePoint',
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
    project.destroy();
  }
}

/** Exports an app project document as SMF through libsonare. */
export async function projectDocumentToSmf(doc: ProjectDocument): Promise<Uint8Array> {
  return (await projectDocumentToSmfWithLoss(doc)).bytes;
}
