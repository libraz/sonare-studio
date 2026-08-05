/**
 * Reactive MIDI recording: captures live Web MIDI input against the transport
 * timeline and turns a take into a MIDI clip on the armed track.
 *
 * Unlike audio recording (src/composables/useRecording.ts), MIDI capture needs
 * no microphone or engine recorder: note-on/note-off events are timestamped at
 * the current transport position as they arrive, and stopRecord() pairs them
 * into notes (closing any keys still held at the punch-out), applies optional
 * input quantize, and commits one undoable clip. Stopping the transport also
 * ends an in-flight take.
 */

import { getCurrentScope, onScopeDispose, type Ref, ref, watch } from 'vue';
import { describeError } from '@/lib/errors';
import { addRecordedMidiClip as addRecordedMidiClipCommand } from '@/project/commands';
import { snapLoopRecordingStartPpq } from '@/project/loop-recording';
import {
  sanitizeCcPoints,
  sanitizePitchBendPoints,
  sanitizePressurePoints,
} from '@/project/midi-cc';
import type { NoteBoundaryEvent } from '@/project/midi-events';
import {
  finalizeRecording,
  foldRecordedNotesIntoLoop,
  lastCompleteLoopPassStartPpq,
  lastLoopPassWithEventsStartPpq,
  loopPassStartsWithEvents,
  selectLastCompleteLoopPassEvents,
  selectLastCompleteLoopPassNotes,
} from '@/project/midi-recording';
import { useProjectStore } from '@/project/store';
import {
  type NormalizedTempoMap,
  normalizeTempoMap,
  ppqRangeSeconds,
  ppqToSeconds as ppqToSecondsMap,
  secondsToPpq as secondsToPpqMap,
} from '@/project/tempo-map';
import { countInStartPpq } from '@/project/time-signature';
import type {
  ClipCcLane,
  ClipChannelPressureLane,
  ClipPitchBendLane,
  ClipPolyPressureLane,
  ClipProgramChangeLane,
  MidiClipTake,
} from '@/project/types';
import type { UseTransportReturn } from './useTransport';

/** How a MIDI performance recorded through a transport cycle is committed. */
export type MidiCycleRecordMode = 'takes' | 'overdub' | 'keep-last' | 'overwrite';

/** A note-on/note-off received from a MIDI input (channel-voice, 7-bit). */
export interface CapturedNoteEvent {
  /** MIDI note number (0-127). */
  pitch: number;
  /** Velocity (note-on velocity, or release velocity for note-offs). */
  velocity: number;
  /** MIDI channel (0-15). */
  channel: number;
  /** Input event timestamp in milliseconds, when provided by Web MIDI. */
  timeStampMs?: number;
}

export interface CapturedControlChangeEvent {
  controller: number;
  value: number;
  channel: number;
  timeStampMs?: number;
}

export interface CapturedPitchBendEvent {
  value: number;
  channel: number;
  timeStampMs?: number;
}

export interface CapturedProgramChangeEvent {
  program: number;
  channel: number;
  timeStampMs?: number;
}

export interface CapturedChannelPressureEvent {
  value: number;
  channel: number;
  timeStampMs?: number;
}

export interface CapturedPolyPressureEvent extends CapturedChannelPressureEvent {
  pitch: number;
}

/** Injectable dependencies for {@link useMidiRecording} (tests / alternatives). */
export interface UseMidiRecordingOptions {
  /** Clip-creation command; defaults to addRecordedMidiClip from commands. */
  addRecordedMidiClip?: typeof addRecordedMidiClipCommand;
  /** High-resolution clock in milliseconds, injectable for tests. */
  now?: () => number;
}

