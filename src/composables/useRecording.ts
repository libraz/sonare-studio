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
import {
  createRecorder,
  DEFAULT_MAX_DURATION_SECONDS,
  type RecordingCaptureSource,
} from '@/engine/recorder';
import { clampStreamingRetuneSemitones } from '@/engine/streaming-retune';
import { describeError } from '@/lib/errors';
import {
  OperationGeneration,
  type OperationIdentity,
  type OperationToken,
} from '@/lib/operation-generation';
import { ensureWasm } from '@/lib/wasm';
import { leaseAudioAssets } from '@/persistence/asset-leases';
import { createAudioAssetTransaction } from '@/persistence/asset-transaction';
import type { AudioAssetMeta } from '@/persistence/assets';
import { collectReferencedAudioAssetIds } from '@/project/asset-references';
import { type AddRecordedAudioClipInput, addRecordedAudioClips } from '@/project/commands';
import { createInsertPdcPlan, insertLatencyResolverFromCatalog } from '@/project/insert-latency';
import {
  loopRecordingSplits,
  loopRecordingTakeSlices,
  type RecordingStartPlan,
  resolveAutoPunchRecordingStartPlan,
  resolveRecordingStartPlan,
} from '@/project/loop-recording';
import { useProjectStore } from '@/project/store';
import {
  normalizeTempoMap,
  ppqRangeSeconds,
  ppqToSeconds as ppqToSecondsMap,
  secondsToPpq as secondsToPpqMap,
} from '@/project/tempo-map';
import { formatMessage, useI18n } from '@/ui/i18n';
import type { RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';
import type { UseTransportReturn } from './useTransport';

interface RecordingChannelRoute {
  trackId: number;
  channelIndex: number | null;
}

export type RecordingVoiceChangerPreset = 'off' | RealtimeVoiceChangerConfigInput;
export type RecordingOperationState =
  | 'idle'
  | 'requesting'
  | 'armed'
  | 'recording'
  | 'stopping'
  | 'ingesting';

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
   * Test/alternate take ingestion. Production recording uses a lease-backed
   * asset transaction; an injected ingester owns deletion of assets it creates.
   */
  ingest?: (channels: Float32Array[], sampleRate: number, name: string) => Promise<AudioAssetMeta>;
}

/** Reactive recording state and actions returned by {@link useRecording}. */
export interface UseRecordingReturn {
  /** Exclusive recording operation state; non-idle transitional states reject re-entry. */
  state: Ref<RecordingOperationState>;
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
   * The latency-extended capture punch-out of the take in progress in PPQ,
   * or null when no take is capturing.
   */
  capturePunchOutPpq(): number | null;
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
  /**
   * Sets the source captured by the next recording take. A change requested
   * during an operation is held and applied once the operation ends.
   */
  setCaptureSource(source: RecordingCaptureSource): void;
  /** Sets the microphone input device used by the next input capture binding. */
  setInputDeviceId(deviceId: string): void;
  /**
   * Starts recording on the armed track: requests the microphone when needed,
   * pre-rolls the count-in (metronome forced on for its duration when it was
   * off), starts the transport when stopped, and begins capturing.
   *
   * @param startAtPpq Legacy numeric auto-punch position, or a resolved
   *   {@link RecordingStartPlan} shared with MIDI recording.
   * @param endAtPpq Optional explicit punch-out position. Pass the right
   *   locator for sample-accurate auto-punch out. Legacy numeric starts use the
   *   named auto-punch path; resolved plans carry their own count-in/cycle mode.
   * @returns True when recording started; false with `error` set otherwise.
   */
  record(startAtPpq?: number | RecordingStartPlan, endAtPpq?: number): Promise<boolean>;
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
  const injectedIngest = options.ingest;

  const armedTrackId = ref<number | null>(null);
  const armedTrackIds = ref<number[]>([]);
  const state = ref<RecordingOperationState>('idle');
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
  let recordingInputDeviceKeys: string[] = [];
  let recordingInputChannels: Array<number | undefined> = [];
  let recordingCounter = 0;
  let recordingLoop: { startPpq: number; endPpq: number } | null = null;
  const recordingOperations = new OperationGeneration();
  const microphoneOperations = new OperationGeneration();
  /** Per-track device signature the current recorder was built with. */
  let recorderDeviceSignature = '';

