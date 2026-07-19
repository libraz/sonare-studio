/**
 * Realtime MIDI synchronisation: compiles the store's MIDI clips into engine
 * MIDI clip schedules and mirrors per-track instruments onto a running
 * engine, transmitting only what changed.
 *
 * Engine contract (libsonare):
 * - setMidiClips replaces the whole scheduled clip set and is NOT gated
 *   during playback: a send while the transport plays takes effect live.
 * - Each event's renderFrame is an ABSOLUTE sample position on the render
 *   timeline (not clip-relative); startSample/lengthSamples are absolute
 *   samples too. startPpq is carried for diagnostics only — the engine never
 *   converts PPQ, so the caller bakes PPQ to samples through the current
 *   tempo map and must re-send the clips after a tempo-map change.
 * - The engine sorts events by renderFrame with a NON-stable sort, so
 *   same-frame ordering is undefined; the builder avoids same-frame
 *   collisions wherever ordering matters (note-off vs note-on, program
 *   prelude vs first note).
 * - Instrument routing: an instrument bound to destination id D renders into
 *   the mixer lane whose track id is D (lanes are declared by mixer-sync).
 *   Instrument syncs are stop-gated by the engine facade itself (deferred
 *   while the transport plays, flushed on stop) — no extra gating here.
 * - loadSoundFont is GLOBAL: the engine holds a single SoundFont, so tracks
 *   needing different fonts cannot be honored — the last loaded font wins.
 * - Scheduled MIDI clips have no gain field; clip gain is expressed by
 *   scaling note-on velocities.
 */

import {
  type AutomationLaneState,
  evaluateAutomationValue,
  parseInstrumentAutomationParam,
  sanitizeAutomationPoints,
} from '@/project/automation';
import { loadFont } from '@/project/fonts';
import {
  DEFAULT_SYNTH_PRESET,
  type ExternalMidiInstrument,
  effectiveTrackInstrument,
  instrumentDedupeKey,
  sf2ChannelProgram,
  sf2PlaybackConfig,
  type TrackInstrument,
} from '@/project/instrument';
import type { MediaCompletenessIssue } from '@/project/media-completeness';
import { expandExpressionPoints, MIDI_PITCH_BEND_MAX } from '@/project/midi-cc';
import { midiFxConfigJson } from '@/project/midi-fx';
import {
  audibleMidiProjector,
  MAX_LOOP_OCCURRENCES,
  MIN_LOOP_WINDOW_PPQ,
} from '@/project/midi-projection';
import { MAX_INTERNAL_MIDI_INSTRUMENTS } from '@/project/project-capacity';
import {
  collectActiveSoundFontUsage,
  hasSoundFontSlotConflict,
} from '@/project/soundfont-conflicts';
import { normalizeTempoMap, ppqToSamples } from '@/project/tempo-map';
import { clipKind, type EditorClip, type EditorTrack, type TempoSegment } from '@/project/types';
import type { EngineMidiClipSchedule, EngineMidiEvent } from '@/wasm/index.js';
import type { EngineHandle } from './engine';

/** MIDI 1.0 channel-voice status nibbles used by the builder. */
const STATUS_NOTE_ON = 0x9;
const STATUS_NOTE_OFF = 0x8;
const STATUS_POLY_PRESSURE = 0xa;
const STATUS_CONTROL_CHANGE = 0xb;
const STATUS_PROGRAM_CHANGE = 0xc;
const STATUS_CHANNEL_PRESSURE = 0xd;
const STATUS_PITCH_BEND = 0xe;

/** Bank-select controller numbers (MSB / LSB). */
const CC_BANK_SELECT_MSB = 0;
const CC_BANK_SELECT_LSB = 32;

/** Clamps a value into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Encodes a UMP MIDI 1.0 channel-voice word (message type 0x2, group 0).
 *
 * @param status Status nibble (e.g. 0x9 note-on).
 * @param channel MIDI channel (0-15).
 * @param data0 First 7-bit data byte.
 * @param data1 Second 7-bit data byte.
 * @returns The 32-bit word0 of a wordCount-1 event.
 */
function channelVoiceWord(status: number, channel: number, data0: number, data1: number): number {
  return (
    (0x2 << 28) |
    ((status & 0xf) << 20) |
    ((channel & 0xf) << 16) |
    ((data0 & 0x7f) << 8) |
    (data1 & 0x7f)
  );
}

