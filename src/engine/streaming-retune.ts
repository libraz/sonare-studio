import type { StreamingRetuneConfig } from '@/wasm/index.js';
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
  stopTracksOnClose: boolean;
  channelCount?: number;
  blockSize?: number;
}

/** Connects microphone input through libsonare's StreamingRetune before the engine input. */
export async function bindStreamingRetuneInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: StreamingRetuneInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const channelCount = Math.max(1, Math.floor(options.channelCount ?? 1));
  const node = new AudioWorkletNode(ctx, STREAMING_RETUNE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount,
    outputChannelCount: [channelCount],
    processorOptions: {
      semitones: clampStreamingRetuneSemitones(options.semitones ?? 0),
      mix: options.mix ?? 1,
      grainSize: options.grainSize ?? 0,
      sampleRate: ctx.sampleRate,
      blockSize: Math.max(1, Math.floor(options.blockSize ?? 128)),
      channelCount,
    },
  });
  source.connect(node);
  node.connect(engineNode);
  return {
    stream: options.stream,
    source,
    setStreamingRetuneConfig(config: StreamingRetuneConfig): void {
      node.port.postMessage({ type: 'setConfig', config });
    },
    close(): void {
      node.port.postMessage({ type: 'destroy' });
      source.disconnect();
      node.disconnect();
      if (options.stopTracksOnClose) {
        for (const track of options.stream.getTracks()) track.stop();
      }
    },
  };
}
