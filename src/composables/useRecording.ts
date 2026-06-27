/**
 * Reactive recording workflow: glues the engine recorder, the project store
 * and the transport into the arm -> record -> stop -> clip flow.
 *
 * record() optionally pre-rolls a metronome count-in, starts the transport
 * and the capture; stopRecord() ends the capture, stores the take as an
 * audio asset and adds an audio clip at the recorded timeline position on
 * the armed track. The transport keeps rolling after stopRecord(); stopping
 * the transport itself also ends an in-flight recording.
 *
 * Cycle recording: when the transport loop is enabled and recording starts
 * at the loop start, the single linear capture is split at the loop
 * boundaries and every completed pass becomes one take of a single clip
 * spanning the loop window (the last complete take starts selected; see
 * src/project/comping.ts for the comp model).
 */

import type { MaybeRefOrGetter, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue';
import type { EngineHandle } from '@/engine/engine';
import type { Recorder, RecordingResult } from '@/engine/recorder';
import { createRecorder } from '@/engine/recorder';
import { describeError } from '@/lib/errors';
import type { AudioAssetMeta } from '@/persistence/assets';
import { ingestAudioBuffer } from '@/project/audio-import';
import { addAudioClip } from '@/project/commands';
import { ppqToSeconds } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import {
  normalizeTempoMap,
  ppqToSeconds as ppqToSecondsMap,
  secondsToPpq as secondsToPpqMap,
} from '@/project/tempo-map';
import { timeSignatureAt } from '@/project/time-signature';
import type { UseTransportReturn } from './useTransport';

/** Error message shown when recording is attempted before the engine runs. */
const ENGINE_NOT_STARTED_MESSAGE = 'Start the engine before recording.';

/** Injectable dependencies for {@link useRecording} (tests / alternatives). */
export interface UseRecordingOptions {
  /** Recorder factory; defaults to createRecorder from src/engine/recorder. */
  createRecorder?: (handle: EngineHandle) => Recorder;
  /**
   * Take ingestion into the asset store; defaults to ingestAudioBuffer with
   * tempo/key analysis disabled (recordings should land instantly).
   */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<AudioAssetMeta>;
}

/** Reactive recording state and actions returned by {@link useRecording}. */
export interface UseRecordingReturn {
  /** The armed (record-destination) audio track id, or null. */
  armedTrackId: Ref<number | null>;
  /** True between a successful record() and the matching stopRecord(). */
  isRecording: Ref<boolean>;
  /** True while the metronome count-in pre-roll is running. */
  isCountingIn: Ref<boolean>;
  /** Latest input peak level (linear, max across channels, throttled). */
  inputLevel: Ref<number>;
  /** True once microphone access succeeded for the current engine. */
  micReady: Ref<boolean>;
  /** Current input-monitor state (engine-side mic passthrough). */
  monitorEnabled: Ref<boolean>;
  /** Count-in length in bars applied by record() when starting from stop. */
  countInBars: Ref<number>;
  /** Last user-facing error message, or null. Cleared by the next action. */
  error: Ref<string | null>;
  /**
   * Requests microphone access for the current engine.
   *
   * @returns True on success; false with `error` set otherwise.
   */
  requestMic(): Promise<boolean>;
  /**
   * Arms an audio track as the recording destination (null disarms).
   * Non-audio tracks are rejected with `error` set.
   */
  arm(trackId: number | null): void;
  /**
   * Enables/disables input monitoring (delegates to the recorder; the
   * desired state is remembered until the engine and microphone exist).
   */
  setMonitor(enabled: boolean, gain?: number): void;
  /**
   * Starts recording on the armed track: requests the microphone when needed,
   * pre-rolls the count-in (metronome forced on for its duration when it was
   * off), starts the transport when stopped, and begins capturing.
   *
   * @param startAtPpq Explicit punch-in position; when omitted the current
   *   playhead is used. Pass the left locator slightly before the playhead
   *   reaches it for sample-accurate auto-punch (the engine punch window opens
   *   exactly at this position). An explicit start never count-ins or
   *   cycle-splits.
   * @returns True when recording started; false with `error` set otherwise.
   */
  record(startAtPpq?: number): Promise<boolean>;
  /**
   * Stops capturing, ingests the take as an audio asset and adds an audio
   * clip at the recorded position. The transport keeps rolling.
   *
   * @returns The new clip id, or null when nothing usable was captured.
   */
  stopRecord(): Promise<number | null>;
  /** Releases the recorder and timers. Called automatically on scope dispose. */
  dispose(): void;
}

/**
 * Vue composable wiring microphone recording into the project.
 *
 * The engine may be created lazily (after a user gesture): pass a ref or
 * getter that resolves to null until the engine exists. Actions invoked
 * before then fail gracefully with a clear `error` message.
 *
 * @param handleSource The engine handle, or a ref/getter resolving to one.
 * @param transport The transport composable driving playback.
 * @param options Injectable recorder factory / ingestion (tests).
 * @returns Reactive recording state and actions.
 */
export function useRecording(
  handleSource: MaybeRefOrGetter<EngineHandle | null | undefined>,
  transport: UseTransportReturn,
  options: UseRecordingOptions = {},
): UseRecordingReturn {
  const store = useProjectStore();
  const recorderFactory = options.createRecorder ?? createRecorder;
  const ingest =
    options.ingest ??
    ((channels: Float32Array[], sampleRate: number, name: string) =>
      ingestAudioBuffer(channels, sampleRate, name, { analysis: null }));

  const armedTrackId = ref<number | null>(null);
  const isRecording = ref(false);
  const isCountingIn = ref(false);
  const inputLevel = ref(0);
  const micReady = ref(false);
  const monitorEnabled = ref(false);
  const countInBars = ref(0);
  const error = ref<string | null>(null);

  let recorder: Recorder | null = null;
  let recorderHandle: EngineHandle | null = null;
  let unsubscribeLevel: (() => void) | null = null;
  let unsubscribeMicLost: (() => void) | null = null;
  let countInTimer: ReturnType<typeof setTimeout> | null = null;
  let restoreMetronomeOff = false;
  let recordingTrackId: number | null = null;
  let recordingTempoBpm = 120;
  let recordingCounter = 0;
  let recordingLoop: { startPpq: number; endPpq: number } | null = null;

  const resolveHandle = (): EngineHandle | null => toValue(handleSource) ?? null;

  /** Formats an unknown thrown value into a user-facing message. */
  const messageOf = describeError;

  /** Lazily (re)creates the recorder for the current engine handle. */
  const ensureRecorder = (): Recorder | null => {
    const handle = resolveHandle();
    if (!handle) return null;
    if (recorder && recorderHandle === handle) return recorder;
    unsubscribeLevel?.();
    unsubscribeMicLost?.();
    recorder?.dispose();
    micReady.value = false;
    inputLevel.value = 0;
    recorder = recorderFactory(handle);
    recorderHandle = handle;
    unsubscribeLevel = recorder.onLevel((peak) => {
      inputLevel.value = peak;
    });
    unsubscribeMicLost = recorder.onMicrophoneLost(() => {
      // The capture device disappeared: stop any in-flight take, drop the mic
      // state and prompt the user to reconnect (the recorder already discarded
      // the partial take, so no silent all-zero clip lands).
      finishCountIn();
      isRecording.value = false;
      recordingTrackId = null;
      recordingLoop = null;
      micReady.value = false;
      inputLevel.value = 0;
      error.value = 'The microphone was disconnected. Reconnect a device and request it again.';
    });
    recorder.setMonitor(monitorEnabled.value);
    return recorder;
  };

  /** Cancels the count-in timer and restores the metronome when we forced it on. */
  const finishCountIn = (): void => {
    if (countInTimer !== null) {
      globalThis.clearTimeout(countInTimer);
      countInTimer = null;
    }
    isCountingIn.value = false;
    if (restoreMetronomeOff) {
      restoreMetronomeOff = false;
      transport.toggleMetronome(false);
    }
  };

  const requestMic = async (): Promise<boolean> => {
    error.value = null;
    const rec = ensureRecorder();
    if (!rec) {
      error.value = ENGINE_NOT_STARTED_MESSAGE;
      return false;
    }
    try {
      await rec.requestMicrophone();
    } catch (err) {
      error.value = messageOf(err);
      return false;
    }
    micReady.value = true;
    return true;
  };

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
    if (track.kind !== 'audio') {
      error.value = 'Recording requires an audio track.';
      return;
    }
    armedTrackId.value = trackId;
  };

  const setMonitor = (enabled: boolean, gain?: number): void => {
    monitorEnabled.value = enabled;
    ensureRecorder()?.setMonitor(enabled, gain);
  };

  const record = async (startAtPpq?: number): Promise<boolean> => {
    error.value = null;
    if (isRecording.value) return false;
    const explicitStart =
      startAtPpq !== undefined && Number.isFinite(startAtPpq) && startAtPpq >= 0;
    const rec = ensureRecorder();
    if (!rec) {
      error.value = ENGINE_NOT_STARTED_MESSAGE;
      return false;
    }
    const trackId = armedTrackId.value;
    if (trackId === null) {
      error.value = 'Arm an audio track before recording.';
      return false;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (track?.kind !== 'audio') {
      error.value = 'Recording requires an audio track.';
      return false;
    }
    if (!rec.hasMicrophone() && !(await requestMic())) return false;

    const tempoBpm = transport.tempo.value;
    let startPpq = Math.max(0, transport.positionPpq.value);
    const wasRolling = transport.isPlaying.value;
    if (explicitStart) {
      // Auto-punch: the engine punch window opens exactly at this position;
      // no loop-snap, count-in or cycle-split applies.
      startPpq = startAtPpq as number;
    } else if (
      // Cycle recording: starting from stop with the loop on and the playhead
      // near the loop start snaps the capture to the exact loop start, so the
      // takes align with the loop window (ruler seeks land on fractional ppq).
      !wasRolling &&
      transport.loopEnabled.value &&
      transport.loopEndPpq.value > transport.loopStartPpq.value &&
      Math.abs(startPpq - transport.loopStartPpq.value) < 0.5
    ) {
      startPpq = transport.loopStartPpq.value;
    }
    // Count-in only applies when starting from stop; punching in on a
    // rolling transport records from the current position immediately.
    let countInPpq = 0;
    if (!explicitStart && !wasRolling && countInBars.value > 0) {
      const meter = timeSignatureAt(store.timeSignatures, startPpq);
      const barPpq = meter.numerator * (4 / meter.denominator);
      // The pre-roll cannot reach before the timeline start.
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
    }
    try {
      rec.arm(trackId);
      // The punch window starts at startPpq, so the count-in pre-roll (the
      // transport was seeked earlier above) is never part of the capture.
      await rec.start({ startPpq, tempoBpm });
    } catch (err) {
      finishCountIn();
      error.value = messageOf(err);
      return false;
    }
    recordingTrackId = trackId;
    recordingTempoBpm = tempoBpm;
    // Cycle mode: loop enabled and the capture starts at the loop start (a
    // punch-in elsewhere, or an explicit auto-punch, records one linear take).
    const loopStart = transport.loopStartPpq.value;
    const loopEnd = transport.loopEndPpq.value;
    recordingLoop =
      !explicitStart &&
      transport.loopEnabled.value &&
      loopEnd > loopStart &&
      Math.abs(startPpq - loopStart) < 1e-6
        ? { startPpq: loopStart, endPpq: loopEnd }
        : null;
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

  const stopRecord = async (): Promise<number | null> => {
    if (!isRecording.value || !recorder) return null;
    finishCountIn();
    isRecording.value = false;
    const trackId = recordingTrackId ?? armedTrackId.value;
    recordingTrackId = null;
    // Consume the loop state up front so an empty take or a failed stop cannot
    // leave it set to bleed into the next recording.
    const loop = recordingLoop;
    recordingLoop = null;
    let result: RecordingResult | null;
    try {
      result = await recorder.stop();
    } catch (err) {
      error.value = messageOf(err);
      return null;
    }
    if (!result || result.channels.length === 0 || result.channels[0].length === 0) return null;
    if (trackId === null) return null;
    // Convert captured wall-clock seconds back to grid PPQ through the full
    // tempo map (constant-tempo projects collapse to the old scalar math), so a
    // take on a tempo ramp lands the right length and cycle splits hit the loop
    // boundaries instead of drifting.
    const tempoMap = normalizeTempoMap(store.tempoSegments, recordingTempoBpm);
    try {
      recordingCounter += 1;
      const name = `Recording ${recordingCounter}`;
      // Cycle recording: split the linear capture at the loop boundaries and
      // register every completed pass as one take of a single clip.
      if (loop) {
        const loopLengthPpq = loop.endPpq - loop.startPpq;
        const loopSeconds =
          ppqToSecondsMap(tempoMap, loop.endPpq) - ppqToSecondsMap(tempoMap, loop.startPpq);
        const cycleFrames = Math.round(loopSeconds * result.sampleRate);
        const cycles = cycleFrames > 0 ? Math.floor(result.channels[0].length / cycleFrames) : 0;
        if (cycles >= 2) {
          const takes: { assetId: string; name: string }[] = [];
          for (let cycle = 0; cycle < cycles; cycle++) {
            const begin = cycle * cycleFrames;
            const slice = result.channels.map((channel) =>
              channel.slice(begin, begin + cycleFrames),
            );
            const takeName = `${name} — Take ${cycle + 1}`;
            const takeMeta = await ingest(slice, result.sampleRate, takeName);
            takes.push({ assetId: takeMeta.id, name: takeName });
          }
          return await addAudioClip({
            trackId,
            assetId: takes[takes.length - 1].assetId,
            startPpq: loop.startPpq,
            lengthPpq: loopLengthPpq,
            name,
            takes,
          });
        }
      }
      const meta = await ingest(result.channels, result.sampleRate, name);
      const recordedSeconds = result.channels[0].length / result.sampleRate;
      const startSeconds = ppqToSecondsMap(tempoMap, result.startPpq);
      const lengthPpq = secondsToPpqMap(tempoMap, startSeconds + recordedSeconds) - result.startPpq;
      return await addAudioClip({
        trackId,
        assetId: meta.id,
        startPpq: result.startPpq,
        lengthPpq,
        name,
      });
    } catch (err) {
      error.value = `Failed to store the recording: ${messageOf(err)}`;
      return null;
    }
  };

  // Stopping the transport ends an in-flight take (the clip still lands).
  const stopWatching = watch(
    transport.isPlaying,
    (playing) => {
      if (!playing && isRecording.value) void stopRecord();
    },
    { flush: 'sync' },
  );

  const dispose = (): void => {
    finishCountIn();
    stopWatching();
    unsubscribeLevel?.();
    unsubscribeLevel = null;
    unsubscribeMicLost?.();
    unsubscribeMicLost = null;
    recorder?.dispose();
    recorder = null;
    recorderHandle = null;
    recordingTrackId = null;
    isRecording.value = false;
    micReady.value = false;
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    armedTrackId,
    isRecording,
    isCountingIn,
    inputLevel,
    micReady,
    monitorEnabled,
    countInBars,
    error,
    requestMic,
    arm,
    setMonitor,
    record,
    stopRecord,
    dispose,
  };
}