  interface RecordingOperation {
    token: OperationToken;
    identity: OperationIdentity;
    recorder: Recorder;
    handle: EngineHandle;
    targetTrackIds: readonly number[];
    plan: RecordingStartPlan | null;
    startAtPpq?: number;
    endAtPpq?: number;
  }

  let activeOperation: RecordingOperation | null = null;

  const resolveHandle = (): EngineHandle | null => toValue(handleSource) ?? null;

  /**
   * Distinct per-track record input device ids across the armed audio tracks,
   * in armed order (device order = merged capture channel). Tracks without an
   * explicit device contribute the global/default input sentinel so a default
   * input can be merged alongside a separately selected device.
   */
  const armedInputDeviceIds = (): string[] => {
    const ids: string[] = [];
    const fallback = inputDeviceId.value.trim();
    for (const id of armedTrackIds.value) {
      const track = store.tracks.find((t) => t.id === id);
      const device = track?.kind === 'audio' ? track.recordInputDeviceId?.trim() : undefined;
      ids.push(device || fallback);
    }
    return ids;
  };

  /** Formats an unknown thrown value into a user-facing message. */
  const { t } = useI18n();
  const messageOf = (err: unknown): string => describeError(err, t.value.notices.errors);

  const recordingIdentity = (
    targetTrackIds: readonly number[],
    startAtPpq?: number | RecordingStartPlan,
    endAtPpq?: number,
  ): OperationIdentity => {
    const routeRevision = targetTrackIds.map((id) => {
      const track = store.tracks.find((entry) => entry.id === id);
      return track?.kind === 'audio'
        ? `${id}:${track.recordInputDeviceId ?? ''}:${track.recordInputChannel ?? ''}`
        : `missing:${id}`;
    });
    return {
      projectId: store.documentGeneration,
      targetId: targetTrackIds.join(','),
      revision: [
        captureSource.value,
        inputDeviceId.value,
        recorderDeviceSignature,
        typeof startAtPpq === 'object'
          ? `${startAtPpq.punchInPpq}:${startAtPpq.transportOwner}:${startAtPpq.startedFromRest}`
          : (startAtPpq ?? ''),
        endAtPpq ?? '',
        ...routeRevision,
      ].join('|'),
    };
  };

  const operationIsCurrent = (operation: RecordingOperation): boolean =>
    activeOperation === operation &&
    recorder === operation.recorder &&
    recorderHandle === operation.handle &&
    resolveHandle() === operation.handle &&
    recordingOperations.isCurrent(operation.token, operation.identity);

  const clearTakeState = (): void => {
    recordingTrackIds = [];
    recordingCaptureSource = captureSource.value;
    recordingInputDeviceKeys = [];
    recordingInputChannels = [];
    recordingLoop = null;
    isRecording.value = false;
  };

  const finishOperation = (operation: RecordingOperation): void => {
    if (activeOperation !== operation) return;
    activeOperation = null;
    recordingOperations.invalidate();
    clearTakeState();
    state.value = 'idle';
  };

