import type { RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';
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
}

export interface RealtimeVoiceChangerRetuneInputOptions extends RealtimeVoiceChangerInputOptions {
  semitones: number;
}

/** Connects microphone input through libsonare's realtime voice changer before the engine input. */
export async function bindRealtimeVoiceChangerInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: RealtimeVoiceChangerInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const channelCount = Math.max(1, Math.floor(options.channelCount ?? 1));
  const node = new AudioWorkletNode(ctx, REALTIME_VOICE_CHANGER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount,
    outputChannelCount: [channelCount],
    processorOptions: {
      preset: options.preset ?? 'neutral-monitor',
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
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): void {
      node.port.postMessage({ type: 'setConfig', preset });
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

/** Connects microphone input through voice changer and then StreamingRetune before the engine. */
export async function bindRealtimeVoiceChangerRetuneInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: RealtimeVoiceChangerRetuneInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const channelCount = Math.max(1, Math.floor(options.channelCount ?? 1));
  const blockSize = Math.max(1, Math.floor(options.blockSize ?? 128));
  const voiceNode = new AudioWorkletNode(ctx, REALTIME_VOICE_CHANGER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount,
    outputChannelCount: [channelCount],
    processorOptions: {
      preset: options.preset ?? 'neutral-monitor',
      sampleRate: ctx.sampleRate,
      blockSize,
      channelCount,
    },
  });
  const retuneNode = new AudioWorkletNode(ctx, STREAMING_RETUNE_PROCESSOR, {
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
    },
  });
  source.connect(voiceNode);
  voiceNode.connect(retuneNode);
  retuneNode.connect(engineNode);
  return {
    stream: options.stream,
    source,
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): void {
      voiceNode.port.postMessage({ type: 'setConfig', preset });
    },
    setStreamingRetuneConfig(config): void {
      retuneNode.port.postMessage({ type: 'setConfig', config });
    },
    close(): void {
      voiceNode.port.postMessage({ type: 'destroy' });
      retuneNode.port.postMessage({ type: 'destroy' });
      source.disconnect();
      voiceNode.disconnect();
      retuneNode.disconnect();
      if (options.stopTracksOnClose) {
        for (const track of options.stream.getTracks()) track.stop();
      }
    },
  };
}
