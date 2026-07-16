import type { Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { ensureWasm } from '@/lib/wasm';
import { MidiCc14BitTracker } from '@/ui/midi/midi-cc-input';
import type { RealtimeEngine, WebMidiBinding, WebMidiInputInfo } from '@/wasm/index.js';

// Structural input/event types derived from the binding so they stay in sync
// with the library (MidiInputLike / MidiMessageEventLike are not exported).
type MidiAccessInputs = WebMidiBinding['access']['inputs'];
type MidiInputEntry = MidiAccessInputs extends Iterable<infer E> ? E : never;
type MidiInputLike = MidiInputEntry extends readonly [string, infer I] ? I : never;
type MidiMessageListener = NonNullable<MidiInputLike['onmidimessage']>;
type MidiMessageEventLike = Parameters<MidiMessageListener>[0];

/** MIDI 1.0 status nibbles. */
const STATUS_NOTE_OFF = 0x80;
const STATUS_NOTE_ON = 0x90;
const STATUS_POLY_PRESSURE = 0xa0;
const STATUS_CONTROL_CHANGE = 0xb0;
const STATUS_PROGRAM_CHANGE = 0xc0;
const STATUS_CHANNEL_PRESSURE = 0xd0;
const STATUS_PITCH_BEND = 0xe0;

/** A note-on or note-off received from a Web MIDI input. */
export interface WebMidiNoteEvent {
  /** MIDI note number (0-127). */
  pitch: number;
  /** Velocity (note-on velocity, or release velocity for note-offs). */
  velocity: number;
  /** MIDI channel (0-15). */
  channel: number;
  /** Web MIDI event timestamp in milliseconds, when provided by the browser. */
  timeStampMs?: number;
}

/** A control-change (CC) message received from a Web MIDI input. */
export interface WebMidiCcEvent {
  /** Controller number (0-127). */
  controller: number;
  /** Controller value (0-127). */
  value: number;
  /** Combined 14-bit controller value (0-16383), when an MSB/LSB pair is available. */
  value14?: number;
  /** Binding family for decoded parameter input. Omitted means plain CC. */
  kind?: 'cc' | 'rpn' | 'nrpn';
  /** RPN/NRPN parameter number (0-16383), when `kind` is not `cc`. */
  parameter?: number;
  /** MIDI channel (0-15). */
  channel: number;
  /** Web MIDI event timestamp in milliseconds, when provided by the browser. */
  timeStampMs?: number;
}

/** A pitch-bend message received from a Web MIDI input. */
export interface WebMidiPitchBendEvent {
  /** MIDI pitch-bend value (0-16383, center = 8192). */
  value: number;
  /** MIDI channel (0-15). */
  channel: number;
  /** Web MIDI event timestamp in milliseconds, when provided by the browser. */
  timeStampMs?: number;
}

/** A program-change message received from a Web MIDI input. */
export interface WebMidiProgramChangeEvent {
  /** Program number (0-127). */
  program: number;
  /** MIDI channel (0-15). */
  channel: number;
  /** Web MIDI event timestamp in milliseconds, when provided by the browser. */
  timeStampMs?: number;
}

/** A channel-pressure message received from a Web MIDI input. */
export interface WebMidiChannelPressureEvent {
  /** Pressure value (0-127). */
  value: number;
  /** MIDI channel (0-15). */
  channel: number;
  /** Web MIDI event timestamp in milliseconds, when provided by the browser. */
  timeStampMs?: number;
}

/** A polyphonic key-pressure message received from a Web MIDI input. */
export interface WebMidiPolyPressureEvent extends WebMidiChannelPressureEvent {
  /** MIDI note number (0-127). */
  pitch: number;
}

/** Options for {@link useWebMidi}. */
export interface UseWebMidiOptions {
  /** Realtime-engine MIDI destination receiving the live input. Default 0. */
  destinationId?: number;
  /** Called for each incoming note-on (velocity > 0). */
  onNoteOn?: (event: WebMidiNoteEvent) => void;
  /** Called for each incoming note-off (including note-on with velocity 0). */
  onNoteOff?: (event: WebMidiNoteEvent) => void;
  /** Called for each incoming control-change message (for MIDI learn). */
  onControlChange?: (event: WebMidiCcEvent) => void;
  /** Called for each incoming pitch-bend message. */
  onPitchBend?: (event: WebMidiPitchBendEvent) => void;
  /** Called for each incoming program-change message. */
  onProgramChange?: (event: WebMidiProgramChangeEvent) => void;
  /** Called for each incoming channel-pressure message. */
  onChannelPressure?: (event: WebMidiChannelPressureEvent) => void;
  /** Called for each incoming polyphonic key-pressure message. */
  onPolyPressure?: (event: WebMidiPolyPressureEvent) => void;
}

/** Reactive Web MIDI state and controls returned by {@link useWebMidi}. */
export interface WebMidiHandle {
  /** Web MIDI availability; null until the first connect() resolves it. */
  available: Ref<boolean | null>;
  /** Currently known MIDI inputs (kept fresh across hot-plug). */
  inputs: Ref<WebMidiInputInfo[]>;
  /**
   * Restricts binding to one input id; null = all inputs. Changing this while
   * connected rebinds automatically.
   */
  selectedInputId: Ref<string | null>;
  /** True while a binding to the engine is active. */
  connected: Ref<boolean>;
  /** Message of the last connect failure, or null. */
  error: Ref<string | null>;
  /**
   * Requests MIDI access and binds the inputs to the engine's MIDI
   * destination. Degrades gracefully: resolves false (with `available` /
   * `error` updated) instead of throwing when Web MIDI is unavailable or the
   * permission is denied.
   *
   * @param engine Realtime engine receiving the live MIDI input source.
   * @returns True when the binding is active.
   */
  connect(engine: RealtimeEngine): Promise<boolean>;
  /** Closes the binding and detaches the note listeners. Idempotent. */
  disconnect(): void;
}

/**
 * Vue composable wrapping libsonare's bindWebMidi.
 *
 * The binding routes live input into the engine (audible through the engine's
 * instrument); on top of that, this composable attaches its own `midimessage`
 * listeners to the bound inputs and decodes note-on/note-off so the editor
 * (step input, indicators) can observe what is being played.
 *
 * The binding is closed automatically when the owning effect scope disposes.
 *
 * @param options Destination id and note callbacks.
 * @returns Reactive Web MIDI state and connect/disconnect controls.
 */
export function useWebMidi(options: UseWebMidiOptions = {}): WebMidiHandle {
  const available = ref<boolean | null>(null);
  const inputs = ref<WebMidiInputInfo[]>([]);
  const selectedInputId = ref<string | null>(null);
  const connected = ref(false);
  const error = ref<string | null>(null);

  let binding: WebMidiBinding | null = null;
  let boundEngine: RealtimeEngine | null = null;
  let detachListeners: Array<() => void> = [];
  let generation = 0;
  let disposed = false;
  const ccTracker = new MidiCc14BitTracker();

  function handleMessage(event: MidiMessageEventLike): void {
    const data = event.data;
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const pitch = data[1] & 0x7f;
    const velocity = (data[2] ?? 0) & 0x7f;
    const timeStampMs = Number.isFinite(event.timeStamp) ? event.timeStamp : undefined;
    if (status === STATUS_NOTE_ON && velocity > 0) {
      options.onNoteOn?.({ pitch, velocity, channel, timeStampMs });
    } else if (status === STATUS_NOTE_OFF || status === STATUS_NOTE_ON) {
      // A note-on with velocity 0 is a note-off per MIDI 1.0 semantics.
      options.onNoteOff?.({
        pitch,
        velocity: status === STATUS_NOTE_OFF ? velocity : 0,
        channel,
        timeStampMs,
      });
    } else if (status === STATUS_CONTROL_CHANGE) {
      options.onControlChange?.({ ...ccTracker.decode(channel, pitch, velocity), timeStampMs });
    } else if (status === STATUS_PROGRAM_CHANGE) {
      options.onProgramChange?.({ program: pitch, channel, timeStampMs });
    } else if (status === STATUS_POLY_PRESSURE) {
      options.onPolyPressure?.({ pitch, value: velocity, channel, timeStampMs });
    } else if (status === STATUS_CHANNEL_PRESSURE) {
      options.onChannelPressure?.({ value: pitch, channel, timeStampMs });
    } else if (status === STATUS_PITCH_BEND) {
      options.onPitchBend?.({ value: pitch | (velocity << 7), channel, timeStampMs });
    }
  }

  function removeNoteListeners(): void {
    for (const detach of detachListeners) {
      try {
        detach();
      } catch {
        // One broken input must not retain listeners on the remaining ports.
      }
    }
    detachListeners = [];
  }

  /** (Re-)attaches midimessage listeners to the inputs matching the selection. */
  function attachNoteListeners(target = binding): void {
    removeNoteListeners();
    if (!target || disposed) return;
    for (const [id, input] of target.access.inputs) {
      if (selectedInputId.value !== null && id !== selectedInputId.value) continue;
      if (input.addEventListener && input.removeEventListener) {
        input.addEventListener('midimessage', handleMessage);
        const remove = input.removeEventListener;
        detachListeners.push(() => remove.call(input, 'midimessage', handleMessage));
      } else {
        // No EventTarget API: chain onto the handler the binding installed.
        const previous = input.onmidimessage;
        input.onmidimessage = (event) => {
          previous?.(event);
          handleMessage(event);
        };
        detachListeners.push(() => {
          input.onmidimessage = previous;
        });
      }
    }
  }

  function disconnect(): void {
    generation += 1;
    removeNoteListeners();
    const previous = binding;
    binding = null;
    try {
      previous?.close();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      boundEngine = null;
      connected.value = false;
    }
  }

  async function connect(engine: RealtimeEngine): Promise<boolean> {
    if (disposed) return false;
    error.value = null;
    disconnect();
    const connectGeneration = generation;
    const selectedId = selectedInputId.value;
    const active = (): boolean =>
      !disposed &&
      generation === connectGeneration &&
      selectedInputId.value === selectedId &&
      (boundEngine === null || boundEngine === engine);
    try {
      const wasm = await ensureWasm();
      if (!active()) return false;
      available.value = wasm.isWebMidiAvailable();
      if (!available.value) return false;
      let createdBinding: WebMidiBinding | null = null;
      const created = await wasm.bindWebMidi(engine, {
        destinationId: options.destinationId,
        ...(selectedId !== null ? { inputIds: [selectedId] } : {}),
        onInputsChanged: (list) => {
          if (!active() || !createdBinding || binding !== createdBinding) return;
          inputs.value = list;
          attachNoteListeners(createdBinding);
        },
      });
      createdBinding = created;
      if (!active()) {
        try {
          created.close();
        } catch {
          // The stale binding is never published; continue invalidation.
        }
        return false;
      }
      binding = created;
      boundEngine = engine;
      inputs.value = created.inputs();
      attachNoteListeners(created);
      connected.value = true;
      return true;
    } catch (err) {
      if (!active()) return false;
      error.value = err instanceof Error ? err.message : String(err);
      disconnect();
      return false;
    }
  }

  // Changing the input selection while connected rebinds so the engine route
  // and the note listeners both follow the new restriction.
  watch(selectedInputId, () => {
    if (connected.value && boundEngine) {
      void connect(boundEngine);
    }
  });

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      disconnect();
    });
  }

  return { available, inputs, selectedInputId, connected, error, connect, disconnect };
}
