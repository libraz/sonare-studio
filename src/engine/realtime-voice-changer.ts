import { ensureWasm } from '@/lib/wasm';
import type { RealtimeVoiceChangerConfig, RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';
import {
  fetchWasmBinary,
  forwardWorkletRuntimeErrors,
  listenProcessorError,
  waitForWorkletReady,
} from './engine';
import type { MicrophoneBinding } from './recorder';
import { clampStreamingRetuneSemitones, STREAMING_RETUNE_PROCESSOR } from './streaming-retune';

/** AudioWorklet processor name registered by src/engine/worklet-entry.ts. */
export const REALTIME_VOICE_CHANGER_PROCESSOR = 'sonare-realtime-voice-changer-processor';

export interface RealtimeVoiceChangerInputOptions {
  stream: MediaStream;
  stopTracksOnDestroy: boolean;
  preset?: RealtimeVoiceChangerConfigInput;
  numChannels?: 1 | 2;
  maxBlockSize?: number;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  /** Called when a processor in the chain crashes after startup. */
  onProcessorError?: () => void;
}

export interface RealtimeVoiceChangerRetuneInputOptions extends RealtimeVoiceChangerInputOptions {
  pitchSemitones: number;
}

const REALTIME_VOICE_CHANGER_NUMERIC_FIELDS = [
  'inputGainDb',
  'outputGainDb',
  'wetMix',
  'retunePitchSemitones',
  'retuneMix',
  'formantFactor',
  'formantAmount',
  'formantBody',
  'formantBrightness',
  'formantNasal',
  'eqHighPassHz',
  'eqBodyDb',
  'eqPresenceDb',
  'eqAirDb',
  'gateThresholdDb',
  'gateAttackMs',
  'gateReleaseMs',
  'gateRangeDb',
  'compressorThresholdDb',
  'compressorRatio',
  'compressorAttackMs',
  'compressorReleaseMs',
  'compressorMakeupGainDb',
  'deesserFrequencyHz',
  'deesserThresholdDb',
  'deesserRatio',
  'deesserRangeDb',
  'reverbMix',
  'reverbTimeMs',
  'reverbDamping',
  'reverbSeed',
  'limiterCeilingDb',
  'limiterReleaseMs',
  'limiterIspCeilingDbtp',
] as const satisfies ReadonlyArray<keyof RealtimeVoiceChangerConfig>;

function isRealtimeVoiceChangerConfig(value: unknown): value is RealtimeVoiceChangerConfig {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    REALTIME_VOICE_CHANGER_NUMERIC_FIELDS.every(
      (field) => typeof record[field] === 'number' && Number.isFinite(record[field]),
    ) && typeof record.limiterEnableIspLimiter === 'boolean'
  );
}

/** Resolves only inputs safe to send over the realtime worklet control port. */
function normalizeRealtimeVoiceChangerPreset(
  wasm: typeof import('@/wasm/index.js'),
  preset: RealtimeVoiceChangerConfigInput,
): RealtimeVoiceChangerConfig | null {
  if (typeof preset !== 'string' && isRealtimeVoiceChangerConfig(preset)) return preset;
  if (typeof preset !== 'string') return null;

  try {
    const config = wasm.realtimeVoiceChangerPresetConfig(preset);
    return isRealtimeVoiceChangerConfig(config) ? config : null;
  } catch {
    return null;
  }
}

interface VoiceChangerWorkletSetup {
  wasm: typeof import('@/wasm/index.js');
  wasmBinary: ArrayBuffer;
  initialPreset: RealtimeVoiceChangerConfigInput | RealtimeVoiceChangerConfig;
}

async function prepareVoiceChangerWorklet(
  preset: RealtimeVoiceChangerConfigInput | undefined,
): Promise<VoiceChangerWorkletSetup> {
  const [wasmBinary, wasm] = await Promise.all([fetchWasmBinary(), ensureWasm()]);
  const initialPreset = preset ?? 'neutralMonitor';
  return {
    wasm,
    wasmBinary,
    initialPreset: normalizeRealtimeVoiceChangerPreset(wasm, initialPreset) ?? initialPreset,
  };
}

