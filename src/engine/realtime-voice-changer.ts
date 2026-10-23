import { ensureWasm } from '@/lib/wasm';
import type {
  RealtimeVoiceChangerConfigInput,
  RealtimeVoiceChangerPodConfig,
} from '@/wasm/index.js';
import { fetchWasmBinary, forwardWorkletRuntimeErrors, waitForWorkletReady } from './engine';
import type { MicrophoneBinding } from './recorder';
import { clampStreamingRetuneSemitones, STREAMING_RETUNE_PROCESSOR } from './streaming-retune';

/** AudioWorklet processor name registered by src/engine/worklet-entry.ts. */
export const REALTIME_VOICE_CHANGER_PROCESSOR = 'sonare-realtime-voice-changer-processor';

export interface RealtimeVoiceChangerInputOptions {
  stream: MediaStream;
  stopTracksOnClose: boolean;
  preset?: RealtimeVoiceChangerConfigInput;
  channelCount?: number;
  blockSize?: number;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
}

export interface RealtimeVoiceChangerRetuneInputOptions extends RealtimeVoiceChangerInputOptions {
  semitones: number;
}

const REALTIME_VOICE_CHANGER_NUMERIC_FIELDS = [
  'inputGainDb',
  'outputGainDb',
  'wetMix',
  'retuneSemitones',
  'retuneMix',
  'retuneGrainSize',
  'formantFactor',
  'formantAmount',
  'formantBody',
  'formantBrightness',
  'formantNasal',
  'eqHighpassHz',
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
] as const satisfies ReadonlyArray<keyof RealtimeVoiceChangerPodConfig>;

function isRealtimeVoiceChangerPodConfig(value: unknown): value is RealtimeVoiceChangerPodConfig {
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
): RealtimeVoiceChangerPodConfig | null {
  if (typeof preset !== 'string' && isRealtimeVoiceChangerPodConfig(preset)) return preset;
  if (typeof preset !== 'string') return null;

  const resolver = (
    wasm as {
      realtimeVoiceChangerPresetConfig?: (presetId: string) => unknown;
    }
  ).realtimeVoiceChangerPresetConfig;
  if (typeof resolver !== 'function') return null;
  try {
    const config = resolver(preset);
    return isRealtimeVoiceChangerPodConfig(config) ? config : null;
  } catch {
    return null;
  }
}

interface VoiceChangerWorkletSetup {
  wasm: typeof import('@/wasm/index.js');
  wasmBinary: ArrayBuffer;
  initialPreset: RealtimeVoiceChangerConfigInput | RealtimeVoiceChangerPodConfig;
}

async function prepareVoiceChangerWorklet(
  preset: RealtimeVoiceChangerConfigInput | undefined,
): Promise<VoiceChangerWorkletSetup> {
  const [wasmBinary, wasm] = await Promise.all([fetchWasmBinary(), ensureWasm()]);
  const initialPreset = preset ?? 'neutral-monitor';
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
  const channelCount = Math.max(1, Math.floor(options.channelCount ?? 1));
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
      channelCount,
      outputChannelCount: [channelCount],
      processorOptions: {
        preset: setup.initialPreset,
        sampleRate: ctx.sampleRate,
        blockSize: Math.max(1, Math.floor(options.blockSize ?? 128)),
        channelCount,
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
    if (options.stopTracksOnClose) {
      for (const track of options.stream.getTracks()) track.stop();
    }
    throw error;
  }
  const readyNode = node;
  const detachRuntimeErrors = forwardWorkletRuntimeErrors(readyNode, 'Voice changer');
  return {
    stream: options.stream,
    source,
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): boolean {
      const config = normalizeRealtimeVoiceChangerPreset(setup.wasm, preset);
      if (!config) return false;
      readyNode.port.postMessage({ type: 'setConfig', config });
      return true;
    },
    close(): void {
      detachRuntimeErrors();
      readyNode.port.postMessage({ type: 'destroy' });
      source.disconnect();
      readyNode.disconnect();
      if (options.stopTracksOnClose) {
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
  const channelCount = Math.max(1, Math.floor(options.channelCount ?? 1));
  const blockSize = Math.max(1, Math.floor(options.blockSize ?? 128));
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
      channelCount,
      outputChannelCount: [channelCount],
      processorOptions: {
        preset: setup.initialPreset,
        sampleRate: ctx.sampleRate,
        blockSize,
        channelCount,
        wasmBinary: setup.wasmBinary,
      },
    });
    retuneNode = new AudioWorkletNode(ctx, STREAMING_RETUNE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount,
      outputChannelCount: [channelCount],
      processorOptions: {
        semitones: clampStreamingRetuneSemitones(options.semitones),
        mix: 1,
        grainSize: 0,
        sampleRate: ctx.sampleRate,
        blockSize,
        channelCount,
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
    if (options.stopTracksOnClose) {
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
    close(): void {
      for (const detach of detachRuntimeErrors) detach();
      readyVoiceNode.port.postMessage({ type: 'destroy' });
      readyRetuneNode.port.postMessage({ type: 'destroy' });
      source.disconnect();
      readyVoiceNode.disconnect();
      readyRetuneNode.disconnect();
      if (options.stopTracksOnClose) {
        for (const track of options.stream.getTracks()) track.stop();
      }
    },
  };
}
