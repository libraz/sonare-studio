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
export interface FakeAudioParamEvent {
  kind: 'cancel' | 'hold' | 'set' | 'ramp';
  value?: number;
  when: number;
}

/** AudioParam stub with enough automation to exercise clickless ramps. */
export interface FakeAudioParam {
  value: number;
  cancelScheduledValues(when: number): void;
  cancelAndHoldAtTime(when: number): void;
  setValueAtTime(value: number, when: number): void;
  linearRampToValueAtTime(value: number, when: number): void;
}

export interface FakeGainNode {
  gain: FakeAudioParam;
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
  startOffset: number;
  stopped: boolean;
  connections: unknown[];
  connect(target: unknown): void;
  disconnect(): void;
  start(when?: number, offset?: number): void;
  stop(): void;
}

/** AudioContext stub exposing the nodes it created for assertions. */
export interface FakeAudioContext {
  state: AudioContextState;
  currentTime: number;
  destination: { kind: string };
  gains: FakeGainNode[];
  sources: FakeBufferSourceNode[];
  gainEvents: FakeAudioParamEvent[];
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
    currentTime: 0,
    destination: { kind: 'destination' },
    gains: [],
    sources: [],
    gainEvents: [],
    resumeCount: 0,
    closed: false,
    createGain() {
      type AutomationEvent = {
        kind: 'set' | 'ramp';
        value: number;
        when: number;
      };
      let baseValue = 1;
      let automation: AutomationEvent[] = [];

      function valueAt(when: number): number {
        let value = baseValue;
        let valueWhen = Number.NEGATIVE_INFINITY;
        for (const event of automation) {
          if (event.kind === 'ramp') {
            const span = event.when - valueWhen;
            if (when < event.when) {
              const ratio = span > 0 ? Math.min(1, Math.max(0, (when - valueWhen) / span)) : 1;
              return value + (event.value - value) * ratio;
            }
            value = event.value;
            valueWhen = event.when;
            continue;
          }
          if (event.when > when) break;
          value = event.value;
          valueWhen = event.when;
        }
        return value;
      }

      const gain: FakeGainNode = {
        gain: {
          get value() {
            return valueAt(context.currentTime);
          },
          set value(value: number) {
            baseValue = value;
            automation = [];
          },
          cancelScheduledValues(when) {
            automation = automation.filter((event) => event.when < when);
            context.gainEvents.push({ kind: 'cancel', when });
          },
          cancelAndHoldAtTime(when) {
            const held = valueAt(when);
            automation = automation.filter((event) => event.when < when);
            automation.push({ kind: 'set', value: held, when });
            context.gainEvents.push({ kind: 'hold', value: held, when });
          },
          setValueAtTime(value, when) {
            automation = automation.filter((event) => event.when < when);
            automation.push({ kind: 'set', value, when });
            context.gainEvents.push({ kind: 'set', value, when });
          },
          linearRampToValueAtTime(value, when) {
            automation.push({ kind: 'ramp', value, when });
            context.gainEvents.push({ kind: 'ramp', value, when });
          },
        },
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
        startOffset: 0,
        stopped: false,
        connections: [],
        connect(target) {
          node.connections.push(target);
        },
        disconnect() {
          // Connections are kept for assertions; nothing to undo.
        },
        start(_when = 0, offset = 0) {
          node.started = true;
          node.startOffset = offset;
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
