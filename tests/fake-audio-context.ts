/**
 * Minimal AudioContext stub for preview-playback tests. jsdom provides no
 * Web Audio implementation, so specs inject this through the preview's
 * context factory and inspect the recorded nodes.
 */

/** Buffer stub recording the channel data copied into it. */
export interface FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  channelData: Float32Array[];
  copyToChannel(source: Float32Array, channel: number): void;
}

/** Gain node stub. */
export interface FakeGainNode {
  gain: { value: number };
  connections: unknown[];
  disconnected: boolean;
  connect(target: unknown): void;
  disconnect(): void;
}

/** Buffer source stub recording start/stop calls. */
export interface FakeBufferSourceNode {
  buffer: FakeAudioBuffer | null;
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connections: unknown[];
  connect(target: unknown): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

/** AudioContext stub exposing the nodes it created for assertions. */
export interface FakeAudioContext {
  state: AudioContextState;
  destination: { kind: string };
  gains: FakeGainNode[];
  sources: FakeBufferSourceNode[];
  resumeCount: number;
  closed: boolean;
  createGain(): FakeGainNode;
  createBuffer(numChannels: number, frames: number, sampleRate: number): FakeAudioBuffer;
  createBufferSource(): FakeBufferSourceNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** Creates a fresh fake context (cast to AudioContext where needed). */
export function createFakeAudioContext(
  options: { state?: AudioContextState } = {},
): FakeAudioContext {
  const context: FakeAudioContext = {
    state: options.state ?? 'running',
    destination: { kind: 'destination' },
    gains: [],
    sources: [],
    resumeCount: 0,
    closed: false,
    createGain() {
      const gain: FakeGainNode = {
        gain: { value: 1 },
        connections: [],
        disconnected: false,
        connect(target) {
          gain.connections.push(target);
        },
        disconnect() {
          gain.disconnected = true;
        },
      };
      context.gains.push(gain);
      return gain;
    },
    createBuffer(numChannels, frames, sampleRate) {
      const channelData = Array.from({ length: numChannels }, () => new Float32Array(frames));
      return {
        numberOfChannels: numChannels,
        length: frames,
        sampleRate,
        channelData,
        copyToChannel(source, channel) {
          channelData[channel].set(source.subarray(0, frames));
        },
      };
    },
    createBufferSource() {
      const node: FakeBufferSourceNode = {
        buffer: null,
        onended: null,
        started: false,
        stopped: false,
        connections: [],
        connect(target) {
          node.connections.push(target);
        },
        disconnect() {
          // Connections are kept for assertions; nothing to undo.
        },
        start() {
          node.started = true;
        },
        stop() {
          node.stopped = true;
        },
      };
      context.sources.push(node);
      return node;
    },
    async resume() {
      context.resumeCount += 1;
      context.state = 'running';
    },
    async close() {
      context.closed = true;
      context.state = 'closed';
    },
  };
  return context;
}

/** The fake cast to the lib AudioContext type for factory injection. */
export function asAudioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}
