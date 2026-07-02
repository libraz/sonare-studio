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
import type { NoteBoundaryEvent } from '@/project/midi-events';
import { finalizeRecording, foldRecordedNotesIntoLoop } from '@/project/midi-recording';
import { ppqToSeconds } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import {
  type NormalizedTempoMap,
  normalizeTempoMap,
  ppqToSeconds as ppqToSecondsMap,
  secondsToPpq as secondsToPpqMap,
} from '@/project/tempo-map';
import { timeSignatureAt } from '@/project/time-signature';
import type { UseTransportReturn } from './useTransport';

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
  /**
   * Arms a MIDI track as the recording destination (null disarms).
   * Non-MIDI tracks are rejected with `error` set.
   */
  arm(trackId: number | null): void;
  /** Records a note-on at the current transport position (no-op when idle). */
  captureNoteOn(event: CapturedNoteEvent): void;
  /** Records a note-off at the current transport position (no-op when idle). */
  captureNoteOff(event: CapturedNoteEvent): void;
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

  let buffer: NoteBoundaryEvent[] = [];
  let held = new Map<string, CapturedNoteEvent>();
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
      const seconds = recordingStartSeconds + (timeStampMs - recordingStartTimestampMs) / 1000;
      const ppq = secondsToPpqMap(recordingTempoMap, seconds);
      if (ppq > lastCapturePpq) lastCapturePpq = ppq;
      return ppq;
    }
    const raw = Math.max(0, transport.positionPpq.value);
    if (raw < recordingStartPpq - 1e-9) return raw;
    let ppq = raw + recordingWrapOffsetPpq;
    if (recordingLoopLengthPpq > 0 && ppq < lastCapturePpq - 1e-9) {
      recordingWrapOffsetPpq += recordingLoopLengthPpq;
      ppq = raw + recordingWrapOffsetPpq;
    }
    if (ppq > lastCapturePpq) lastCapturePpq = ppq;
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
    const ppq = currentRecordingPpq(event.timeStampMs);
    buffer.push({
      ppq,
      kind: 'on',
      pitch: event.pitch,
      velocity: event.velocity,
      channel: event.channel,
    });
    held.set(`${event.channel}:${event.pitch}`, event);
  };

  const captureNoteOff = (event: CapturedNoteEvent): void => {
    if (!isRecording.value) return;
    const ppq = currentRecordingPpq(event.timeStampMs);
    buffer.push({
      ppq,
      kind: 'off',
      pitch: event.pitch,
      velocity: event.velocity,
      channel: event.channel,
    });
    held.delete(`${event.channel}:${event.pitch}`);
  };

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
    let startPpq = explicit ? (startAtPpq as number) : Math.max(0, transport.positionPpq.value);
    const wasRolling = transport.isPlaying.value;
    let countInPpq = 0;
    const tempoBpm = transport.tempo.value;
    if (!explicit && !wasRolling && countInBars.value > 0) {
      const meter = timeSignatureAt(store.timeSignatures, startPpq);
      const barPpq = meter.numerator * (4 / meter.denominator);
      countInPpq = Math.min(startPpq, countInBars.value * barPpq);
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
      startPpq = Math.max(0, transport.positionPpq.value);
    }
    buffer = [];
    held = new Map();
    recordingStartPpq = startPpq;
    recordingTempoMap = normalizeTempoMap(store.tempoSegments, tempoBpm);
    recordingStartSeconds = ppqToSecondsMap(recordingTempoMap, startPpq);
    recordingStartTimestampMs =
      !wasRolling && countInPpq > 0 ? now() + ppqToSeconds(countInPpq, tempoBpm) * 1000 : now();
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
      countInTimer = globalThis.setTimeout(() => {
        countInTimer = null;
        finishCountIn();
      }, ppqToSeconds(countInPpq, tempoBpm) * 1000);
    }
    return true;
  };

  const stopRecord = (): number | null => {
    if (!isRecording.value) return null;
    finishCountIn();
    isRecording.value = false;
    const trackId = armedTrackId.value;
    const loop = recordingLoop;
    recordingLoop = null;
    const stopPpq = Math.max(recordingStartPpq, currentRecordingPpq());
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
    buffer = [];
    held = new Map();
    if (trackId === null) return null;
    const denominator = inputQuantizeDenominator.value;
    const gridPpq = denominator > 0 ? 4 / denominator : 0;
    const finalized = finalizeRecording(captured, {
      startPpq: recordingStartPpq,
      stopPpq,
      gridPpq,
    });
    if (!finalized) return null;
    try {
      recordingCounter += 1;
      const loopLengthPpq = loop ? loop.endPpq - loop.startPpq : 0;
      const notes =
        loopLengthPpq > 0
          ? foldRecordedNotesIntoLoop(finalized.notes, loopLengthPpq)
          : finalized.notes;
      if (notes.length === 0) return null;
      return addClip({
        trackId,
        startPpq: loop?.startPpq ?? recordingStartPpq,
        lengthPpq: loopLengthPpq > 0 ? loopLengthPpq : finalized.lengthPpq,
        notes,
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
    held = new Map();
    recordingLoop = null;
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
    arm,
    captureNoteOn,
    captureNoteOff,
    record,
    stopRecord,
    dispose,
  };
}