/** Reactive MIDI recording state and actions returned by {@link useMidiRecording}. */
export interface UseMidiRecordingReturn {
  /** The armed (record-destination) MIDI track id, or null. */
  armedTrackId: Ref<number | null>;
  /** True between a successful record() and the matching stopRecord(). */
  isRecording: Ref<boolean>;
  /** True while the metronome count-in pre-roll is running. */
  isCountingIn: Ref<boolean>;
  /** Count-in length in bars applied by record() when starting from stop. */
  countInBars: Ref<number>;
  /** Last user-facing error message, or null. Cleared by the next action. */
  error: Ref<string | null>;
  /**
   * Input-quantize grid as a note-value denominator (e.g. 16 = 1/16 notes);
   * 0 disables quantizing. Applied to note starts when a take is committed.
   */
  inputQuantizeDenominator: Ref<number>;
  /** How a loop recording is committed; ignored when transport cycle is off. */
  cycleRecordMode: Ref<MidiCycleRecordMode>;
  /**
   * Arms a MIDI track as the recording destination (null disarms).
   * Non-MIDI tracks are rejected with `error` set.
   */
  arm(trackId: number | null): void;
  /** Records a note-on at the current transport position (no-op when idle). */
  captureNoteOn(event: CapturedNoteEvent): void;
  /** Records a note-off at the current transport position (no-op when idle). */
  captureNoteOff(event: CapturedNoteEvent): void;
  /** Records a CC point at the current transport position (no-op when idle). */
  captureControlChange(event: CapturedControlChangeEvent): void;
  /** Records a pitch-bend point at the current transport position (no-op when idle). */
  capturePitchBend(event: CapturedPitchBendEvent): void;
  /** Records a program-change point at the current transport position (no-op when idle). */
  captureProgramChange(event: CapturedProgramChangeEvent): void;
  /** Records a channel-pressure point at the current transport position (no-op when idle). */
  captureChannelPressure(event: CapturedChannelPressureEvent): void;
  /** Records a polyphonic key-pressure point at the current transport position (no-op when idle). */
  capturePolyPressure(event: CapturedPolyPressureEvent): void;
  /**
   * Starts recording on the armed track: starts the transport when stopped and
   * begins capturing from the punch-in position.
   *
   * @param startAtPpq Explicit punch-in position; when omitted the current
   *   playhead is used.
   * @returns True when recording started; false with `error` set otherwise.
   */
  record(startAtPpq?: number): boolean;
  /**
   * Stops capturing, pairs the take into notes and adds a MIDI clip at the
   * recorded position. The transport keeps rolling.
   *
   * @returns The new clip id, or null when nothing usable was captured.
   */
  stopRecord(): number | null;
  /** Releases watchers and buffers. Called automatically on scope dispose. */
  dispose(): void;
}

/**
 * Vue composable wiring live MIDI input into the project as recorded clips.
 *
 * @param transport The transport composable driving playback.
 * @param options Injectable clip-creation command (tests).
 * @returns Reactive MIDI recording state and actions.
 */
