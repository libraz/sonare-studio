import type { StreamingRetuneConfig } from '@libraz/libsonare';
import {
  fetchWasmBinary,
  forwardWorkletRuntimeErrors,
  listenProcessorError,
  waitForWorkletReady,
} from './engine';
import type { MicrophoneBinding } from './recorder';

export const STREAMING_RETUNE_PROCESSOR = 'sonare-streaming-retune-processor';
export const STREAMING_RETUNE_MIN_SEMITONES = -24;
export const STREAMING_RETUNE_MAX_SEMITONES = 24;

export interface StreamingRetuneScaleTarget {
  rootPc: number;
  modeMask: number;
}

export interface StreamingRetuneMidiTarget {
  currentMidi: number;
  targetMidi: number;
}

const pitchClassOf = (midi: number): number => ((Math.round(midi) % 12) + 12) % 12;

export function clampStreamingRetuneSemitones(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  return Math.max(
    STREAMING_RETUNE_MIN_SEMITONES,
    Math.min(STREAMING_RETUNE_MAX_SEMITONES, Math.round(semitones)),
  );
}

export function streamingRetuneSemitonesForMidiTarget(target: StreamingRetuneMidiTarget): number {
  return clampStreamingRetuneSemitones(target.targetMidi - target.currentMidi);
}

export function streamingRetuneSemitonesForScaleTarget(
  currentMidi: number,
  scale: StreamingRetuneScaleTarget,
): number {
  if (!Number.isFinite(currentMidi) || !Number.isFinite(scale.rootPc)) return 0;
  const modeMask = Math.trunc(scale.modeMask) & 0xfff;
  if (modeMask === 0) return 0;
  const rootPc = pitchClassOf(scale.rootPc);
  const baseMidi = Math.round(currentMidi);
  let bestMidi = baseMidi;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let distance = 0; distance <= 24; distance += 1) {
    const candidates = distance === 0 ? [baseMidi] : [baseMidi - distance, baseMidi + distance];
    for (const candidate of candidates) {
      const interval = (pitchClassOf(candidate) - rootPc + 12) % 12;
      if (((modeMask >> interval) & 1) === 0) continue;
      const actualDistance = Math.abs(candidate - baseMidi);
      if (actualDistance < bestDistance) {
        bestMidi = candidate;
        bestDistance = actualDistance;
      }
    }
    if (bestDistance !== Number.POSITIVE_INFINITY) break;
  }
  return clampStreamingRetuneSemitones(bestMidi - baseMidi);
}

export interface StreamingRetuneInputOptions extends StreamingRetuneConfig {
  stream: MediaStream;
  stopTracksOnDestroy: boolean;
  numChannels?: 1 | 2;
  maxBlockSize?: number;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  /** Called when the processor crashes after startup. */
  onProcessorError?: () => void;
}

/** Connects microphone input through libsonare's StreamingRetune before the engine input. */
export async function bindStreamingRetuneInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: StreamingRetuneInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const numChannels = options.numChannels ?? 1;
  let node: AudioWorkletNode | null = null;
  try {
    // The worklet scope cannot fetch its own WASM; hand it the shared bytes.
    const wasmBinary = await fetchWasmBinary();
    options.signal?.throwIfAborted();
    node = new AudioWorkletNode(ctx, STREAMING_RETUNE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: numChannels,
      outputChannelCount: [numChannels],
      processorOptions: {
        pitchSemitones: clampStreamingRetuneSemitones(options.pitchSemitones ?? 0),
        mix: options.mix ?? 1,
        ...(options.grainSizeSamples === undefined
          ? {}
          : { grainSizeSamples: options.grainSizeSamples }),
        sampleRate: ctx.sampleRate,
        maxBlockSize: Math.max(1, Math.floor(options.maxBlockSize ?? 128)),
        numChannels,
        wasmBinary,
      },
    });
    await waitForWorkletReady(node.port, {
      processor: node,
      signal: options.signal,
      timeoutMs: options.readyTimeoutMs,
      label: 'Streaming retune',
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
  const detachRuntimeErrors = forwardWorkletRuntimeErrors(readyNode, 'Streaming retune');
  const detachProcessorError = listenProcessorError([readyNode], options.onProcessorError);
  return {
    stream: options.stream,
    source,
    setStreamingRetuneConfig(config: StreamingRetuneConfig): void {
      readyNode.port.postMessage({ type: 'setConfig', config });
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