/** Connects microphone input through libsonare's realtime voice changer before the engine input. */
export async function bindRealtimeVoiceChangerInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: RealtimeVoiceChangerInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const numChannels = options.numChannels ?? 1;
  let node: AudioWorkletNode | null = null;
  let setup: VoiceChangerWorkletSetup;
  try {
    // The worklet scope cannot fetch its own WASM or resolve preset IDs; hand it
    // the shared bytes and a main-thread-normalized initial config.
    setup = await prepareVoiceChangerWorklet(options.preset);
    options.signal?.throwIfAborted();
    node = new AudioWorkletNode(ctx, REALTIME_VOICE_CHANGER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: numChannels,
      outputChannelCount: [numChannels],
      processorOptions: {
        config: setup.initialPreset,
        sampleRate: ctx.sampleRate,
        maxBlockSize: Math.max(1, Math.floor(options.maxBlockSize ?? 128)),
        numChannels,
        wasmBinary: setup.wasmBinary,
      },
    });
    await waitForWorkletReady(node.port, {
      processor: node,
      signal: options.signal,
      timeoutMs: options.readyTimeoutMs,
      label: 'Voice changer',
    });
    options.signal?.throwIfAborted();
    source.connect(node);
    node.connect(engineNode);
  } catch (error) {
    try {
      source.disconnect();
    } catch {
      // The source may not have been connected yet.
    }
    try {
      node?.disconnect();
    } catch {
      // Construction may have failed before the node was connected.
    }
    if (options.stopTracksOnDestroy) {
      for (const track of options.stream.getTracks()) track.stop();
    }
    throw error;
  }
  const readyNode = node;
  const detachRuntimeErrors = forwardWorkletRuntimeErrors(readyNode, 'Voice changer');
  const detachProcessorError = listenProcessorError([readyNode], options.onProcessorError);
  return {
    stream: options.stream,
    source,
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): boolean {
      const config = normalizeRealtimeVoiceChangerPreset(setup.wasm, preset);
      if (!config) return false;
      readyNode.port.postMessage({ type: 'setConfig', config });
      return true;
    },
    destroy(): void {
      detachRuntimeErrors();
      detachProcessorError();
      readyNode.port.postMessage({ type: 'destroy' });
      source.disconnect();
      readyNode.disconnect();
      if (options.stopTracksOnDestroy) {
        for (const track of options.stream.getTracks()) track.stop();
      }
    },
  };
}

/** Connects microphone input through voice changer and then StreamingRetune before the engine. */
export async function bindRealtimeVoiceChangerRetuneInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: RealtimeVoiceChangerRetuneInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const numChannels = options.numChannels ?? 1;
  const maxBlockSize = Math.max(1, Math.floor(options.maxBlockSize ?? 128));
  const startup = new AbortController();
  const onAbort = (): void => startup.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let voiceNode: AudioWorkletNode | null = null;
  let retuneNode: AudioWorkletNode | null = null;
  let setup: VoiceChangerWorkletSetup;
  try {
    // The worklet scope cannot fetch its own WASM or resolve preset IDs; hand
    // both processors the shared bytes and the normalized initial config.
    setup = await prepareVoiceChangerWorklet(options.preset);
    startup.signal.throwIfAborted();
    voiceNode = new AudioWorkletNode(ctx, REALTIME_VOICE_CHANGER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: numChannels,
      outputChannelCount: [numChannels],
      processorOptions: {
        config: setup.initialPreset,
        sampleRate: ctx.sampleRate,
        maxBlockSize,
        numChannels,
        wasmBinary: setup.wasmBinary,
      },
    });
    retuneNode = new AudioWorkletNode(ctx, STREAMING_RETUNE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: numChannels,
      outputChannelCount: [numChannels],
      processorOptions: {
        pitchSemitones: clampStreamingRetuneSemitones(options.pitchSemitones),
        mix: 1,
        sampleRate: ctx.sampleRate,
        maxBlockSize,
        numChannels,
        wasmBinary: setup.wasmBinary,
      },
    });
    await Promise.all([
      waitForWorkletReady(voiceNode.port, {
        processor: voiceNode,
        signal: startup.signal,
        timeoutMs: options.readyTimeoutMs,
        label: 'Voice changer',
      }),
      waitForWorkletReady(retuneNode.port, {
        processor: retuneNode,
        signal: startup.signal,
        timeoutMs: options.readyTimeoutMs,
        label: 'Streaming retune',
      }),
    ]);
    startup.signal.throwIfAborted();
    source.connect(voiceNode);
    voiceNode.connect(retuneNode);
    retuneNode.connect(engineNode);
  } catch (error) {
    startup.abort(error);
    for (const candidate of [retuneNode, voiceNode, source]) {
      try {
        candidate?.disconnect();
      } catch {
        // A partially built graph may contain unconnected nodes.
      }
    }
    if (options.stopTracksOnDestroy) {
      for (const track of options.stream.getTracks()) track.stop();
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
  const readyVoiceNode = voiceNode;
  const readyRetuneNode = retuneNode;
  const detachRuntimeErrors = [
    forwardWorkletRuntimeErrors(readyVoiceNode, 'Voice changer'),
    forwardWorkletRuntimeErrors(readyRetuneNode, 'Streaming retune'),
    listenProcessorError([readyVoiceNode, readyRetuneNode], options.onProcessorError),
  ];
  return {
    stream: options.stream,
    source,
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): boolean {
      const config = normalizeRealtimeVoiceChangerPreset(setup.wasm, preset);
      if (!config) return false;
      readyVoiceNode.port.postMessage({ type: 'setConfig', config });
      return true;
    },
    setStreamingRetuneConfig(config): void {
      readyRetuneNode.port.postMessage({ type: 'setConfig', config });
    },
    destroy(): void {
      for (const detach of detachRuntimeErrors) detach();
      readyVoiceNode.port.postMessage({ type: 'destroy' });
      readyRetuneNode.port.postMessage({ type: 'destroy' });
      source.disconnect();
      readyVoiceNode.disconnect();
      readyRetuneNode.disconnect();
      if (options.stopTracksOnDestroy) {
        for (const track of options.stream.getTracks()) track.stop();
      }
    },
  };
}
