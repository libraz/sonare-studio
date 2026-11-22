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
import {
  type AddRecordedMidiClipInput,
  overwriteRecordedMidiClip as overwriteRecordedMidiClipCommand,
} from '@/project/command/midi-recording';
import { addRecordedMidiClip as addRecordedMidiClipCommand } from '@/project/commands';
import type {
  RecordingCycleTake,
  RecordingCycleWindow,
  RecordingStartPlan,
} from '@/project/loop-recording';
import type { NoteBoundaryEvent } from '@/project/midi-events';
import {
  buildRecordedExpressionLanes,
  expressionLengthPpq,
  finalizeRecording,
  foldRecordedNotesIntoLoop,
  lastCompleteLoopPassStartPpq,
  lastLoopPassWithEventsStartPpq,
  loopPassStartsWithEvents,
  nonEmptyLaneFields,
  type RecordedExpressionEvent,
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
import type { MidiClipTake } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';
import { createCountInController, resolveTransportRecordingPlan } from './recording-count-in';
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
  /** Cycle-overwrite command; defaults to the atomic project command. */
  overwriteRecordedMidiClip?: (input: AddRecordedMidiClipInput) => number;
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
  record(startAtPpq?: number | RecordingStartPlan): boolean;
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
  const { t } = useI18n();
  const addClip = options.addRecordedMidiClip ?? addRecordedMidiClipCommand;
  const overwriteClip = options.overwriteRecordedMidiClip ?? overwriteRecordedMidiClipCommand;
  const now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());

  const armedTrackId = ref<number | null>(null);
  const isRecording = ref(false);
  const isCountingIn = ref(false);
  const countInBars = ref(0);
  const error = ref<string | null>(null);
  const inputQuantizeDenominator = ref(0);
  const cycleRecordMode = ref<MidiCycleRecordMode>('takes');

  let buffer: NoteBoundaryEvent[] = [];
  let expressionBuffer: RecordedExpressionEvent[] = [];
  const clearCaptureBuffers = (): void => {
    buffer = [];
    expressionBuffer = [];
  };
  let held = new Map<string, CapturedNoteEvent>();
  // Notes pressed during a count-in are tracked separately. They are not
  // recorded unless the key is still held when the punch-in boundary is
  // reached, in which case an explicit note-on is anchored at the boundary.
  let preRollHeld = new Map<string, CapturedNoteEvent>();
  let recordingStartPpq = 0;
  let recordingCounter = 0;
  const countIn = createCountInController(transport, isCountingIn);
  const finishCountIn = countIn.finish;
  let recordingWrapOffsetPpq = 0;
  /** True once a cycle take's playhead reached the punch; later positions before it are wrapped passes. */
  let cyclePassedPunch = false;
  let lastCapturePpq = 0;
  let recordingTempoMap: NormalizedTempoMap | null = null;
  let recordingStartSeconds = 0;
  let recordingStartTimestampMs: number | null = null;
  let lastCaptureTimestampMs: number | null = null;
  let cycleTake: RecordingCycleTake | null = null;

  const recordingCycleWindow = (): RecordingCycleWindow | null => cycleTake?.window() ?? null;

  /** True when a position precedes the punch rather than lying in a later cycle pass. */
  function positionBeforePunch(ppq: number, cycle: RecordingCycleWindow | null): boolean {
    if (ppq >= recordingStartPpq - 1e-9) {
      if (cycle) cyclePassedPunch = true;
      return false;
    }
    return !(cycle && cyclePassedPunch);
  }

  function currentRecordingPpq(timeStampMs?: number): number {
    if (
      timeStampMs !== undefined &&
      Number.isFinite(timeStampMs) &&
      recordingTempoMap !== null &&
      recordingStartTimestampMs !== null
    ) {
      const elapsedSeconds = Math.max(0, (timeStampMs - recordingStartTimestampMs) / 1000);
      const cycle = recordingCycleWindow();
      let ppq: number;
      if (cycle !== null) {
        const loopStartSeconds = ppqToSecondsMap(recordingTempoMap, cycle.startPpq);
        const loopEndSeconds = ppqToSecondsMap(recordingTempoMap, cycle.endPpq);
        const loopDurationSeconds = loopEndSeconds - loopStartSeconds;
        const loopLengthPpq = cycle.endPpq - cycle.startPpq;
        // Pass 0 runs from the punch to the loop end; every later pass is the whole loop.
        const firstPassSeconds = loopEndSeconds - recordingStartSeconds;
        if (loopDurationSeconds > 0 && loopLengthPpq > 0 && firstPassSeconds > 0) {
          if (elapsedSeconds < firstPassSeconds) {
            ppq = secondsToPpqMap(recordingTempoMap, recordingStartSeconds + elapsedSeconds);
          } else {
            const wrappedSeconds = elapsedSeconds - firstPassSeconds;
            const pass = 1 + Math.floor(wrappedSeconds / loopDurationSeconds);
            const loopElapsedSeconds = wrappedSeconds - (pass - 1) * loopDurationSeconds;
            const loopPpq =
              secondsToPpqMap(recordingTempoMap, loopStartSeconds + loopElapsedSeconds) -
              cycle.startPpq;
            ppq = cycle.startPpq + pass * loopLengthPpq + loopPpq;
          }
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
    const cycle = recordingCycleWindow();
    if (positionBeforePunch(raw, cycle)) return raw;
    let ppq = raw + recordingWrapOffsetPpq;
    if (cycle !== null && ppq < lastCapturePpq - 1e-9) {
      recordingWrapOffsetPpq += cycle.endPpq - cycle.startPpq;
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
    return positionBeforePunch(transport.audiblePositionPpq.value, recordingCycleWindow());
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
      error.value = t.value.notices.recording.armedTrackLocked;
      return;
    }
    if (trackId === null) {
      armedTrackId.value = null;
      return;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (!track) {
      error.value = formatMessage(t.value.notices.recording.unknownTrack, { id: trackId });
      return;
    }
    if (track.kind !== 'midi') {
      error.value = t.value.notices.recording.midiTrackRequired;
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

  function captureExpression(
    timeStampMs: number | undefined,
    event: Omit<RecordedExpressionEvent, 'ppq'>,
  ): void {
    if (!isRecording.value || eventIsBeforePunch(timeStampMs)) return;
    expressionBuffer.push({ ...event, ppq: expressionPointPpq(timeStampMs) });
  }

  const captureControlChange = (event: CapturedControlChangeEvent): void =>
    captureExpression(event.timeStampMs, {
      field: 'ccLanes',
      lane: { controller: event.controller, channel: event.channel, points: [] },
      value: { value: event.value },
    });

  const capturePitchBend = (event: CapturedPitchBendEvent): void =>
    captureExpression(event.timeStampMs, {
      field: 'pitchBendLanes',
      lane: { channel: event.channel, points: [] },
      value: { value: event.value },
    });

  const captureProgramChange = (event: CapturedProgramChangeEvent): void =>
    captureExpression(event.timeStampMs, {
      field: 'programChangeLanes',
      lane: { channel: event.channel, points: [] },
      value: { program: event.program },
    });

  const captureChannelPressure = (event: CapturedChannelPressureEvent): void =>
    captureExpression(event.timeStampMs, {
      field: 'channelPressureLanes',
      lane: { channel: event.channel, points: [] },
      value: { value: event.value },
    });

  const capturePolyPressure = (event: CapturedPolyPressureEvent): void =>
    captureExpression(event.timeStampMs, {
      field: 'polyPressureLanes',
      lane: { channel: event.channel, pitch: event.pitch, points: [] },
      value: { value: event.value },
    });

  const record = (startAtPpq?: number | RecordingStartPlan): boolean => {
    error.value = null;
    if (isRecording.value) return false;
    const trackId = armedTrackId.value;
    if (trackId === null) {
      error.value = t.value.notices.recording.armMidiTrack;
      return false;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (track?.kind !== 'midi') {
      error.value = t.value.notices.recording.midiTrackRequired;
      return false;
    }
    if (track.frozen !== undefined) {
      error.value = t.value.reasons.trackFrozen;
      return false;
    }
    const suppliedPlan = typeof startAtPpq === 'object' && startAtPpq !== null ? startAtPpq : null;
    const legacyStart = typeof startAtPpq === 'number' ? startAtPpq : undefined;
    const plan = resolveTransportRecordingPlan({
      suppliedPlan,
      legacyStart,
      transport,
      countInBars: countInBars.value,
      timeSignatures: store.timeSignatures,
      transportOwner: 'midi',
    });
    const startedFromRest = plan.startedFromRest;
    const startPpq = plan.punchInPpq;
    const tempoBpm = transport.tempo.value;
    const tempoMap = normalizeTempoMap(store.tempoSegments, tempoBpm);
    const ownsTransport = plan.transportOwner === 'midi';
    if (ownsTransport && startedFromRest) {
      if (plan.countInPpq > 0) countIn.forceMetronome();
      transport.seekPpq(plan.countInStartPpq);
      if (!transport.play()) {
        finishCountIn();
        error.value = t.value.notices.recording.transportRejected;
        return false;
      }
    }
    clearCaptureBuffers();
    held = new Map();
    preRollHeld = new Map();
    recordingStartPpq = startPpq;
    recordingTempoMap = tempoMap;
    recordingStartSeconds = ppqToSecondsMap(recordingTempoMap, startPpq);
    const recordStartTimestampMs = now();
    // Anchor timestamped MIDI to the live audible origin captured by the
    // plan. A shared audio start can finish after a few async setup turns, so
    // account for transport progress without consulting the mutable rolling
    // flag (and without changing the plan's original rest decision).
    const rollingOffsetMs = !startedFromRest
      ? (ppqToSecondsMap(recordingTempoMap, Math.max(0, transport.audiblePositionPpq.value)) -
          recordingStartSeconds) *
        1000
      : 0;
    // The plan snapshots the rest/rolling state. Never consult live
    // transport.isPlaying here: audio may have started transport between plan
    // resolution and this call in the shared recording path.
    const stoppedStartLatencyMs = startedFromRest
      ? transport.playbackLatencySeconds.value * 1000
      : 0;
    recordingStartTimestampMs =
      startedFromRest && plan.countInPpq > 0
        ? recordStartTimestampMs +
          ppqRangeSeconds(tempoMap, plan.countInStartPpq, plan.countInEndPpq) * 1000 +
          stoppedStartLatencyMs
        : recordStartTimestampMs - rollingOffsetMs + stoppedStartLatencyMs;
    lastCaptureTimestampMs = null;
    cycleTake = transport.recordingCycle.begin(plan);
    recordingWrapOffsetPpq = 0;
    cyclePassedPunch = false;
    lastCapturePpq = startPpq;
    isRecording.value = true;
    if (ownsTransport && plan.countInPpq > 0) {
      countIn.begin(plan, tempoMap, stoppedStartLatencyMs, activatePreRollHeld);
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
    const loop = recordingCycleWindow();
    const stopPpq = Math.max(
      recordingStartPpq,
      currentRecordingPpq(),
      currentRecordingPpq(effectiveStopTimestampMs),
      lastCapturePpq,
    );
    cycleTake?.end();
    cycleTake = null;
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
    const capturedExpressionEvents = expressionBuffer;
    clearCaptureBuffers();
    held = new Map();
    preRollHeld = new Map();
    if (trackId === null) return null;
    const denominator = inputQuantizeDenominator.value;
    const gridPpq = denominator > 0 ? 4 / denominator : 0;
    const loopLengthPpq = loop ? loop.endPpq - loop.startPpq : 0;
    // Cycle passes are counted from the loop start; a mid-loop punch makes pass 0 partial.
    const originPpq = loop ? loop.startPpq : recordingStartPpq;
    const finalized = finalizeRecording(captured, {
      startPpq: originPpq,
      stopPpq,
      gridPpq,
      quantizeStrength: store.quantizeStrength,
      quantizeSwingPercent: store.quantizeSwing,
      timeSignatures: store.timeSignatures,
    });
    try {
      recordingCounter += 1;
      const capturedLoopEvents = [...captured, ...capturedExpressionEvents];
      const completedLoopPassStart =
        loopLengthPpq > 0
          ? (lastLoopPassWithEventsStartPpq(capturedLoopEvents, originPpq, loopLengthPpq) ??
            lastCompleteLoopPassStartPpq(originPpq, stopPpq, loopLengthPpq))
          : null;
      let notes =
        finalized && loopLengthPpq > 0
          ? selectLastCompleteLoopPassNotes(
              finalized.notes,
              originPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : (finalized?.notes ?? []);
      const capturedExpression =
        completedLoopPassStart !== null
          ? selectLastCompleteLoopPassEvents(
              capturedExpressionEvents,
              originPpq,
              stopPpq,
              loopLengthPpq,
              completedLoopPassStart,
            )
          : capturedExpressionEvents;
      const expressionLoopLengthPpq = completedLoopPassStart !== null ? 0 : loopLengthPpq;
      let lengthPpq =
        completedLoopPassStart !== null
          ? loopLengthPpq
          : expressionLengthPpq(
              capturedExpression,
              originPpq,
              stopPpq,
              loopLengthPpq,
              finalized?.lengthPpq ?? 0,
            );
      if (lengthPpq <= 0) return null;
      let laneFields = nonEmptyLaneFields(
        buildRecordedExpressionLanes(
          capturedExpression,
          originPpq,
          expressionLoopLengthPpq,
          lengthPpq,
        ),
      );
      const midiTakes: MidiClipTake[] = [];
      if (loopLengthPpq > 0) {
        const passStarts = loopPassStartsWithEvents(capturedLoopEvents, originPpq, loopLengthPpq);
        for (let takeIndex = 0; takeIndex < passStarts.length; takeIndex++) {
          const passStart = passStarts[takeIndex];
          const takeNotes = finalized
            ? selectLastCompleteLoopPassNotes(
                finalized.notes,
                originPpq,
                stopPpq,
                loopLengthPpq,
                passStart,
              )
            : [];
          const takeExpression = selectLastCompleteLoopPassEvents(
            capturedExpressionEvents,
            originPpq,
            stopPpq,
            loopLengthPpq,
            passStart,
          );
          midiTakes.push({
            name: `Take ${takeIndex + 1}`,
            notes: takeNotes,
            ...buildRecordedExpressionLanes(takeExpression, originPpq, 0, loopLengthPpq),
          });
        }
      }
      if (loopLengthPpq > 0 && cycleRecordMode.value === 'overdub') {
        notes = finalized ? foldRecordedNotesIntoLoop(finalized.notes, loopLengthPpq) : [];
        lengthPpq = loopLengthPpq;
        laneFields = nonEmptyLaneFields(
          buildRecordedExpressionLanes(
            capturedExpressionEvents,
            originPpq,
            loopLengthPpq,
            lengthPpq,
          ),
        );
      }
      if (notes.length === 0 && Object.keys(laneFields).length === 0) {
        return null;
      }
      const input: AddRecordedMidiClipInput = {
        trackId,
        startPpq: originPpq,
        lengthPpq,
        notes,
        ...laneFields,
        ...(cycleRecordMode.value === 'takes' && midiTakes.length > 1
          ? { midiTakes, activeMidiTakeIndex: midiTakes.length - 1 }
          : {}),
        name: `MIDI Recording ${recordingCounter}`,
      };
      return loopLengthPpq > 0 && cycleRecordMode.value === 'overwrite'
        ? overwriteClip(input)
        : addClip(input);
    } catch (err) {
      error.value = formatMessage(t.value.notices.recording.storeFailed, {
        detail: describeError(err, t.value.notices.errors),
      });
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
    clearCaptureBuffers();
    held = new Map();
    preRollHeld = new Map();
    cycleTake?.end();
    cycleTake = null;
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