/** Builds a single-word channel-voice event at an absolute render frame. */
function voiceEvent(
  renderFrame: number,
  status: number,
  channel: number,
  data0: number,
  data1: number,
): EngineMidiEvent {
  return { renderFrame, word0: channelVoiceWord(status, channel, data0, data1), wordCount: 1 };
}

/**
 * Compiles the MIDI clips of the given tracks into engine clip schedules
 * (exported for tests). Only clips on 'midi' tracks with MIDI content, notes
 * and an audible gain are scheduled; clip gain is baked into the note-on
 * velocities. All PPQ positions are converted to absolute samples through the
 * given tempo map, so tempo changes and ramps inside a clip land on exact
 * frames (a clip's length is the sample distance between its start and end
 * positions, not a rounded duration).
 *
 * Note-offs are placed one sample before the note's nominal end (clamped to
 * the clip window, and never before noteOn + 1): the engine's same-frame
 * event order is undefined, so a legato note-off must sit strictly before a
 * same-pitch note-on of the following note.
 *
 * A clip's CC lanes (app-level metadata) are baked into the same event list as
 * discrete control-change events, one per breakpoint, at the breakpoint's
 * absolute frame; CC-only clips (or muted clips with CC) still schedule.
 *
 * SF2 instruments with an explicit bank and/or program get a per-channel
 * program prelude (bank-select CCs, then program change) one sample before
 * the clip start. A clip starting at sample 0 has no earlier sample, so the
 * prelude sits at frame 0 and the clip's own frame-0 note events are shifted
 * to frame 1 (one sample, inaudible) to keep the prelude strictly first.
 *
 * @param tracks Project tracks (clip track lookup and instrument source).
 * @param clips Project clips to compile.
 * @param tempoSegments Project tempo segments (empty falls back to 120 BPM).
 * @param sampleRate Render sample rate in Hz (finite, > 0).
 * @returns Schedules sorted by clip id, each with events sorted by frame.
 */