export function useMidiRecording(
  transport: UseTransportReturn,
  options: UseMidiRecordingOptions = {},
): UseMidiRecordingReturn {
  const store = useProjectStore();
  const addClip = options.addRecordedMidiClip ?? addRecordedMidiClipCommand;
  const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());

  const armedTrackId = ref<number | null>(null);
  const isRecording = ref(false);
  const isCountingIn = ref(false);
  const countInBars = ref(0);
  const error = ref<string | null>(null);
  const inputQuantizeDenominator = ref(0);
  const cycleRecordMode = ref<MidiCycleRecordMode>('takes');

  let buffer: NoteBoundaryEvent[] = [];
  let ccBuffer: Array<CapturedControlChangeEvent & { ppq: number }> = [];
  let pitchBendBuffer: Array<CapturedPitchBendEvent & { ppq: number }> = [];
  let programChangeBuffer: Array<CapturedProgramChangeEvent & { ppq: number }> = [];
  let channelPressureBuffer: Array<CapturedChannelPressureEvent & { ppq: number }> = [];
  let polyPressureBuffer: Array<CapturedPolyPressureEvent & { ppq: number }> = [];
  let held = new Map<string, CapturedNoteEvent>();
  // Notes pressed during a count-in are tracked separately. They are not
  // recorded unless the key is still held when the punch-in boundary is
  // reached, in which case an explicit note-on is anchored at the boundary.
  let preRollHeld = new Map<string, CapturedNoteEvent>();
  let recordingStartPpq = 0;
  let recordingCounter = 0;
  let countInTimer: ReturnType<typeof setTimeout> | null = null;
  let restoreMetronomeOff = false;
  let recordingLoopLengthPpq = 0;
  let recordingWrapOffsetPpq = 0;
  let lastCapturePpq = 0;
  let recordingTempoMap: NormalizedTempoMap | null = null;
  let recordingStartSeconds = 0;
  let recordingStartTimestampMs: number | null = null;
  let lastCaptureTimestampMs: number | null = null;
  let recordingLoop: { startPpq: number; endPpq: number } | null = null;

  function finishCountIn(): void {
    if (countInTimer !== null) {
      globalThis.clearTimeout(countInTimer);
      countInTimer = null;
    }
    isCountingIn.value = false;
    if (restoreMetronomeOff) {
      transport.toggleMetronome(false);
      restoreMetronomeOff = false;
    }
  }

  function currentRecordingPpq(timeStampMs?: number): number {
    if (
      timeStampMs !== undefined &&
      Number.isFinite(timeStampMs) &&
      recordingTempoMap !== null &&
      recordingStartTimestampMs !== null
    ) {
      const elapsedSeconds = Math.max(0, (timeStampMs - recordingStartTimestampMs) / 1000);
      let ppq: number;
      if (recordingLoop !== null) {
        const loopStartSeconds = ppqToSecondsMap(recordingTempoMap, recordingLoop.startPpq);
        const loopEndSeconds = ppqToSecondsMap(recordingTempoMap, recordingLoop.endPpq);
        const loopDurationSeconds = loopEndSeconds - loopStartSeconds;
        const loopLengthPpq = recordingLoop.endPpq - recordingLoop.startPpq;
        if (loopDurationSeconds > 0 && loopLengthPpq > 0) {
          const pass = Math.floor(elapsedSeconds / loopDurationSeconds);
          const loopElapsedSeconds = elapsedSeconds - pass * loopDurationSeconds;
          const loopPpq =
            secondsToPpqMap(recordingTempoMap, loopStartSeconds + loopElapsedSeconds) -
            recordingLoop.startPpq;
          ppq = recordingLoop.startPpq + pass * loopLengthPpq + loopPpq;
        } else {
          ppq = recordingStartPpq;
        }
      } else {
        const seconds = recordingStartSeconds + elapsedSeconds;
        ppq = secondsToPpqMap(recordingTempoMap, seconds);
      }
      if (ppq > lastCapturePpq) lastCapturePpq = ppq;
      return ppq;
    }
    const raw = Math.max(0, transport.audiblePositionPpq.value);
    if (raw < recordingStartPpq - 1e-9) return raw;
    let ppq = raw + recordingWrapOffsetPpq;
    if (recordingLoopLengthPpq > 0 && ppq < lastCapturePpq - 1e-9) {
      recordingWrapOffsetPpq += recordingLoopLengthPpq;
      ppq = raw + recordingWrapOffsetPpq;
    }
    if (ppq > lastCapturePpq) lastCapturePpq = ppq;
    return ppq;
  }

  function markTimestamp(timeStampMs: number | undefined): void {
    if (timeStampMs !== undefined && Number.isFinite(timeStampMs)) {
      lastCaptureTimestampMs = timeStampMs;
    }
  }

  function eventIsBeforePunch(timeStampMs: number | undefined): boolean {
    if (
      timeStampMs !== undefined &&
      Number.isFinite(timeStampMs) &&
      recordingStartTimestampMs !== null
    ) {
      return timeStampMs < recordingStartTimestampMs - 1e-6;
    }
    return transport.audiblePositionPpq.value < recordingStartPpq - 1e-9;
  }

  function activatePreRollHeld(key?: string): void {
    const entries: Array<[string, CapturedNoteEvent]> = key
      ? preRollHeld.has(key)
        ? [[key, preRollHeld.get(key) as CapturedNoteEvent]]
        : []
      : [...preRollHeld.entries()];
    for (const [noteKey, maybeEvent] of entries) {
      buffer.push({
        ppq: recordingStartPpq,
        kind: 'on',
        pitch: maybeEvent.pitch,
        velocity: maybeEvent.velocity,
        channel: maybeEvent.channel,
      });
      held.set(noteKey, maybeEvent);
      preRollHeld.delete(noteKey);
    }
  }

  function expressionPointPpq(timeStampMs: number | undefined): number {
    const ppq = currentRecordingPpq(timeStampMs);
    markTimestamp(timeStampMs);
    return ppq;
  }

  const arm = (trackId: number | null): void => {
    error.value = null;
    if (isRecording.value) {
      error.value = 'Cannot change the armed track while recording.';
      return;
    }
    if (trackId === null) {
      armedTrackId.value = null;
      return;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (!track) {
      error.value = `Unknown track id: ${trackId}`;
      return;
    }
    if (track.kind !== 'midi') {
      error.value = 'MIDI recording requires a MIDI track.';
      return;
    }
    armedTrackId.value = trackId;
  };

  const captureNoteOn = (event: CapturedNoteEvent): void => {
    if (!isRecording.value) return;
    const key = `${event.channel}:${event.pitch}`;
    if (eventIsBeforePunch(event.timeStampMs)) {
      preRollHeld.set(key, event);
      return;
    }
    const ppq = currentRecordingPpq(event.timeStampMs);
    markTimestamp(event.timeStampMs);
    // A repeated note-on at/after punch-in closes a key that was already held
    // through the boundary before starting the new articulation.
    if (preRollHeld.has(key)) {
      activatePreRollHeld(key);
      buffer.push({
        ppq,
        kind: 'off',
        pitch: event.pitch,
        velocity: 0,
        channel: event.channel,
      });
    }
    buffer.push({
      ppq,
      kind: 'on',
      pitch: event.pitch,
      velocity: event.velocity,
      channel: event.channel,
    });
    held.set(key, event);
  };

  const captureNoteOff = (event: CapturedNoteEvent): void => {
    if (!isRecording.value) return;
    const key = `${event.channel}:${event.pitch}`;
    if (eventIsBeforePunch(event.timeStampMs)) {
      preRollHeld.delete(key);
      return;
    }
    const ppq = currentRecordingPpq(event.timeStampMs);
    markTimestamp(event.timeStampMs);
    activatePreRollHeld(key);
    buffer.push({
      ppq,
      kind: 'off',
      pitch: event.pitch,
      velocity: event.velocity,
      channel: event.channel,
    });
    held.delete(key);
  };

  const captureControlChange = (event: CapturedControlChangeEvent): void => {
    if (!isRecording.value || eventIsBeforePunch(event.timeStampMs)) return;
    ccBuffer.push({ ...event, ppq: expressionPointPpq(event.timeStampMs) });
  };

  const capturePitchBend = (event: CapturedPitchBendEvent): void => {
    if (!isRecording.value || eventIsBeforePunch(event.timeStampMs)) return;
    pitchBendBuffer.push({ ...event, ppq: expressionPointPpq(event.timeStampMs) });
  };

  const captureProgramChange = (event: CapturedProgramChangeEvent): void => {
    if (!isRecording.value || eventIsBeforePunch(event.timeStampMs)) return;
    programChangeBuffer.push({ ...event, ppq: expressionPointPpq(event.timeStampMs) });
  };

  const captureChannelPressure = (event: CapturedChannelPressureEvent): void => {
    if (!isRecording.value || eventIsBeforePunch(event.timeStampMs)) return;
    channelPressureBuffer.push({ ...event, ppq: expressionPointPpq(event.timeStampMs) });
  };

  const capturePolyPressure = (event: CapturedPolyPressureEvent): void => {
    if (!isRecording.value || eventIsBeforePunch(event.timeStampMs)) return;
    polyPressureBuffer.push({ ...event, ppq: expressionPointPpq(event.timeStampMs) });
  };

  function relativeExpressionPpq(
    ppq: number,
    startPpq: number,
    loopLengthPpq: number,
  ): number | null {
    if (!Number.isFinite(ppq)) return null;
    const relative = ppq - startPpq;
    if (relative < -1e-9) return null;
    if (loopLengthPpq > 0) {
      return ((relative % loopLengthPpq) + loopLengthPpq) % loopLengthPpq;
    }
    return Math.max(0, relative);
  }

  function expressionLengthPpq(
    capturedExpression: ReadonlyArray<{ ppq: number }>,
    startPpq: number,
    stopPpq: number,
    loopLengthPpq: number,
    finalizedLengthPpq: number,
  ): number {
    if (loopLengthPpq > 0) return loopLengthPpq;
    const lastExpressionPpq = capturedExpression.reduce(
      (max, event) => (Number.isFinite(event.ppq) ? Math.max(max, event.ppq) : max),
      startPpq,
    );
    return Math.max(finalizedLengthPpq, stopPpq - startPpq, lastExpressionPpq - startPpq);
  }

  function buildCcLanes(
    events: ReadonlyArray<CapturedControlChangeEvent & { ppq: number }>,
    startPpq: number,
    loopLengthPpq: number,
    lengthPpq: number,
  ): ClipCcLane[] {
    const byLane = new Map<string, ClipCcLane>();
    for (const event of events) {
      const ppq = relativeExpressionPpq(event.ppq, startPpq, loopLengthPpq);
      if (ppq === null) continue;
      const key = `${event.controller}:${event.channel}`;
      const lane =
        byLane.get(key) ??
        ({
          controller: event.controller,
          channel: event.channel,
          points: [],
        } satisfies ClipCcLane);
      lane.points.push({ ppq, value: event.value });
      byLane.set(key, lane);
    }
    return [...byLane.values()]
      .map((lane) => ({ ...lane, points: sanitizeCcPoints(lane.points, lengthPpq) }))
      .filter((lane) => lane.points.length > 0);
  }

  function buildPitchBendLanes(
    events: ReadonlyArray<CapturedPitchBendEvent & { ppq: number }>,
    startPpq: number,
    loopLengthPpq: number,
    lengthPpq: number,
  ): ClipPitchBendLane[] {
    const byLane = new Map<number, ClipPitchBendLane>();
    for (const event of events) {
      const ppq = relativeExpressionPpq(event.ppq, startPpq, loopLengthPpq);
      if (ppq === null) continue;
      const lane =
        byLane.get(event.channel) ??
        ({
          channel: event.channel,
          points: [],
        } satisfies ClipPitchBendLane);
      lane.points.push({ ppq, value: event.value });
      byLane.set(event.channel, lane);
    }
    return [...byLane.values()]
      .map((lane) => ({ ...lane, points: sanitizePitchBendPoints(lane.points, lengthPpq) }))
      .filter((lane) => lane.points.length > 0);
  }

  function buildChannelPressureLanes(
    events: ReadonlyArray<CapturedChannelPressureEvent & { ppq: number }>,
    startPpq: number,
    loopLengthPpq: number,
    lengthPpq: number,
  ): ClipChannelPressureLane[] {
    const byLane = new Map<number, ClipChannelPressureLane>();
    for (const event of events) {
      const ppq = relativeExpressionPpq(event.ppq, startPpq, loopLengthPpq);
      if (ppq === null) continue;
      const lane =
        byLane.get(event.channel) ??
        ({
          channel: event.channel,
          points: [],
        } satisfies ClipChannelPressureLane);
      lane.points.push({ ppq, value: event.value });
      byLane.set(event.channel, lane);
    }
    return [...byLane.values()]
      .map((lane) => ({ ...lane, points: sanitizePressurePoints(lane.points, lengthPpq) }))
      .filter((lane) => lane.points.length > 0);
  }

  function buildProgramChangeLanes(
    events: ReadonlyArray<CapturedProgramChangeEvent & { ppq: number }>,
    startPpq: number,
    loopLengthPpq: number,
    lengthPpq: number,
  ): ClipProgramChangeLane[] {
    const byLane = new Map<number, ClipProgramChangeLane>();
    for (const event of events) {
      const ppq = relativeExpressionPpq(event.ppq, startPpq, loopLengthPpq);
      if (ppq === null) continue;
      const lane =
        byLane.get(event.channel) ??
        ({
          channel: event.channel,
          points: [],
        } satisfies ClipProgramChangeLane);
      lane.points.push({ ppq, program: event.program });
      byLane.set(event.channel, lane);
    }
    return [...byLane.values()]
      .map((lane) => ({
        ...lane,
        points: lane.points
          .map((point) => ({ ppq: point.ppq, program: Math.round(point.program) }))
          .filter(
            (point) =>
              Number.isFinite(point.ppq) &&
              point.ppq >= 0 &&
              point.ppq <= lengthPpq &&
              Number.isInteger(point.program) &&
              point.program >= 0 &&
              point.program <= 127,
          )
          .sort((a, b) => a.ppq - b.ppq),
      }))
      .filter((lane) => lane.points.length > 0);
  }

  function buildPolyPressureLanes(
    events: ReadonlyArray<CapturedPolyPressureEvent & { ppq: number }>,
    startPpq: number,
    loopLengthPpq: number,
    lengthPpq: number,
  ): ClipPolyPressureLane[] {
    const byLane = new Map<string, ClipPolyPressureLane>();
    for (const event of events) {
      const ppq = relativeExpressionPpq(event.ppq, startPpq, loopLengthPpq);
      if (ppq === null) continue;
      const key = `${event.channel}:${event.pitch}`;
      const lane =
        byLane.get(key) ??
        ({
          channel: event.channel,
          pitch: event.pitch,
          points: [],
        } satisfies ClipPolyPressureLane);
      lane.points.push({ ppq, value: event.value });
      byLane.set(key, lane);
    }
    return [...byLane.values()]
      .map((lane) => ({ ...lane, points: sanitizePressurePoints(lane.points, lengthPpq) }))
      .filter((lane) => lane.points.length > 0);
  }

  const record = (startAtPpq?: number): boolean => {
    error.value = null;
    if (isRecording.value) return false;
    const trackId = armedTrackId.value;
    if (trackId === null) {
      error.value = 'Arm a MIDI track before recording.';
      return false;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (track?.kind !== 'midi') {
      error.value = 'MIDI recording requires a MIDI track.';
      return false;
    }
    const explicit = startAtPpq !== undefined && Number.isFinite(startAtPpq) && startAtPpq >= 0;
    const wasRolling = transport.isPlaying.value;
    let startPpq = explicit
      ? (startAtPpq as number)
      : Math.max(0, (wasRolling ? transport.audiblePositionPpq : transport.positionPpq).value);
    if (!explicit) {
      startPpq = snapLoopRecordingStartPpq(startPpq, {
        explicit: false,
        wasRolling,
        loopEnabled: transport.loopEnabled.value,
        loopStartPpq: transport.loopStartPpq.value,
        loopEndPpq: transport.loopEndPpq.value,
      });
    }
    let countInPpq = 0;
    const tempoBpm = transport.tempo.value;
    const tempoMap = normalizeTempoMap(store.tempoSegments, tempoBpm);
    if (!explicit && !wasRolling && countInBars.value > 0) {
      countInPpq = startPpq - countInStartPpq(store.timeSignatures, startPpq, countInBars.value);
    }
    if (!wasRolling) {
      if (countInPpq > 0 && !transport.metronomeEnabled.value) {
        transport.toggleMetronome(true);
        restoreMetronomeOff = true;
      }
      transport.seekPpq(startPpq - countInPpq);
      if (!transport.play()) {
        finishCountIn();
        error.value = 'The engine rejected the transport play command.';
        return false;
      }
    } else if (!explicit) {
      // Punch-in on a rolling transport: capture from where it is now.
      startPpq = Math.max(0, transport.audiblePositionPpq.value);
    }
    buffer = [];
    ccBuffer = [];
    pitchBendBuffer = [];
    programChangeBuffer = [];
    channelPressureBuffer = [];
    polyPressureBuffer = [];
    held = new Map();
    preRollHeld = new Map();
    recordingStartPpq = startPpq;
    recordingTempoMap = tempoMap;
    recordingStartSeconds = ppqToSecondsMap(recordingTempoMap, startPpq);
    const recordStartTimestampMs = now();
    const rollingPrerollMs =
      explicit && wasRolling
        ? Math.max(
            0,
            recordingStartSeconds -
              ppqToSecondsMap(recordingTempoMap, Math.max(0, transport.audiblePositionPpq.value)),
          ) * 1000
        : 0;
    const stoppedStartLatencyMs = !wasRolling ? transport.playbackLatencySeconds.value * 1000 : 0;
    recordingStartTimestampMs =
      !wasRolling && countInPpq > 0
        ? recordStartTimestampMs +
          ppqRangeSeconds(tempoMap, startPpq - countInPpq, startPpq) * 1000 +
          stoppedStartLatencyMs
        : recordStartTimestampMs + rollingPrerollMs + stoppedStartLatencyMs;
    lastCaptureTimestampMs = null;
    recordingLoopLengthPpq =
      transport.loopEnabled.value && transport.loopEndPpq.value > transport.loopStartPpq.value
        ? transport.loopEndPpq.value - transport.loopStartPpq.value
        : 0;
    recordingLoop =
      !explicit &&
      recordingLoopLengthPpq > 0 &&
      Math.abs(startPpq - transport.loopStartPpq.value) < 1e-6
        ? { startPpq: transport.loopStartPpq.value, endPpq: transport.loopEndPpq.value }
        : null;
    recordingWrapOffsetPpq = 0;
    lastCapturePpq = startPpq;
    isRecording.value = true;
    if (countInPpq > 0) {
      isCountingIn.value = true;
      countInTimer = globalThis.setTimeout(
        () => {
          countInTimer = null;
          activatePreRollHeld();
          finishCountIn();
        },
        ppqRangeSeconds(tempoMap, startPpq - countInPpq, startPpq) * 1000 + stoppedStartLatencyMs,
      );
    }
    return true;
  };

  const stopRecord = (): number | null => {
    if (!isRecording.value) return null;
    const stopTimestampMs = now();
    const effectiveStopTimestampMs = Math.max(
      stopTimestampMs,
      lastCaptureTimestampMs ?? stopTimestampMs,
    );
    if (!eventIsBeforePunch(effectiveStopTimestampMs)) activatePreRollHeld();
    finishCountIn();
    isRecording.value = false;
    const trackId = armedTrackId.value;
    const loop = recordingLoop;
    recordingLoop = null;
    const stopPpq = Math.max(
      recordingStartPpq,
      currentRecordingPpq(),
      currentRecordingPpq(effectiveStopTimestampMs),
      lastCapturePpq,
    );
    // Close any keys still held at the punch-out with an implicit release, so a
    // note sustained across the stop is recorded instead of dropped.
    for (const event of held.values()) {
      buffer.push({
        ppq: stopPpq,
        kind: 'off',
        pitch: event.pitch,
        velocity: 0,
        channel: event.channel,
      });
    }
    const captured = buffer;
    const capturedCc = ccBuffer;
    const capturedPitchBend = pitchBendBuffer;
    const capturedProgramChange = programChangeBuffer;
    const capturedChannelPressure = channelPressureBuffer;
    const capturedPolyPressure = polyPressureBuffer;
    buffer = [];
    ccBuffer = [];
    pitchBendBuffer = [];
    programChangeBuffer = [];
    channelPressureBuffer = [];
    polyPressureBuffer = [];
    held = new Map();
    preRollHeld = new Map();
    if (trackId === null) return null;
    const denominator = inputQuantizeDenominator.value;
    const gridPpq = denominator > 0 ? 4 / denominator : 0;
    const loopLengthPpq = loop ? loop.endPpq - loop.startPpq : 0;
    const finalized = finalizeRecording(captured, {
      startPpq: recordingStartPpq,
      stopPpq,
      gridPpq,
      quantizeStrength: store.quantizeStrength,
      quantizeSwingPercent: store.quantizeSwing,
    });
    try {
      recordingCounter += 1;
      const capturedLoopEvents = [
        ...captured,
        ...capturedCc,
        ...capturedPitchBend,
        ...capturedProgramChange,
        ...capturedChannelPressure,
        ...capturedPolyPressure,
      ];
      const completedLoopPassStart =
        loopLengthPpq > 0
          ? (lastLoopPassWithEventsStartPpq(capturedLoopEvents, recordingStartPpq, loopLengthPpq) ??
            lastCompleteLoopPassStartPpq(recordingStartPpq, stopPpq, loopLengthPpq))
          : null;
      let notes =
        finalized && loopLengthPpq > 0
          ? selectLastCompleteLoopPassNotes(
              finalized.notes,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : (finalized?.notes ?? []);
      const loopCc =
        completedLoopPassStart !== null
          ? selectLastCompleteLoopPassEvents(
              capturedCc,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : capturedCc;
      const loopPitchBend =
        completedLoopPassStart !== null
          ? selectLastCompleteLoopPassEvents(
              capturedPitchBend,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : capturedPitchBend;
      const loopProgramChange =
        completedLoopPassStart !== null
          ? selectLastCompleteLoopPassEvents(
              capturedProgramChange,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : capturedProgramChange;
      const loopChannelPressure =
        completedLoopPassStart !== null
          ? selectLastCompleteLoopPassEvents(
              capturedChannelPressure,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : capturedChannelPressure;
      const loopPolyPressure =
        completedLoopPassStart !== null
          ? selectLastCompleteLoopPassEvents(
              capturedPolyPressure,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : capturedPolyPressure;
      const capturedExpression = [
        ...loopCc,
        ...loopPitchBend,
        ...loopProgramChange,
        ...loopChannelPressure,
        ...loopPolyPressure,
      ];
      const expressionLoopLengthPpq = completedLoopPassStart !== null ? 0 : loopLengthPpq;
      let lengthPpq =
        completedLoopPassStart !== null
          ? loopLengthPpq
          : expressionLengthPpq(
              capturedExpression,
              recordingStartPpq,
              stopPpq,
              loopLengthPpq,
              finalized?.lengthPpq ?? 0,
            );
      if (lengthPpq <= 0) return null;
      let ccLanes = buildCcLanes(loopCc, recordingStartPpq, expressionLoopLengthPpq, lengthPpq);
      let pitchBendLanes = buildPitchBendLanes(
        loopPitchBend,
        recordingStartPpq,
        expressionLoopLengthPpq,
        lengthPpq,
      );
      let programChangeLanes = buildProgramChangeLanes(
        loopProgramChange,
        recordingStartPpq,
        expressionLoopLengthPpq,
        lengthPpq,
      );
      let channelPressureLanes = buildChannelPressureLanes(
        loopChannelPressure,
        recordingStartPpq,
        expressionLoopLengthPpq,
        lengthPpq,
      );
      let polyPressureLanes = buildPolyPressureLanes(
        loopPolyPressure,
        recordingStartPpq,
        expressionLoopLengthPpq,
        lengthPpq,
      );
      const midiTakes: MidiClipTake[] = [];
      if (loopLengthPpq > 0) {
        const passStarts = loopPassStartsWithEvents(
          capturedLoopEvents,
          recordingStartPpq,
          loopLengthPpq,
        );
        for (let takeIndex = 0; takeIndex < passStarts.length; takeIndex++) {
          const passStart = passStarts[takeIndex];
          const takeNotes = finalized
            ? selectLastCompleteLoopPassNotes(
                finalized.notes,
                recordingStartPpq,
                stopPpq,
                loopLengthPpq,
                passStart,
              )
            : [];
          const takeCc = selectLastCompleteLoopPassEvents(
            capturedCc,
            recordingStartPpq,
            stopPpq,
            loopLengthPpq,
            passStart,
          );
          const takePitchBend = selectLastCompleteLoopPassEvents(
            capturedPitchBend,
            recordingStartPpq,
            stopPpq,
            loopLengthPpq,
            passStart,
          );
          const takeProgramChange = selectLastCompleteLoopPassEvents(
            capturedProgramChange,
            recordingStartPpq,
            stopPpq,
            loopLengthPpq,
            passStart,
          );
          const takeChannelPressure = selectLastCompleteLoopPassEvents(
            capturedChannelPressure,
            recordingStartPpq,
            stopPpq,
            loopLengthPpq,
            passStart,
          );
          const takePolyPressure = selectLastCompleteLoopPassEvents(
            capturedPolyPressure,
            recordingStartPpq,
            stopPpq,
            loopLengthPpq,
            passStart,
          );
          midiTakes.push({
            name: `Take ${takeIndex + 1}`,
            notes: takeNotes,
            ...(takeCc.length > 0
              ? { ccLanes: buildCcLanes(takeCc, recordingStartPpq, 0, loopLengthPpq) }
              : {}),
            ...(takePitchBend.length > 0
              ? {
                  pitchBendLanes: buildPitchBendLanes(
                    takePitchBend,
                    recordingStartPpq,
                    0,
                    loopLengthPpq,
                  ),
                }
              : {}),
            ...(takeProgramChange.length > 0
              ? {
                  programChangeLanes: buildProgramChangeLanes(
                    takeProgramChange,
                    recordingStartPpq,
                    0,
                    loopLengthPpq,
                  ),
                }
              : {}),
            ...(takeChannelPressure.length > 0
              ? {
                  channelPressureLanes: buildChannelPressureLanes(
                    takeChannelPressure,
                    recordingStartPpq,
                    0,
                    loopLengthPpq,
                  ),
                }
              : {}),
            ...(takePolyPressure.length > 0
              ? {
                  polyPressureLanes: buildPolyPressureLanes(
                    takePolyPressure,
                    recordingStartPpq,
                    0,
                    loopLengthPpq,
                  ),
                }
              : {}),
          });
        }
      }
      if (loopLengthPpq > 0 && cycleRecordMode.value === 'overdub') {
        notes = finalized ? foldRecordedNotesIntoLoop(finalized.notes, loopLengthPpq) : [];
        lengthPpq = loopLengthPpq;
        ccLanes = buildCcLanes(capturedCc, recordingStartPpq, loopLengthPpq, lengthPpq);
        pitchBendLanes = buildPitchBendLanes(
          capturedPitchBend,
          recordingStartPpq,
          loopLengthPpq,
          lengthPpq,
        );
        programChangeLanes = buildProgramChangeLanes(
          capturedProgramChange,
          recordingStartPpq,
          loopLengthPpq,
          lengthPpq,
        );
        channelPressureLanes = buildChannelPressureLanes(
          capturedChannelPressure,
          recordingStartPpq,
          loopLengthPpq,
          lengthPpq,
        );
        polyPressureLanes = buildPolyPressureLanes(
          capturedPolyPressure,
          recordingStartPpq,
          loopLengthPpq,
          lengthPpq,
        );
      }
      if (
        notes.length === 0 &&
        ccLanes.length === 0 &&
        pitchBendLanes.length === 0 &&
        programChangeLanes.length === 0 &&
        channelPressureLanes.length === 0 &&
        polyPressureLanes.length === 0
      ) {
        return null;
      }
      return addClip({
        trackId,
        startPpq: loop?.startPpq ?? recordingStartPpq,
        lengthPpq,
        notes,
        ...(ccLanes.length > 0 ? { ccLanes } : {}),
        ...(pitchBendLanes.length > 0 ? { pitchBendLanes } : {}),
        ...(programChangeLanes.length > 0 ? { programChangeLanes } : {}),
        ...(channelPressureLanes.length > 0 ? { channelPressureLanes } : {}),
        ...(polyPressureLanes.length > 0 ? { polyPressureLanes } : {}),
        ...(cycleRecordMode.value === 'takes' && midiTakes.length > 1
          ? { midiTakes, activeMidiTakeIndex: midiTakes.length - 1 }
          : {}),
        name: `MIDI Recording ${recordingCounter}`,
      });
    } catch (err) {
      error.value = `Failed to store the recording: ${describeError(err)}`;
      return null;
    }
  };

  // Stopping the transport ends an in-flight take (the clip still lands).
  const stopWatching = watch(
    transport.isPlaying,
    (playing) => {
      if (!playing && isRecording.value) stopRecord();
    },
    { flush: 'sync' },
  );

  const dispose = (): void => {
    stopWatching();
    finishCountIn();
    isRecording.value = false;
    buffer = [];
    ccBuffer = [];
    pitchBendBuffer = [];
    programChangeBuffer = [];
    channelPressureBuffer = [];
    polyPressureBuffer = [];
    held = new Map();
    preRollHeld = new Map();
    recordingLoop = null;
    lastCaptureTimestampMs = null;
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    armedTrackId,
    isRecording,
    isCountingIn,
    countInBars,
    error,
    inputQuantizeDenominator,
    cycleRecordMode,
    arm,
    captureNoteOn,
    captureNoteOff,
    captureControlChange,
    capturePitchBend,
    captureProgramChange,
    captureChannelPressure,
    capturePolyPressure,
    record,
    stopRecord,
    dispose,
  };
}
