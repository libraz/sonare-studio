import { getCurrentScope, onScopeDispose, type Ref, ref } from 'vue';
import type { WebMidiOutputInfo } from '@/engine/web-midi-output';

/**
 * Reactive Web MIDI output-port enumeration for pickers (e.g. the External MIDI
 * instrument slot). Independent of the engine: it only lists ports so the user
 * can choose one; actual delivery is the engine's web-midi-output bridge.
 */
export interface WebMidiOutputsHandle {
  /** Availability; null until refresh() resolves it, then boolean. */
  available: Ref<boolean | null>;
  /** Known output ports, kept fresh across hot-plug while connected. */
  outputs: Ref<WebMidiOutputInfo[]>;
  /** Message of the last access failure, or null. */
  error: Ref<string | null>;
  /**
   * Requests MIDI access and populates {@link outputs}. Degrades gracefully:
   * resolves false (with available/error updated) instead of throwing when Web
   * MIDI is unavailable or permission is denied. Idempotent.
   */
  refresh(): Promise<boolean>;
}

interface MidiOutputLike {
  id: string;
  name?: string | null;
}
interface MidiAccessLike {
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((event: unknown) => void) | null;
  addEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
}
interface NavigatorWithMidi {
  requestMIDIAccess?(options?: { sysex?: boolean }): Promise<MidiAccessLike>;
}

/**
 * Creates a Web MIDI output enumeration handle. The statechange listener is
 * detached automatically when the owning effect scope disposes.
 */
export function useWebMidiOutputs(): WebMidiOutputsHandle {
  const available = ref<boolean | null>(null);
  const outputs = ref<WebMidiOutputInfo[]>([]);
  const error = ref<string | null>(null);

  let access: MidiAccessLike | null = null;
  let onChange: (() => void) | null = null;

  const collect = (): void => {
    outputs.value = access
      ? [...access.outputs.values()].map((port) => ({ id: port.id, name: port.name ?? port.id }))
      : [];
  };

  const detach = (): void => {
    if (access && onChange) {
      if (access.removeEventListener) access.removeEventListener('statechange', onChange);
      else access.onstatechange = null;
    }
    onChange = null;
  };

  async function refresh(): Promise<boolean> {
    error.value = null;
    const nav = navigator as unknown as NavigatorWithMidi;
    if (typeof nav.requestMIDIAccess !== 'function') {
      available.value = false;
      return false;
    }
    try {
      if (!access) {
        access = await nav.requestMIDIAccess({ sysex: false });
        onChange = collect;
        if (access.addEventListener) access.addEventListener('statechange', onChange);
        else access.onstatechange = onChange;
      }
      available.value = true;
      collect();
      return true;
    } catch (err) {
      available.value = false;
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(detach);
  }

  return { available, outputs, error, refresh };
}