export function buildMidiClipSchedules(
  tracks: ReadonlyArray<EditorTrack>,
  clips: ReadonlyArray<EditorClip>,
  tempoSegments: ReadonlyArray<TempoSegment>,
  sampleRate: number,
  projectExternalMidi?: ExternalMidiInstrument | null,
  midiDestinationForTrack: (track: EditorTrack) => number = (track) => track.id,
): EngineMidiClipSchedule[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Sample rate must be finite and > 0, got ${sampleRate}`);
  }
  const tempoMap = normalizeTempoMap(tempoSegments);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const schedules: EngineMidiClipSchedule[] = [];

  for (const clip of clips) {
    const track = trackById.get(clip.trackId);
    if (track?.kind !== 'midi' || clipKind(clip) !== 'midi') continue;
    // Frozen tracks play their baked render; their MIDI stays silent.
    if (track.frozen !== undefined) continue;
    // Looping clips repeat a loop region to fill the clip span. Events are
    // expanded in PPQ before conversion to absolute frames instead of using
    // the engine's fixed sample-length loop: every occurrence therefore
    // follows tempo changes/ramp segments without accumulating drift.
    const looping = clip.loopEnabled === true;
    const loopRegionPpq =
      looping && clip.loopLengthPpq > 0
        ? Math.min(clip.loopLengthPpq, clip.lengthPpq)
        : clip.lengthPpq;
    // A sub-tick loop window would generate an unbounded number of occurrences
    // (reachable tab hang), so clamp it to a musical floor and cap the count.
    const windowPpq = looping ? Math.max(loopRegionPpq, MIN_LOOP_WINDOW_PPQ) : clip.lengthPpq;
    const repeatOffsets: number[] = [];
    if (looping && windowPpq > 0) {
      for (
        let offset = 0;
        offset < clip.lengthPpq - 1e-9 && repeatOffsets.length < MAX_LOOP_OCCURRENCES;
        offset += windowPpq
      ) {
        repeatOffsets.push(offset);
      }
    } else {
      repeatOffsets.push(0);
    }
    // A muted clip (gain <= 0) plays no notes, but its CC lanes still send:
    // controllers are not gain-scaled, and a CC-only clip is legitimate.
    const notes = clip.gain > 0 ? audibleMidiProjector(clip) : [];
    const ccLanes = (clip.ccLanes ?? []).filter((lane) => lane.points.length > 0);
    const pitchBendLanes = (clip.pitchBendLanes ?? []).filter((lane) => lane.points.length > 0);
    const programChangeLanes = (clip.programChangeLanes ?? []).filter(
      (lane) => lane.points.length > 0,
    );
    const channelPressureLanes = (clip.channelPressureLanes ?? []).filter(
      (lane) => lane.points.length > 0,
    );
    const polyPressureLanes = (clip.polyPressureLanes ?? []).filter(
      (lane) => lane.points.length > 0,
    );
    if (
      notes.length === 0 &&
      ccLanes.length === 0 &&
      pitchBendLanes.length === 0 &&
      programChangeLanes.length === 0 &&
      channelPressureLanes.length === 0 &&
      polyPressureLanes.length === 0
    )
      continue;

    const startSample = ppqToSamples(tempoMap, clip.startPpq, sampleRate);
    // End minus start (not a rounded duration), so tempo-segment boundaries
    // inside the clip stay exact.
    const lengthSamples =
      ppqToSamples(tempoMap, clip.startPpq + clip.lengthPpq, sampleRate) - startSample;
    const events: EngineMidiEvent[] = [];

    const instrument = effectiveTrackInstrument(track, projectExternalMidi);
    const sf2 = instrument?.kind === 'sf2' ? instrument : undefined;
    // A prelude is needed when the track sets a bank/program or carries a
    // per-channel program map (multi-timbral GM/GS module).
    let hasPrelude = false;
    if (sf2) {
      const preludeFrame = Math.max(0, startSample - 1);
      const channels = new Set([
        ...notes.map((entry) => clamp(entry.note.channel ?? 0, 0, 15)),
        ...ccLanes.map((lane) => clamp(lane.channel, 0, 15)),
        ...pitchBendLanes.map((lane) => clamp(lane.channel, 0, 15)),
        ...programChangeLanes.map((lane) => clamp(lane.channel, 0, 15)),
        ...channelPressureLanes.map((lane) => clamp(lane.channel, 0, 15)),
        ...polyPressureLanes.map((lane) => clamp(lane.channel, 0, 15)),
      ]);
      for (const channel of [...channels].sort((a, b) => a - b)) {
        const resolved = sf2ChannelProgram(sf2, channel);
        if (resolved === null) continue;
        hasPrelude = true;
        if (resolved.bank !== undefined) {
          events.push(
            voiceEvent(
              preludeFrame,
              STATUS_CONTROL_CHANGE,
              channel,
              CC_BANK_SELECT_MSB,
              resolved.bank >> 7,
            ),
          );
          events.push(
            voiceEvent(
              preludeFrame,
              STATUS_CONTROL_CHANGE,
              channel,
              CC_BANK_SELECT_LSB,
              resolved.bank & 0x7f,
            ),
          );
        }
        events.push(
          voiceEvent(preludeFrame, STATUS_PROGRAM_CHANGE, channel, resolved.program ?? 0, 0),
        );
      }
    }
    // A frame-0 prelude has no earlier sample to occupy, so the clip's own
    // frame-0 note events move to frame 1 to keep the prelude strictly first
    // under the engine's unstable same-frame sort.
    const shiftFrameZero = hasPrelude && startSample === 0;

    for (const entry of notes) {
      const note = entry.note;
      const channel = clamp(note.channel ?? 0, 0, 15);
      const velocity = clamp(Math.round(note.velocity * clip.gain), 1, 127);
      let onFrame = ppqToSamples(tempoMap, entry.timelineStartPpq, sampleRate);
      if (shiftFrameZero && onFrame === 0) onFrame = 1;
      // One sample before the nominal end keeps this note-off strictly before
      // a same-pitch note-on of the next note (legato) despite the engine's
      // unstable same-frame sort; the floor keeps the note at least 1 sample.
      const offFrame = Math.max(
        onFrame + 1,
        ppqToSamples(tempoMap, entry.timelineStartPpq + entry.durationPpq, sampleRate) - 1,
      );
      events.push(voiceEvent(onFrame, STATUS_NOTE_ON, channel, note.pitch, velocity));
      events.push(
        voiceEvent(
          offFrame,
          STATUS_NOTE_OFF,
          channel,
          note.pitch,
          clamp(note.offVelocity ?? 0, 0, 127),
        ),
      );
    }

    // Expression lanes emit every breakpoint plus generated points for
    // ramped segments. Points are clip-window relative; out-of-window points
    // are dropped.
    for (const lane of ccLanes) {
      const channel = clamp(lane.channel, 0, 15);
      const controller = clamp(lane.controller, 0, 127);
      for (const repeatOffset of repeatOffsets) {
        for (const point of expandExpressionPoints(lane.points, windowPpq, 127)) {
          if (looping && point.ppq >= windowPpq) continue;
          const localPpq = repeatOffset + point.ppq;
          if (localPpq > clip.lengthPpq) continue;
          let frame = ppqToSamples(tempoMap, clip.startPpq + localPpq, sampleRate);
          if (shiftFrameZero && frame === 0) frame = 1;
          events.push(
            voiceEvent(
              frame,
              STATUS_CONTROL_CHANGE,
              channel,
              controller,
              clamp(point.value, 0, 127),
            ),
          );
        }
      }
    }

    // Pitch bend is a 14-bit value encoded LSB first in MIDI 1.0.
    for (const lane of pitchBendLanes) {
      const channel = clamp(lane.channel, 0, 15);
      for (const repeatOffset of repeatOffsets) {
        for (const point of expandExpressionPoints(lane.points, windowPpq, MIDI_PITCH_BEND_MAX)) {
          if (looping && point.ppq >= windowPpq) continue;
          const localPpq = repeatOffset + point.ppq;
          if (localPpq > clip.lengthPpq) continue;
          let frame = ppqToSamples(tempoMap, clip.startPpq + localPpq, sampleRate);
          if (shiftFrameZero && frame === 0) frame = 1;
          const value = clamp(Math.round(point.value), 0, 16383);
          events.push(voiceEvent(frame, STATUS_PITCH_BEND, channel, value & 0x7f, value >> 7));
        }
      }
    }

    for (const lane of programChangeLanes) {
      const channel = clamp(lane.channel, 0, 15);
      for (const repeatOffset of repeatOffsets) {
        for (const point of lane.points) {
          if (!Number.isFinite(point.ppq) || point.ppq < 0 || point.ppq > windowPpq) continue;
          if (looping && point.ppq >= windowPpq) continue;
          const localPpq = repeatOffset + point.ppq;
          if (localPpq > clip.lengthPpq) continue;
          let frame = ppqToSamples(tempoMap, clip.startPpq + localPpq, sampleRate);
          if (shiftFrameZero && frame === 0) frame = 1;
          events.push(
            voiceEvent(
              frame,
              STATUS_PROGRAM_CHANGE,
              channel,
              clamp(Math.round(point.program), 0, 127),
              0,
            ),
          );
        }
      }
    }

    // Aftertouch lanes preserve imported performance pressure data. Channel
    // pressure has one 7-bit data byte; poly pressure carries note + pressure.
    for (const lane of channelPressureLanes) {
      const channel = clamp(lane.channel, 0, 15);
      for (const repeatOffset of repeatOffsets) {
        for (const point of expandExpressionPoints(lane.points, windowPpq, 127)) {
          if (looping && point.ppq >= windowPpq) continue;
          const localPpq = repeatOffset + point.ppq;
          if (localPpq > clip.lengthPpq) continue;
          let frame = ppqToSamples(tempoMap, clip.startPpq + localPpq, sampleRate);
          if (shiftFrameZero && frame === 0) frame = 1;
          events.push(
            voiceEvent(frame, STATUS_CHANNEL_PRESSURE, channel, clamp(point.value, 0, 127), 0),
          );
        }
      }
    }
    for (const lane of polyPressureLanes) {
      const channel = clamp(lane.channel, 0, 15);
      const pitch = clamp(lane.pitch, 0, 127);
      for (const repeatOffset of repeatOffsets) {
        for (const point of expandExpressionPoints(lane.points, windowPpq, 127)) {
          if (looping && point.ppq >= windowPpq) continue;
          const localPpq = repeatOffset + point.ppq;
          if (localPpq > clip.lengthPpq) continue;
          let frame = ppqToSamples(tempoMap, clip.startPpq + localPpq, sampleRate);
          if (shiftFrameZero && frame === 0) frame = 1;
          events.push(
            voiceEvent(frame, STATUS_POLY_PRESSURE, channel, pitch, clamp(point.value, 0, 127)),
          );
        }
      }
    }

    events.sort((a, b) => a.renderFrame - b.renderFrame);
    schedules.push({
      id: clip.id,
      trackId: clip.trackId,
      destinationId: midiDestinationForTrack(track),
      startSample,
      startPpq: clip.startPpq,
      lengthSamples,
      events,
    });
  }

  schedules.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return schedules;
}

/** Options for {@link createMidiSync}. */
export interface MidiSyncOptions {
  /** Loads SoundFont bytes by font id; defaults to the OPFS font store's loadFont. */
  loadFont?: (fontId: string) => Promise<Uint8Array>;
  /** Maps a synth preset name to a known catalog name; defaults to identity. */
  resolvePreset?: (preset: string) => string;
}

/** Mirrors store MIDI clips and track instruments onto a running engine. */
export interface MidiSync {
  /**
   * Diffs instruments and the compiled clip set against what was last sent.
   * Instruments are sent first, then the clips (one replace-all setMidiClips
   * when the compiled schedules changed). Errors propagate to the caller.
   *
   * @param tracks Project tracks in store order.
   * @param clips Project clips.
   * @param tempoSegments Project tempo segments the clip frames are baked
   *   through (empty falls back to 120 BPM).
   */
  sync(
    tracks: ReadonlyArray<EditorTrack>,
    clips: ReadonlyArray<EditorClip>,
    tempoSegments: ReadonlyArray<TempoSegment>,
    projectExternalMidi?: ExternalMidiInstrument | null,
    automationLanes?: ReadonlyArray<AutomationLaneState>,
    automationPpq?: number,
  ): Promise<void>;
  /** Number of MIDI clip schedules in the last setMidiClips call (0 before any). */
  scheduledClipCount(): number;
  /** Missing/unreadable SoundFonts encountered during the latest sync. */
  mediaIssues?(): readonly MediaCompletenessIssue[];
}

/**
 * Creates a MIDI sync bound to one engine handle. Create a fresh instance per
 * engine start: all sent-state memory (instruments, loaded SoundFont,
 * compiled clip set) restarts with the engine.
 *
 * @param handle Running engine handle from createEngine.
 * @param options Optional font loader and preset resolver overrides.
 * @returns The sync facade.
 */
export function createMidiSync(handle: EngineHandle, options: MidiSyncOptions = {}): MidiSync {
  const loadFontBytes = options.loadFont ?? loadFont;
  const resolvePreset = options.resolvePreset ?? ((preset: string) => preset);
  const lastInstrumentKeyByDestination = new Map<number, string>();
  // Last MIDI-FX JSON sent per MIDI destination ('' = none); diffs install/bypass the
  // engine's live non-destructive MIDI-FX insert without re-sending clips.
  const lastMidiFxKeyByDestination = new Map<number, string>();
  let loadedFontId: string | undefined;
  let lastClipsKey: string | undefined;
  let lastClockEnabled: boolean | undefined;
  let clipCount = 0;
  let currentMediaIssues: MediaCompletenessIssue[] = [];

  function midiDestinationAssignments(
    tracks: ReadonlyArray<EditorTrack>,
    projectExternalMidi?: ExternalMidiInstrument | null,
  ): Map<number, number> {
    const destinationByTrack = new Map<number, number>();
    const destinationByInstrument = new Map<string, number>();
    const internalDestinations: number[] = [];
    for (const track of tracks) {
      if (track.kind !== 'midi' || track.frozen !== undefined) continue;
      const instrument = effectiveTrackInstrument(track, projectExternalMidi);
      if (instrument.kind === 'external-midi') {
        destinationByTrack.set(track.id, track.id);
        continue;
      }
      const key = instrumentDedupeKey(instrument);
      if (internalDestinations.length < MAX_INTERNAL_MIDI_INSTRUMENTS) {
        destinationByTrack.set(track.id, track.id);
        if (!destinationByInstrument.has(key)) destinationByInstrument.set(key, track.id);
        internalDestinations.push(track.id);
      } else if (destinationByInstrument.has(key)) {
        destinationByTrack.set(track.id, destinationByInstrument.get(key) as number);
      } else {
        const fallbackDestination = internalDestinations[0];
        destinationByTrack.set(track.id, fallbackDestination);
        console.warn(
          `MIDI sync: internal instrument limit (${MAX_INTERNAL_MIDI_INSTRUMENTS}) reached; routing track ${track.id} (${track.name}) through destination ${fallbackDestination}.`,
        );
      }
    }
    return destinationByTrack;
  }

  function bindInstrument(
    track: EditorTrack,
    destinationId: number,
    instrument: TrackInstrument,
    soundFontReady = true,
  ): void {
    try {
      handle.engine.setMidiDestinationExternal(destinationId, instrument.kind === 'external-midi');
      if (instrument.kind === 'synth-preset') {
        handle.engine.setSynthInstrument(destinationId, resolvePreset(instrument.preset));
      } else if (instrument.kind === 'synth-patch') {
        handle.engine.setSynthInstrument(
          destinationId,
          instrument.patch as Record<string, unknown>,
        );
      } else if (instrument.kind === 'sf2' && soundFontReady) {
        handle.engine.setSf2Instrument(destinationId, sf2PlaybackConfig(instrument));
      } else if (instrument.kind === 'sf2') {
        handle.engine.setSynthInstrument(destinationId, resolvePreset(DEFAULT_SYNTH_PRESET));
      }
    } catch (err) {
      if (instrument.kind === 'external-midi') {
        throw new Error(
          `Failed to route external MIDI for track ${track.id} (${track.name}) destination ${destinationId}: ${instrumentDedupeKey(
            instrument,
          )}`,
          { cause: err },
        );
      }
      try {
        handle.engine.setMidiDestinationExternal(destinationId, false);
        handle.engine.setSynthInstrument(destinationId, resolvePreset(DEFAULT_SYNTH_PRESET));
        console.warn(
          `MIDI sync: ${instrumentDedupeKey(instrument)} failed to bind on track ${track.id} (${
            track.name
          }) destination ${destinationId}; fell back to ${DEFAULT_SYNTH_PRESET}.`,
          err,
        );
      } catch (fallbackErr) {
        throw new Error(
          `Failed to bind MIDI instrument for track ${track.id} (${track.name}) destination ${destinationId}: ${instrumentDedupeKey(
            instrument,
          )}`,
          { cause: fallbackErr },
        );
      }
    }
  }

  function instrumentWithAutomation(
    track: EditorTrack,
    instrument: TrackInstrument,
    automationLanes?: ReadonlyArray<AutomationLaneState>,
    automationPpq = 0,
  ): TrackInstrument {
    if (instrument.kind !== 'synth-patch' || automationLanes === undefined) return instrument;
    const ppq = Number.isFinite(automationPpq) ? Math.max(0, automationPpq) : 0;
    let patch: Record<string, unknown> | undefined;
    for (const lane of automationLanes) {
      if (lane.target !== track.id || !lane.enabled) continue;
      const ref = parseInstrumentAutomationParam(lane.param);
      if (!ref) continue;
      const points = sanitizeAutomationPoints(lane.param, lane.points);
      if (points.length === 0) continue;
      patch ??= { ...instrument.patch };
      patch[ref.paramName] = evaluateAutomationValue(points, ppq);
    }
    return patch === undefined ? instrument : { kind: 'synth-patch', patch };
  }

  const sync = async (
    tracks: ReadonlyArray<EditorTrack>,
    clips: ReadonlyArray<EditorClip>,
    tempoSegments: ReadonlyArray<TempoSegment>,
    projectExternalMidi?: ExternalMidiInstrument | null,
    automationLanes?: ReadonlyArray<AutomationLaneState>,
    automationPpq?: number,
  ): Promise<void> => {
    const sampleRate = handle.ctx.sampleRate;
    currentMediaIssues = [];
    const destinationByTrack = midiDestinationAssignments(tracks, projectExternalMidi);

    // The engine holds a single global SoundFont: with several distinct
    // fonts requested the last one loaded wins, so make that audible. Frozen
    // tracks play their baked render, not the synth, so they neither need a
    // font nor count toward the single-font contention.
    const soundFontUsage = collectActiveSoundFontUsage(tracks, (track) =>
      effectiveTrackInstrument(track, projectExternalMidi),
    );
    if (hasSoundFontSlotConflict(soundFontUsage)) {
      console.warn(
        `MIDI sync: ${soundFontUsage.fontIds.length} distinct SoundFonts requested, but the engine holds a single global SoundFont — the last track's font wins.`,
      );
    }
    // Load the global SoundFont once, deterministically (the last SF2 track in
    // track order), so live playback matches the offline render regardless of
    // which track's instrument was edited most recently.
    let soundFontReady = true;
    if (
      soundFontUsage.winningFontId !== undefined &&
      soundFontUsage.winningFontId !== loadedFontId
    ) {
      try {
        const bytes = await loadFontBytes(soundFontUsage.winningFontId);
        handle.engine.loadSoundFont(bytes);
        loadedFontId = soundFontUsage.winningFontId;
      } catch (error) {
        soundFontReady = false;
        const fontId = soundFontUsage.winningFontId;
        for (const track of tracks) {
          if (track.kind !== 'midi' || track.frozen !== undefined) continue;
          const instrument = effectiveTrackInstrument(track, projectExternalMidi);
          if (instrument.kind !== 'sf2' || instrument.fontId !== fontId) continue;
          currentMediaIssues.push({
            kind: 'soundfont',
            mediaId: fontId,
            role: 'instrument',
            reason: 'unreadable',
            trackId: track.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        console.warn(
          `MIDI sync: SoundFont ${fontId} could not be loaded; affected tracks use ${DEFAULT_SYNTH_PRESET}.`,
          error,
        );
      }
    }

    for (const track of tracks) {
      if (track.kind !== 'midi') continue;
      // A frozen track plays from its baked asset; loading its instrument (and,
      // for SF2, the global SoundFont) would thrash the single font slot.
      if (track.frozen !== undefined) continue;
      const instrument = instrumentWithAutomation(
        track,
        effectiveTrackInstrument(track, projectExternalMidi),
        automationLanes,
        automationPpq,
      );
      const instrumentKey = JSON.stringify({
        mode: track.externalMidiMode ?? 'track',
        instrument,
        ...(instrument.kind === 'sf2' ? { soundFontReady } : {}),
      });
      const destinationId = destinationByTrack.get(track.id) ?? track.id;
      // When several imported tracks share a destination, bind that destination
      // only once to the first track's instrument.
      if (lastInstrumentKeyByDestination.get(destinationId) === instrumentKey) continue;
      if (lastInstrumentKeyByDestination.has(destinationId) && destinationId !== track.id) continue;
      bindInstrument(track, destinationId, instrument, soundFontReady);
      // external-midi: no internal instrument is bound; the engine routes the
      // track's MIDI to the external output queue (drained by useWebMidiOutput).
      lastInstrumentKeyByDestination.set(destinationId, instrumentKey);
    }

    // Mirror each track's live, non-destructive MIDI-FX insert. The engine
    // transforms the destination's MIDI before synthesis, so a change installs
    // or bypasses the insert without touching the scheduled clips. Frozen tracks
    // play their baked asset (no live MIDI), so they neither install nor need to
    // bypass an insert.
    for (const track of tracks) {
      if (track.kind !== 'midi' || track.frozen !== undefined) continue;
      const destinationId = destinationByTrack.get(track.id) ?? track.id;
      const midiFxKey = track.midiFx !== undefined ? (midiFxConfigJson(track.midiFx) ?? '') : '';
      if (lastMidiFxKeyByDestination.get(destinationId) === midiFxKey) continue;
      if (midiFxKey === '') {
        handle.engine.clearMidiFx(destinationId);
      } else {
        handle.engine.setMidiFx(destinationId, midiFxKey);
      }
      lastMidiFxKeyByDestination.set(destinationId, midiFxKey);
    }

    // Forward MIDI clock + transport to external ports only when some external
    // track opts in, so internal-only projects never emit clock traffic.
    const clockEnabled = tracks.some((track) => {
      if (track.kind !== 'midi' || track.frozen !== undefined) return false;
      const instrument = effectiveTrackInstrument(track, projectExternalMidi);
      return instrument.kind === 'external-midi' && instrument.sendClock === true;
    });
    if (clockEnabled !== lastClockEnabled) {
      handle.engine.setExternalMidiClockEnabled(clockEnabled);
      lastClockEnabled = clockEnabled;
    }

    const schedules = buildMidiClipSchedules(
      tracks,
      clips,
      tempoSegments,
      sampleRate,
      projectExternalMidi,
      (track) => destinationByTrack.get(track.id) ?? track.id,
    );
    const clipsKey = JSON.stringify(schedules);
    if (clipsKey !== lastClipsKey) {
      handle.engine.setMidiClips(schedules);
      lastClipsKey = clipsKey;
      clipCount = schedules.length;
    }
  };

  return {
    sync,
    scheduledClipCount: () => clipCount,
    mediaIssues: () => currentMediaIssues.map((issue) => ({ ...issue })),
  };
}