  /** Lazily (re)creates the recorder for the current engine handle. */
  const ensureRecorder = (): Recorder | null => {
    // A live take owns its recorder binding. Replacing it mid-take makes the
    // stop path stale and can leave the recording state stuck indefinitely.
    if (state.value !== 'idle') return recorder;
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
    const distinctDevices = new Set(deviceIds.map((id) => id.trim()));
    const suppressInputEffects = captureSource.value === 'input' && distinctDevices.size >= 2;
    if (
      suppressInputEffects &&
      (voiceChangerPreset.value !== 'off' || streamingRetuneSemitones.value !== 0)
    ) {
      error.value = t.value.notices.recording.multiDeviceEffectsUnavailable;
    }
    recorder = recorderFactory(handle, {
      voiceChangerPreset:
        suppressInputEffects || voiceChangerPreset.value === 'off'
          ? null
          : (voiceChangerPreset.value as RealtimeVoiceChangerConfigInput),
      streamingRetuneSemitones: suppressInputEffects ? 0 : streamingRetuneSemitones.value,
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
      recordingOperations.invalidate(new DOMException('Microphone disconnected.', 'AbortError'));
      activeOperation = null;
      clearTakeState();
      state.value = 'idle';
      micReady.value = false;
      inputLevel.value = 0;
      error.value = t.value.notices.recording.micDisconnected;
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
    if (microphoneOperations.disposed) return false;
    const rec = ensureRecorder();
    if (!rec) {
      error.value = t.value.notices.recording.engineNotStarted;
      return false;
    }
    if (captureSource.value === 'output') {
      micReady.value = true;
      return true;
    }
    const identity = recordingIdentity([...armedTrackIds.value]);
    const token = microphoneOperations.begin(identity);
    const current = (): boolean =>
      recorder === rec &&
      recorderHandle === resolveHandle() &&
      microphoneOperations.isCurrent(token, recordingIdentity([...armedTrackIds.value]));
    try {
      await rec.requestMicrophone();
    } catch (err) {
      if (current()) error.value = messageOf(err);
      return false;
    }
    if (!current()) return false;
    micReady.value = true;
    return true;
  };

  const arm = (trackId: number | null): void => {
    error.value = null;
    if (state.value !== 'idle') {
      error.value = t.value.notices.recording.armedTrackLocked;
      return;
    }
    if (trackId === null) {
      armedTrackId.value = null;
      armedTrackIds.value = [];
      return;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (!track) {
      error.value = formatMessage(t.value.notices.recording.unknownTrack, { id: trackId });
      return;
    }
    if (track.kind !== 'audio') {
      error.value = t.value.notices.recording.audioTrackRequired;
      return;
    }
    armedTrackId.value = trackId;
    armedTrackIds.value = [trackId];
  };

  const setTrackArmed = (trackId: number, armed: boolean): void => {
    error.value = null;
    if (state.value !== 'idle') {
      error.value = t.value.notices.recording.armedTrackLocked;
      return;
    }
    const track = store.tracks.find((t) => t.id === trackId);
    if (!track) {
      error.value = formatMessage(t.value.notices.recording.unknownTrack, { id: trackId });
      return;
    }
    if (track.kind !== 'audio') {
      error.value = t.value.notices.recording.audioTrackRequired;
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

  let pendingCaptureSource: RecordingCaptureSource | null = null;

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
    if (state.value === 'recording') {
      voiceChangerPreset.value = preset;
      if (preset === 'off' || !recorder?.setVoiceChangerPreset(preset)) {
        error.value = t.value.notices.recording.voiceChangerNextBinding;
      }
      return;
    }
    if (state.value !== 'idle') {
      error.value = t.value.notices.recording.voiceChangerBusy;
      return;
    }
    voiceChangerPreset.value = preset;
    resetRecorderBinding();
  };

  const setStreamingRetuneSemitones = (semitones: number): void => {
    error.value = null;
    if (state.value === 'recording') {
      streamingRetuneSemitones.value = clampStreamingRetuneSemitones(semitones);
      if (!recorder?.setStreamingRetuneSemitones(streamingRetuneSemitones.value)) {
        error.value = t.value.notices.recording.retuneNextBinding;
      }
      return;
    }
    if (state.value !== 'idle') {
      error.value = t.value.notices.recording.retuneBusy;
      return;
    }
    streamingRetuneSemitones.value = clampStreamingRetuneSemitones(semitones);
    resetRecorderBinding();
  };

  const applyCaptureSource = (source: RecordingCaptureSource): void => {
    if (captureSource.value === source) return;
    captureSource.value = source;
    resetRecorderBinding();
  };

  const setCaptureSource = (source: RecordingCaptureSource): void => {
    error.value = null;
    if (source !== 'input' && source !== 'output') {
      error.value = formatMessage(t.value.notices.recording.unknownSource, { source });
      return;
    }
    if (state.value !== 'idle') {
      pendingCaptureSource = source;
      error.value = t.value.notices.recording.sourceNextTake;
      return;
    }
    pendingCaptureSource = null;
    applyCaptureSource(source);
  };

  const setInputDeviceId = (deviceId: string): void => {
    error.value = null;
    const next = deviceId.trim();
    if (state.value !== 'idle') {
      inputDeviceId.value = next;
      error.value = t.value.notices.recording.deviceNextTake;
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
    inputDeviceKeys?: ReadonlyArray<string>,
    inputChannels?: ReadonlyArray<number | undefined>,
  ): RecordingChannelRoute[] => {
    if (source !== 'input') {
      return trackIds.map((trackId) => ({ trackId, channelIndex: null }));
    }
    const deviceKeys =
      inputDeviceKeys?.length === trackIds.length
        ? [...inputDeviceKeys]
        : trackIds.map((trackId) => {
            const track = store.tracks.find((entry) => entry.id === trackId);
            return track?.kind === 'audio'
              ? track.recordInputDeviceId?.trim() || inputDeviceId.value.trim()
              : '';
          });
    const distinctDevices = [...new Set(deviceKeys)];
    if (distinctDevices.length >= 2) {
      return trackIds.map((trackId, trackIndex) => ({
        trackId,
        channelIndex: Math.min(
          Math.max(0, channelCount - 1),
          Math.max(0, distinctDevices.indexOf(deviceKeys[trackIndex])),
        ),
      }));
    }
    const requestedChannels =
      inputChannels?.length === trackIds.length
        ? [...inputChannels]
        : trackIds.map((trackId) => {
            const track = store.tracks.find((entry) => entry.id === trackId);
            return track?.kind === 'audio' ? track.recordInputChannel : undefined;
          });
    if (
      requestedChannels.every((requested) => requested === undefined) &&
      (trackIds.length <= 1 || channelCount < trackIds.length)
    ) {
      return trackIds.map((trackId) => ({ trackId, channelIndex: null }));
    }
    return trackIds.map((trackId, trackIndex) => {
      const requested = requestedChannels[trackIndex];
      const channelIndex =
        requested !== undefined
          ? requested >= 0 && requested < channelCount
            ? requested
            : 0
          : trackIds.length > 1
            ? Math.min(trackIndex, Math.max(0, channelCount - 1))
            : null;
      return { trackId, channelIndex };
    });
  };

  /** Current primary-output PDC, added only to microphone takes. */
  const playbackPdcSamples = async (handle: EngineHandle): Promise<number> => {
    const wasm = await ensureWasm();
    const resolveLatency = insertLatencyResolverFromCatalog(
      wasm.masteringProcessorCatalog(),
      handle.ctx.sampleRate,
      wasm.masteringInsertTiming,
    );
    return createInsertPdcPlan(store.tracks, store.mixer.buses, resolveLatency).maxLatencySamples;
  };

  const record = async (
    startAtPpq?: number | RecordingStartPlan,
    endAtPpq?: number,
  ): Promise<boolean> => {
    error.value = null;
    if (recordingOperations.disposed || state.value !== 'idle') return false;
    const suppliedPlan = typeof startAtPpq === 'object' && startAtPpq !== null ? startAtPpq : null;
    const legacyStart = typeof startAtPpq === 'number' ? startAtPpq : undefined;
    const explicitEnd = endAtPpq !== undefined && Number.isFinite(endAtPpq);
    const rec = ensureRecorder();
    if (!rec) {
      error.value = t.value.notices.recording.engineNotStarted;
      return false;
    }
    const targetTrackIds = [...armedTrackIds.value];
    if (targetTrackIds.length === 0) {
      error.value = t.value.notices.recording.armAudioTrack;
      return false;
    }
    if (
      targetTrackIds.some((id) => {
        const track = store.tracks.find((t) => t.id === id);
        return track?.kind !== 'audio';
      })
    ) {
      error.value = t.value.notices.recording.audioTrackRequired;
      return false;
    }
    const identity = recordingIdentity(targetTrackIds, startAtPpq, endAtPpq);
    const token = recordingOperations.begin(identity);
    const operation: RecordingOperation = {
      token,
      identity,
      recorder: rec,
      handle: recorderHandle as EngineHandle,
      targetTrackIds,
      plan: null,
      ...(legacyStart !== undefined ? { startAtPpq: legacyStart } : {}),
      ...(endAtPpq !== undefined ? { endAtPpq } : {}),
    };
    activeOperation = operation;
    state.value = 'requesting';
    const fail = (message?: string): false => {
      if (activeOperation === operation) {
        if (message && operationIsCurrent(operation)) error.value = message;
        finishOperation(operation);
      }
      return false;
    };
    if (captureSource.value === 'input' && !rec.hasMicrophone()) {
      try {
        await rec.requestMicrophone();
      } catch (err) {
        return fail(messageOf(err));
      }
      if (!operationIsCurrent(operation)) return fail();
      micReady.value = true;
    }
    if (!operationIsCurrent(operation)) return fail();

    // Resolve the plan only after microphone prewarm. A caller that already
    // resolved a plan (the shared audio+MIDI path) is consumed verbatim.
    const plan =
      suppliedPlan ??
      (legacyStart !== undefined && Number.isFinite(legacyStart) && legacyStart >= 0
        ? resolveAutoPunchRecordingStartPlan({
            positionPpq: transport.positionPpq.value,
            audiblePositionPpq: transport.audiblePositionPpq.value,
            startedFromRest: !transport.isPlaying.value,
            requestedStartPpq: legacyStart,
            loopEnabled: transport.loopEnabled.value,
            loopStartPpq: transport.loopStartPpq.value,
            loopEndPpq: transport.loopEndPpq.value,
            countInBars: countInBars.value,
            timeSignatures: store.timeSignatures,
            transportOwner: 'audio',
          })
        : resolveRecordingStartPlan({
            positionPpq: transport.positionPpq.value,
            audiblePositionPpq: transport.audiblePositionPpq.value,
            startedFromRest: !transport.isPlaying.value,
            loopEnabled: transport.loopEnabled.value,
            loopStartPpq: transport.loopStartPpq.value,
            loopEndPpq: transport.loopEndPpq.value,
            countInBars: countInBars.value,
            timeSignatures: store.timeSignatures,
            transportOwner: 'audio',
          }));
    operation.plan = plan;
    const tempoBpm = transport.tempo.value;
    const startPpq = plan.punchInPpq;
    const endPpq = explicitEnd ? (endAtPpq as number) : undefined;
    if (endPpq !== undefined && endPpq <= startPpq) {
      return fail(t.value.notices.recording.punchOrder);
    }
    const tempoMap = normalizeTempoMap(store.tempoSegments, tempoBpm);
    const ownsTransport = plan.transportOwner !== 'midi';
    if (ownsTransport && plan.startedFromRest) {
      if (plan.countInPpq > 0 && !transport.metronomeEnabled.value) {
        transport.toggleMetronome(true);
        restoreMetronomeOff = true;
      }
      transport.seekPpq(plan.countInStartPpq);
    }
    const startOptions: Parameters<Recorder['start']>[0] = { startPpq, tempoBpm, tempoMap };
    if (endPpq !== undefined) {
      const startSeconds = ppqToSecondsMap(tempoMap, startPpq);
      const endSeconds = ppqToSecondsMap(tempoMap, endPpq);
      if (
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        endSeconds <= startSeconds
      ) {
        return fail(t.value.notices.recording.punchOrder);
      }
      startOptions.endPpq = endPpq;
      startOptions.maxDurationSeconds = endSeconds - startSeconds;
    } else {
      // Open-ended capture: resolve the safety punch-out through the tempo map
      // so it lands exactly when the preallocated buffer fills. A constant-BPM
      // estimate drifts on a tempo ramp, cutting the take short or overrunning.
      const startSeconds = ppqToSecondsMap(tempoMap, startPpq);
      startOptions.maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS;
      startOptions.punchOutPpq = secondsToPpqMap(
        tempoMap,
        startSeconds + DEFAULT_MAX_DURATION_SECONDS,
      );
    }
    if (captureSource.value === 'input') {
      startOptions.playbackLatencySamples = await playbackPdcSamples(operation.handle);
    }
    try {
      rec.arm(targetTrackIds[0]);
      state.value = 'armed';
      // The punch window starts at startPpq, so count-in pre-roll is never
      // part of the captured audio.
      await rec.start(startOptions);
    } catch (err) {
      finishCountIn();
      return fail(messageOf(err));
    }
    if (!operationIsCurrent(operation)) {
      await rec.stop().catch(() => undefined);
      return fail();
    }
    recordingTrackIds = targetTrackIds;
    recordingTempoBpm = tempoBpm;
    recordingCaptureSource = captureSource.value;
    recordingInputDeviceKeys = targetTrackIds.map((trackId) => {
      const track = store.tracks.find((entry) => entry.id === trackId);
      return track?.kind === 'audio'
        ? track.recordInputDeviceId?.trim() || inputDeviceId.value.trim()
        : '';
    });
    recordingInputChannels = targetTrackIds.map((trackId) => {
      const track = store.tracks.find((entry) => entry.id === trackId);
      return track?.kind === 'audio' ? track.recordInputChannel : undefined;
    });
    recordingLoop = plan.cycle;
    isRecording.value = true;
    state.value = 'recording';
    // Capture reset/arm/punch is complete before transport can expose the
    // first timeline sample to the recorder. MIDI consumes a shared plan and
    // therefore never starts or seeks transport here.
    if (ownsTransport && plan.startedFromRest && !transport.play()) {
      await rec.stop().catch(() => undefined);
      finishCountIn();
      return fail(t.value.notices.recording.transportRejected);
    }
    if (ownsTransport && plan.countInPpq > 0) {
      isCountingIn.value = true;
      countInTimer = globalThis.setTimeout(
        () => {
          countInTimer = null;
          finishCountIn();
        },
        ppqRangeSeconds(tempoMap, plan.countInStartPpq, plan.countInEndPpq) * 1000,
      );
    }
    return true;
  };

  const stopRecord = async (): Promise<number | null> => {
    const operation = activeOperation;
    if (state.value !== 'recording' || !operation) return null;
    if (recorder !== operation.recorder) {
      finishOperation(operation);
      error.value = t.value.notices.recording.inputChangedBeforeStop;
      return null;
    }
    const rec = operation.recorder;
    const current = (): boolean => operationIsCurrent(operation);
    const complete = (clipId: number | null): number | null => {
      finishOperation(operation);
      return clipId;
    };
    state.value = 'stopping';
    finishCountIn();
    const targetTrackIds =
      recordingTrackIds.length > 0 ? recordingTrackIds : [...armedTrackIds.value];
    const recordSource = recordingCaptureSource;
    const loop = recordingLoop;
    let result: RecordingResult | null;
    try {
      result = await rec.stop();
    } catch (err) {
      if (current()) {
        state.value = 'recording';
        error.value = messageOf(err);
      }
      return null;
    }
    if (!current()) {
      error.value = t.value.notices.recording.inputChangedBeforeSave;
      return complete(null);
    }
    isRecording.value = false;
    state.value = 'ingesting';
    if (!result || result.channels.length === 0 || result.channels[0].length === 0) {
      return complete(null);
    }
    if (targetTrackIds.length === 0) return complete(null);
    const overflowed = (result.overflowCount ?? 0) > 0;
    // Convert captured wall-clock seconds back to grid PPQ through the full
    // tempo map (constant-tempo projects collapse to the old scalar math), so a
    // take on a tempo ramp lands the right length and cycle splits hit the loop
    // boundaries instead of drifting.
    const tempoMap = normalizeTempoMap(store.tempoSegments, recordingTempoBpm);
    const assets = injectedIngest ? null : createAudioAssetTransaction();
    const externalLease = injectedIngest ? leaseAudioAssets([]) : null;
    const externallyHeldIds = new Set<string>();
    let assetLifetimeFinished = false;
    const stageAsset = async (
      channels: Float32Array[],
      sampleRate: number,
      name: string,
    ): Promise<AudioAssetMeta> => {
      if (assets) return assets.save({ name, sampleRate }, channels);
      const meta = await injectedIngest!(channels, sampleRate, name);
      externallyHeldIds.add(meta.id);
      externalLease?.update(externallyHeldIds);
      return meta;
    };
    const commitAssets = (): void => {
      if (assetLifetimeFinished) return;
      assetLifetimeFinished = true;
      assets?.commit();
      externalLease?.release();
    };
    const rollbackAssets = async (): Promise<void> => {
      if (assetLifetimeFinished) return;
      assetLifetimeFinished = true;
      externalLease?.release();
      await assets?.rollback((assetId) =>
        collectReferencedAudioAssetIds(store.clips, store.tracks).has(assetId),
      );
    };
    const cancelIngest = async (): Promise<number | null> => {
      await rollbackAssets();
      return complete(null);
    };
    try {
      const nextRecordingCounter = recordingCounter + 1;
      const name = `Recording ${nextRecordingCounter}`;
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
            recordingInputDeviceKeys,
            recordingInputChannels,
          );
          const clipInputs: AddRecordedAudioClipInput[] = [];
          for (const route of routes) {
            const takes: { assetId: string; name: string }[] = [];
            const sourceChannels =
              route.channelIndex === null ? result.channels : [result.channels[route.channelIndex]];
            for (const takeSlice of loopRecordingTakeSlices(sourceChannels, splits)) {
              const takeName = `${name} — Take ${takeSlice.index + 1}`;
              const takeMeta = await stageAsset(takeSlice.channels, result.sampleRate, takeName);
              if (!current()) return cancelIngest();
              takes.push({ assetId: takeMeta.id, name: takeName });
            }
            if (takes.length < 2) continue;
            clipInputs.push({
              trackId: route.trackId,
              assetId: takes[takes.length - 1].assetId,
              startPpq: loop.startPpq,
              lengthPpq: loopLengthPpq,
              name,
              takes,
            });
          }
          if (!current()) return cancelIngest();
          const clipIds = addRecordedAudioClips(clipInputs);
          commitAssets();
          recordingCounter = nextRecordingCounter;
          if (overflowed) error.value = t.value.notices.recording.overflow;
          return complete(clipIds[0] ?? null);
        }
      }
      const recordedSeconds = result.channels[0].length / result.sampleRate;
      const startSeconds = ppqToSecondsMap(tempoMap, result.startPpq);
      const lengthPpq = secondsToPpqMap(tempoMap, startSeconds + recordedSeconds) - result.startPpq;
      const routes = recordingChannelRoutes(
        targetTrackIds,
        recordSource,
        result.channels.length,
        recordingInputDeviceKeys,
        recordingInputChannels,
      );
      const sharedMeta = routes.some((route) => route.channelIndex !== null)
        ? null
        : await stageAsset(result.channels, result.sampleRate, name);
      if (!current()) return cancelIngest();
      const clipInputs: AddRecordedAudioClipInput[] = [];
      for (const route of routes) {
        const meta =
          sharedMeta ??
          (await stageAsset(
            [result.channels[route.channelIndex as number]],
            result.sampleRate,
            `${name} — Ch ${(route.channelIndex as number) + 1}`,
          ));
        if (!current()) return cancelIngest();
        clipInputs.push({
          trackId: route.trackId,
          assetId: meta.id,
          startPpq: result.startPpq,
          lengthPpq,
          name,
        });
      }
      if (!current()) return cancelIngest();
      const clipIds = addRecordedAudioClips(clipInputs);
      commitAssets();
      recordingCounter = nextRecordingCounter;
      if (overflowed) error.value = t.value.notices.recording.overflow;
      return complete(clipIds[0] ?? null);
    } catch (err) {
      try {
        await rollbackAssets();
      } catch (rollbackError) {
        if (current()) {
          error.value = formatMessage(t.value.notices.recording.storeFailedCleanup, {
            detail: messageOf(err),
            cleanupDetail: messageOf(rollbackError),
          });
        }
        return complete(null);
      }
      if (current())
        error.value = formatMessage(t.value.notices.recording.storeFailed, {
          detail: messageOf(err),
        });
      return complete(null);
    }
  };

  // Stopping the transport ends an in-flight take (the clip still lands).
  const stopWatching = watch(
    transport.isPlaying,
    (playing) => {
      if (!playing && state.value === 'recording') void stopRecord();
    },
    { flush: 'sync' },
  );

  // A source change requested mid-operation lands once the state is idle.
  const stopWatchingPendingSource = watch(
    state,
    (current) => {
      if (current !== 'idle' || pendingCaptureSource === null) return;
      const next = pendingCaptureSource;
      pendingCaptureSource = null;
      applyCaptureSource(next);
    },
    { flush: 'sync' },
  );

  const dispose = (): void => {
    if (recordingOperations.disposed) return;
    stopWatchingPendingSource();
    pendingCaptureSource = null;
    recordingOperations.dispose(new DOMException('Recording disposed.', 'AbortError'));
    microphoneOperations.dispose(new DOMException('Recording disposed.', 'AbortError'));
    activeOperation = null;
    finishCountIn();
    stopWatching();
    unsubscribeLevel?.();
    unsubscribeLevel = null;
    unsubscribeMicLost?.();
    unsubscribeMicLost = null;
    recorder?.dispose();
    recorder = null;
    recorderHandle = null;
    clearTakeState();
    state.value = 'idle';
    micReady.value = false;
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return {
    armedTrackId,
    armedTrackIds,
    state,
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
    capturePunchOutPpq: () => recorder?.capturePunchOutPpq() ?? null,
    record,
    stopRecord,
    dispose,
  };
}
