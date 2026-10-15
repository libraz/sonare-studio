import { getCurrentScope, onScopeDispose, type Ref, ref } from 'vue';
import type { WebMidiOutputInfo } from '@/engine/web-midi-output';
import { errorMessage } from '@/lib/errors';
import {
  listenStateChange,
  type MidiAccessLike,
  midiNavigator,
  midiPortInfos,
} from '@/lib/web-midi';

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

/**
 * Creates a Web MIDI output enumeration handle. The statechange listener is
 * detached automatically when the owning effect scope disposes.
 */
export function useWebMidiOutputs(): WebMidiOutputsHandle {
  const available = ref<boolean | null>(null);
  const outputs = ref<WebMidiOutputInfo[]>([]);
  const error = ref<string | null>(null);

  let access: MidiAccessLike | null = null;
  let stopListening: (() => void) | null = null;
  let generation = 0;
  let disposed = false;

  const collect = (): void => {
    outputs.value = midiPortInfos(access?.outputs);
  };

  const detach = (): void => {
    try {
      stopListening?.();
    } catch {
      // Clear local ownership even when a browser/driver listener removal fails.
    } finally {
      stopListening = null;
    }
  };

  async function refresh(): Promise<boolean> {
    if (disposed) return false;
    error.value = null;
    const nav = midiNavigator();
    if (typeof nav.requestMIDIAccess !== 'function') {
      available.value = false;
      return false;
    }
    if (access) {
      available.value = true;
      collect();
      return true;
    }
    const refreshGeneration = ++generation;
    try {
      const granted = await nav.requestMIDIAccess({ sysex: false });
      if (disposed || generation !== refreshGeneration) return false;
      access = granted;
      stopListening = listenStateChange(granted, () => {
        if (disposed || access !== granted || generation !== refreshGeneration) return;
        collect();
      });
      available.value = true;
      collect();
      return true;
    } catch (err) {
      if (disposed || generation !== refreshGeneration) return false;
      available.value = false;
      error.value = errorMessage(err);
      return false;
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      generation += 1;
      detach();
      access = null;
      outputs.value = [];
    });
  }

  return { available, outputs, error, refresh };
}
