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
import { createRecorder, type RecordingCaptureSource } from '@/engine/recorder';
import { clampStreamingRetuneSemitones } from '@/engine/streaming-retune';
import { describeError } from '@/lib/errors';
import type { AudioAssetMeta } from '@/persistence/assets';
import { ingestAudioBuffer } from '@/project/audio-import';
import { addAudioClip } from '@/project/commands';
import { loopRecordingSplits, loopRecordingTakeSlices } from '@/project/loop-recording';
import { ppqToSeconds } from '@/project/scheduling';
import { useProjectStore } from '@/project/store';
import {
  normalizeTempoMap,
  ppqToSeconds as ppqToSecondsMap,
  secondsToPpq as secondsToPpqMap,
} from '@/project/tempo-map';
import { timeSignatureAt } from '@/project/time-signature';
import type { RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';
import type { UseTransportReturn } from './useTransport';

/** Error message shown when recording is attempted before the engine runs. */
const ENGINE_NOT_STARTED_MESSAGE = 'Start the engine before recording.';
const RECORDING_OVERFLOW_MESSAGE =
  'Recording reached the capture buffer limit; the end of the take was dropped.';

interface RecordingChannelRoute {
  trackId: number;
  channelIndex: number | null;
}

export type RecordingVoiceChangerPreset = 'off' | RealtimeVoiceChangerConfigInput;

/** Injectable dependencies for {@link useRecording} (tests / alternatives). */
export interface UseRecordingOptions {
  /** Recorder factory; defaults to createRecorder from src/engine/recorder. */
  createRecorder?: (
    handle: EngineHandle,
    options?: {
      voiceChangerPreset?: RealtimeVoiceChangerConfigInput | null;
      streamingRetuneSemitones?: number;
      captureSource?: RecordingCaptureSource;
      inputDeviceId?: string;
      inputDeviceIds?: ReadonlyArray<string>;
    },
  ) => Recorder;
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
  /** All armed audio track ids. Multiple tracks receive the same input take. */
  armedTrackIds: Ref<readonly number[]>;
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
  /** Realtime voice changer preset applied to the next microphone binding. */
  voiceChangerPreset: Ref<RecordingVoiceChangerPreset>;
  /** StreamingRetune semitone shift applied to the next microphone binding. */
  streamingRetuneSemitones: Ref<number>;
  /** Capture source: raw microphone input or the engine master output. */
  captureSource: Ref<RecordingCaptureSource>;
  /** Selected browser audioinput device id; empty string uses the default input. */
  inputDeviceId: Ref<string>;
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
  /** Arms/disarms one audio track without clearing other armed audio tracks. */
  setTrackArmed(trackId: number, armed: boolean): void;
  /**
   * Enables/disables input monitoring (delegates to the recorder; the
   * desired state is remembered until the engine and microphone exist).
   */
  setMonitor(enabled: boolean, gain?: number): void;
  /** Sets the realtime voice changer preset for microphone recording/monitoring. */
  setVoiceChangerPreset(preset: RecordingVoiceChangerPreset): void;
  /** Sets StreamingRetune semitone shift for microphone recording/monitoring. */
  setStreamingRetuneSemitones(semitones: number): void;
  /** Sets the source captured by the next recording take. */
  setCaptureSource(source: RecordingCaptureSource): void;
  /** Sets the microphone input device used by the next input capture binding. */
  setInputDeviceId(deviceId: string): void;
  /**
   * Starts recording on the armed track: requests the microphone when needed,
   * pre-rolls the count-in (metronome forced on for its duration when it was
   * off), starts the transport when stopped, and begins capturing.
   *
   * @param startAtPpq Explicit punch-in position; when omitted the current
   *   playhead is used.
   * @param endAtPpq Optional explicit punch-out position. Pass the right
   *   locator for sample-accurate auto-punch out. An explicit start/end never
   *   count-ins or cycle-splits.
   * @returns True when recording started; false with `error` set otherwise.
   */
  record(startAtPpq?: number, endAtPpq?: number): Promise<boolean>;
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
  const armedTrackIds = ref<number[]>([]);
  const isRecording = ref(false);
  const isCountingIn = ref(false);
  const inputLevel = ref(0);
  const micReady = ref(false);
  const monitorEnabled = ref(false);
  const countInBars = ref(0);
  const voiceChangerPreset = ref<RecordingVoiceChangerPreset>('off');
  const streamingRetuneSemitones = ref(0);
  const captureSource = ref<RecordingCaptureSource>('input');
  const inputDeviceId = ref('');
  const error = ref<string | null>(null);

  let recorder: Recorder | null = null;
  let recorderHandle: EngineHandle | null = null;
  let unsubscribeLevel: (() => void) | null = null;
  let unsubscribeMicLost: (() => void) | null = null;
  let countInTimer: ReturnType<typeof setTimeout> | null = null;
  let restoreMetronomeOff = false;
  let recordingTrackIds: number[] = [];
  let recordingTempoBpm = 120;
  let recordingCaptureSource: RecordingCaptureSource = 'input';
  let recordingCounter = 0;
  let recordingLoop: { startPpq: number; endPpq: number } | null = null;
  /** Per-track device signature the current recorder was built with. */
  let recorderDeviceSignature = '';

  const resolveHandle = (): EngineHandle | null => toValue(handleSource) ?? null;

  /**
   * Distinct per-track record input device ids across the armed audio tracks,
   * in armed order (device order = merged capture channel). Tracks without an
   * explicit device record from the global input and contribute nothing here;
   * the recorder falls back to the single-device path unless two or more
   * distinct devices are present.
   */
  const armedInputDeviceIds = (): string[] => {
    const ids: string[] = [];
    for (const id of armedTrackIds.value) {
      const track = store.tracks.find((t) => t.id === id);
      const device = track?.kind === 'audio' ? track.recordInputDeviceId?.trim() : undefined;
      if (device) ids.push(device);
    }
    return ids;
  };

  /** Formats an unknown thrown value into a user-facing message. */
  const messageOf = describeError;

  /** Lazily (re)creates the recorder for the current engine handle. */
  const ensureRecorder = (): Recorder | null => {
    const handle = resolveHandle();
    if (!handle) return null;
    const deviceIds = armedInputDeviceIds();
    const deviceSignature = deviceIds.join('|');
    if (recorder && recorderHandle === handle && deviceSignature === recorderDeviceSignature) {
      return recorder;
    }
    unsubscribeLevel?.();
    unsubscribeMicLost?.();
    recorder?.dispose();
    micReady.value = false;
    inputLevel.value = 0;
    recorder = recorderFactory(handle, {
      voiceChangerPreset:
        voiceChangerPreset.value === 'off'
          ? null
          : (voiceChangerPreset.value as RealtimeVoiceChangerConfigInput),
      streamingRetuneSemitones: streamingRetuneSemitones.value,
      captureSource: captureSource.value,
      inputDeviceId: inputDeviceId.value,
      inputDeviceIds: deviceIds,
    });
    recorderDeviceSignature = deviceSignature;
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
      recordingTrackIds = [];
      recordingCaptureSource = captureSource.value;
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
    if (captureSource.value === 'output') {
      micReady.value = true;
      return true;
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
      armedTrackIds.value = [];
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
    armedTrackIds.value = [trackId];
  };

  const setTrackArmed = (trackId: number, armed: boolean): void => {
    error.value = null;
    if (isRecording.value) {
      error.value = 'Cannot change the armed track while recording.';
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
    const next = armed
      ? Array.from(new Set([...armedTrackIds.value, trackId]))
      : armedTrackIds.value.filter((id) => id !== trackId);
    armedTrackIds.value = next;
    armedTrackId.value = next[0] ?? null;
  };

  const setMonitor = (enabled: boolean, gain?: number): void => {
    monitorEnabled.value = enabled;
    ensureRecorder()?.setMonitor(enabled, gain);
  };

  const resetRecorderBinding = (): void => {
    if (!recorder) return;
    unsubscribeLevel?.();
    unsubscribeLevel = null;
    unsubscribeMicLost?.();
    unsubscribeMicLost = null;
    recorder.dispose();
    recorder = null;
    recorderHandle = null;
    micReady.value = false;
    inputLevel.value = 0;
  };

  const setVoiceChangerPreset = (preset: RecordingVoiceChangerPreset): void => {
    error.value = null;
    if (isRecording.value) {
      voiceChangerPreset.value = preset;
      if (preset === 'off' || !recorder?.setVoiceChangerPreset(preset)) {
        error.value = 'Voice changer changes will apply to the next microphone binding.';
      }
      return;
    }
    voiceChangerPreset.value = preset;
    resetRecorderBinding();
  };

  const setStreamingRetuneSemitones = (semitones: number): void => {
    error.value = null;
    if (isRecording.value) {
      streamingRetuneSemitones.value = clampStreamingRetuneSemitones(semitones);
      if (!recorder?.setStreamingRetuneSemitones(streamingRetuneSemitones.value)) {
        error.value = 'Retune changes will apply to the next microphone binding.';
      }
      return;
    }
    streamingRetuneSemitones.value = clampStreamingRetuneSemitones(semitones);
    resetRecorderBinding();
  };

  const setCaptureSource = (source: RecordingCaptureSource): void => {
    error.value = null;
    if (source !== 'input' && source !== 'output') {
      error.value = `Unknown recording source: ${source}`;
      return;
    }
    if (isRecording.value) {
      error.value = 'Recording source changes will apply to the next take.';
      return;
    }
    if (captureSource.value === source) return;
    captureSource.value = source;
    resetRecorderBinding();
  };

  const setInputDeviceId = (deviceId: string): void => {
    error.value = null;
    const next = deviceId.trim();
    if (isRecording.value) {
      error.value = 'Input device changes will apply to the next take.';
      return;
    }
    if (inputDeviceId.value === next) return;
    inputDeviceId.value = next;
    resetRecorderBinding();
  };

  const recordingChannelRoutes = (
    trackIds: ReadonlyArray<number>,
    source: RecordingCaptureSource,
    channelCount: number,
  ): RecordingChannelRoute[] => {
    if (source !== 'input' || trackIds.length <= 1 || channelCount < trackIds.length) {
      return trackIds.map((trackId) => ({ trackId, channelIndex: null }));
    }
    return trackIds.map((trackId, trackIndex) => {
      const track = store.tracks.find((entry) => entry.id === trackId);
      const requested = track?.kind === 'audio' ? track.recordInputChannel : undefined;
      const channelIndex =
        requested !== undefined && requested >= 0 && requested < channelCount
          ? requested
          : trackIndex;
      return { trackId, channelIndex };
    });
  };

  const record = async (startAtPpq?: number, endAtPpq?: number): Promise<boolean> => {
    error.value = null;
    if (isRecording.value) return false;
    const explicitStart =
      startAtPpq !== undefined && Number.isFinite(startAtPpq) && startAtPpq >= 0;
    const explicitEnd = endAtPpq !== undefined && Number.isFinite(endAtPpq);
    const rec = ensureRecorder();
    if (!rec) {
      error.value = ENGINE_NOT_STARTED_MESSAGE;
      return false;
    }
    const targetTrackIds = [...armedTrackIds.value];
    if (targetTrackIds.length === 0) {
      error.value = 'Arm an audio track before recording.';
      return false;
    }
    if (
      targetTrackIds.some((id) => {
        const track = store.tracks.find((t) => t.id === id);
        return track?.kind !== 'audio';
      })
    ) {
      error.value = 'Recording requires an audio track.';
      return false;
    }
    if (captureSource.value === 'input' && !rec.hasMicrophone() && !(await requestMic())) {
      return false;
    }

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
    const endPpq = explicitEnd ? (endAtPpq as number) : undefined;
    if (endPpq !== undefined && endPpq <= startPpq) {
      error.value = 'The punch-out locator must be after the punch-in locator.';
      return false;
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
    const startOptions: Parameters<Recorder['start']>[0] = { startPpq, tempoBpm };
    if (endPpq !== undefined) {
      const tempoMap = normalizeTempoMap(store.tempoSegments, tempoBpm);
      const startSeconds = ppqToSecondsMap(tempoMap, startPpq);
      const endSeconds = ppqToSecondsMap(tempoMap, endPpq);
      if (
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        endSeconds <= startSeconds
      ) {
        error.value = 'The punch-out locator must be after the punch-in locator.';
        return false;
      }
      startOptions.endPpq = endPpq;
      startOptions.maxDurationSeconds = endSeconds - startSeconds;
    }
    try {
      rec.arm(targetTrackIds[0]);
      // The punch window starts at startPpq, so the count-in pre-roll (the
      // transport was seeked earlier above) is never part of the capture.
      await rec.start(startOptions);
    } catch (err) {
      finishCountIn();
      error.value = messageOf(err);
      return false;
    }
    recordingTrackIds = targetTrackIds;
    recordingTempoBpm = tempoBpm;
    recordingCaptureSource = captureSource.value;
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
    const targetTrackIds =
      recordingTrackIds.length > 0 ? recordingTrackIds : [...armedTrackIds.value];
    recordingTrackIds = [];
    const recordSource = recordingCaptureSource;
    recordingCaptureSource = captureSource.value;
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
    if (targetTrackIds.length === 0) return null;
    const overflowed = (result.overflowCount ?? 0) > 0;
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
        const framesPerCycle = loopSeconds * result.sampleRate;
        const splits = loopRecordingSplits(result.channels[0].length, framesPerCycle);
        if (splits.length >= 2) {
          const routes = recordingChannelRoutes(
            targetTrackIds,
            recordSource,
            result.channels.length,
          );
          let firstClipId: number | null = null;
          for (const route of routes) {
            const takes: { assetId: string; name: string }[] = [];
            const sourceChannels =
              route.channelIndex === null ? result.channels : [result.channels[route.channelIndex]];
            for (const takeSlice of loopRecordingTakeSlices(sourceChannels, splits)) {
              const takeName = `${name} — Take ${takeSlice.index + 1}`;
              const takeMeta = await ingest(takeSlice.channels, result.sampleRate, takeName);
              takes.push({ assetId: takeMeta.id, name: takeName });
            }
            if (takes.length < 2) continue;
            const clipId = await addAudioClip({
              trackId: route.trackId,
              assetId: takes[takes.length - 1].assetId,
              startPpq: loop.startPpq,
              lengthPpq: loopLengthPpq,
              name,
              takes,
            });
            firstClipId ??= clipId;
          }
          if (overflowed) error.value = RECORDING_OVERFLOW_MESSAGE;
          return firstClipId;
        }
      }
      const recordedSeconds = result.channels[0].length / result.sampleRate;
      const startSeconds = ppqToSecondsMap(tempoMap, result.startPpq);
      const lengthPpq = secondsToPpqMap(tempoMap, startSeconds + recordedSeconds) - result.startPpq;
      let firstClipId: number | null = null;
      const routes = recordingChannelRoutes(targetTrackIds, recordSource, result.channels.length);
      const sharedMeta = routes.some((route) => route.channelIndex !== null)
        ? null
        : await ingest(result.channels, result.sampleRate, name);
      for (const route of routes) {
        const meta =
          sharedMeta ??
          (await ingest(
            [result.channels[route.channelIndex as number]],
            result.sampleRate,
            `${name} — Ch ${(route.channelIndex as number) + 1}`,
          ));
        const clipId = await addAudioClip({
          trackId: route.trackId,
          assetId: meta.id,
          startPpq: result.startPpq,
          lengthPpq,
          name,
        });
        firstClipId ??= clipId;
      }
      if (overflowed) error.value = RECORDING_OVERFLOW_MESSAGE;
      return firstClipId;
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
    recordingTrackIds = [];
    isRecording.value = false;
    micReady.value = false;
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    armedTrackId,
    armedTrackIds,
    isRecording,
    isCountingIn,
    inputLevel,
    micReady,
    monitorEnabled,
    countInBars,
    voiceChangerPreset,
    streamingRetuneSemitones,
    captureSource,
    inputDeviceId,
    error,
    requestMic,
    arm,
    setTrackArmed,
    setMonitor,
    setVoiceChangerPreset,
    setStreamingRetuneSemitones,
    setCaptureSource,
    setInputDeviceId,
    record,
    stopRecord,
    dispose,
  };
}
