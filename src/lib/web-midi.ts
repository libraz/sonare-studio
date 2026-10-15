/**
 * Structural Web MIDI types and listener plumbing shared by the input,
 * output and control-surface paths. The DOM lib does not declare Web MIDI,
 * and the structural shapes avoid a dependency on @types/webmidi.
 */

/** A MIDI port as exposed by `MIDIAccess`. */
export interface MidiPortLike {
  id: string;
  name?: string | null;
}

/** A MIDI output port. */
export interface MidiOutputLike extends MidiPortLike {
  send(data: number[] | Uint8Array, timestamp?: number): void;
}

/** A raw message event from an input port. */
export interface MidiMessageEvent {
  data?: Uint8Array | null;
}

/** A MIDI input port. */
export interface MidiInputLike extends MidiPortLike {
  onmidimessage: ((event: MidiMessageEvent) => void) | null;
  addEventListener?(type: 'midimessage', listener: (event: MidiMessageEvent) => void): void;
  removeEventListener?(type: 'midimessage', listener: (event: MidiMessageEvent) => void): void;
}

/** The granted `MIDIAccess`. */
export interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((event: unknown) => void) | null;
  addEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
}

/** `navigator` as far as Web MIDI is concerned. */
export interface NavigatorWithMidi {
  requestMIDIAccess?(options?: { sysex?: boolean }): Promise<MidiAccessLike>;
}

/** The global navigator viewed through its optional Web MIDI surface. */
export function midiNavigator(): NavigatorWithMidi {
  return navigator as unknown as NavigatorWithMidi;
}

/** Port id/name pairs for UI lists; an unnamed port shows its id. */
export function midiPortInfos(
  ports: ReadonlyMap<string, MidiPortLike> | undefined,
): { id: string; name: string }[] {
  return ports
    ? [...ports.values()].map((port) => ({ id: port.id, name: port.name ?? port.id }))
    : [];
}

/**
 * Listens for messages on an input, through `addEventListener` when the port
 * has the EventTarget API and by chaining `onmidimessage` otherwise.
 *
 * @returns A function removing exactly this listener.
 */
export function listenMidiMessages<E>(
  input: {
    onmidimessage: ((event: E) => void) | null;
    addEventListener?: (type: 'midimessage', listener: (event: E) => void) => void;
    removeEventListener?: (type: 'midimessage', listener: (event: E) => void) => void;
  },
  listener: (event: E) => void,
): () => void {
  const { addEventListener, removeEventListener } = input;
  if (addEventListener && removeEventListener) {
    addEventListener.call(input, 'midimessage', listener);
    return () => removeEventListener.call(input, 'midimessage', listener);
  }
  const previous = input.onmidimessage;
  input.onmidimessage = (event) => {
    previous?.(event);
    listener(event);
  };
  return () => {
    input.onmidimessage = previous;
  };
}

/**
 * Listens for port connect/disconnect on an access object, through
 * `addEventListener` when available and by chaining `onstatechange` otherwise.
 *
 * @returns A function removing exactly this listener.
 */
export function listenStateChange(
  access: Pick<MidiAccessLike, 'onstatechange' | 'addEventListener' | 'removeEventListener'>,
  listener: (event: unknown) => void,
): () => void {
  const { addEventListener, removeEventListener } = access;
  if (addEventListener && removeEventListener) {
    addEventListener.call(access, 'statechange', listener);
    return () => removeEventListener.call(access, 'statechange', listener);
  }
  const previous = access.onstatechange;
  access.onstatechange = (event) => {
    previous?.(event);
    listener(event);
  };
  return () => {
    access.onstatechange = previous;
  };
}
