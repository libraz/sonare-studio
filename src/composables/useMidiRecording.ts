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
import { finalizeRecording } from '@/project/midi-recording';
import { useProjectStore } from '@/project/store';
import type { UseTransportReturn } from './useTransport';

/** A note-on/note-off received from a MIDI input (channel-voice, 7-bit). */
export interface CapturedNoteEvent {
  /** MIDI note number (0-127). */
  pitch: number;
  /** Velocity (note-on velocity, or release velocity for note-offs). */
  velocity: number;
  /** MIDI channel (0-15). */
  channel: number;
}

/** Injectable dependencies for {@link useMidiRecording} (tests / alternatives). */
export interface UseMidiRecordingOptions {
  /** Clip-creation command; defaults to addRecordedMidiClip from commands. */
  addRecordedMidiClip?: typeof addRecordedMidiClipCommand;
}

/** Reactive MIDI recording state and actions returned by {@link useMidiRecording}. */
export interface UseMidiRecordingReturn {
  /** The armed (record-destination) MIDI track id, or null. */
  armedTrackId: Ref<number | null>;
  /** True between a successful record() and the matching stopRecord(). */
  isRecording: Ref<boolean>;
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

  const armedTrackId = ref<number | null>(null);
  const isRecording = ref(false);
  const error = ref<string | null>(null);
  const inputQuantizeDenominator = ref(0);

  let buffer: NoteBoundaryEvent[] = [];
  let held = new Map<string, CapturedNoteEvent>();
  let recordingStartPpq = 0;
  let recordingCounter = 0;

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
    const ppq = Math.max(0, transport.positionPpq.value);
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
    const ppq = Math.max(0, transport.positionPpq.value);
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
    if (!transport.isPlaying.value) {
      transport.seekPpq(startPpq);
      if (!transport.play()) {
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
    isRecording.value = true;
    return true;
  };

  const stopRecord = (): number | null => {
    if (!isRecording.value) return null;
    isRecording.value = false;
    const trackId = armedTrackId.value;
    const stopPpq = Math.max(recordingStartPpq, transport.positionPpq.value);
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
      return addClip({
        trackId,
        startPpq: recordingStartPpq,
        lengthPpq: finalized.lengthPpq,
        notes: finalized.notes,
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
    isRecording.value = false;
    buffer = [];
    held = new Map();
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    armedTrackId,
    isRecording,
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
