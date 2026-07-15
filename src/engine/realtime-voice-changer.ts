import type { RealtimeVoiceChangerConfigInput } from '@/wasm/index.js';
import { waitForWorkletReady } from './engine';
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

/** Connects microphone input through libsonare's realtime voice changer before the engine input. */
export async function bindRealtimeVoiceChangerInput(
  ctx: AudioContext,
  engineNode: AudioWorkletNode,
  options: RealtimeVoiceChangerInputOptions,
): Promise<MicrophoneBinding> {
  const source = ctx.createMediaStreamSource(options.stream);
  const channelCount = Math.max(1, Math.floor(options.channelCount ?? 1));
  let node: AudioWorkletNode | null = null;
  try {
    node = new AudioWorkletNode(ctx, REALTIME_VOICE_CHANGER_PROCESSOR, {
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
  return {
    stream: options.stream,
    source,
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): void {
      readyNode.port.postMessage({ type: 'setConfig', preset });
    },
    close(): void {
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
  try {
    voiceNode = new AudioWorkletNode(ctx, REALTIME_VOICE_CHANGER_PROCESSOR, {
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
  return {
    stream: options.stream,
    source,
    setVoiceChangerPreset(preset: RealtimeVoiceChangerConfigInput): void {
      readyVoiceNode.port.postMessage({ type: 'setConfig', preset });
    },
    setStreamingRetuneConfig(config): void {
      readyRetuneNode.port.postMessage({ type: 'setConfig', config });
    },
    close(): void {
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
