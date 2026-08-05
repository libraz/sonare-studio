import type { ComputedRef, Ref } from 'vue';
import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import {
  bankSlotTrackId,
  bankWindow,
  type ControlSurfaceProtocol,
} from '@/project/control-surface';
import { useProjectStore } from '@/project/store';
import type { MidiLearnTransportAction } from '@/ui/midi/midi-learn';
import {
  gainDbToFaderPosition,
  midiLearnBankTargetId,
  midiLearnTargetId,
  panToCc,
  panToRingPosition,
} from '@/ui/midi/midi-learn';
import {
  type SurfaceSnapshot,
  type SurfaceStripSnapshot,
  surfaceFeedbackDiff,
  surfaceResetFeedback,
} from '@/ui/midi/surface-feedback';
import {
  createSurfaceDecoder,
  encodeSurfaceFeedback,
  SURFACE_KEEP_ALIVE_INTERVAL_MS,
  SURFACE_STRIP_COUNT,
  type SurfaceDecoder,
  type SurfaceEvent,
  surfaceKeepAlive,
  surfaceRequiresSysEx,
} from '@/ui/midi/surface-protocol';
import type { MidiLearnHandle } from './useMidiLearn';

/** A Web MIDI port as the surface pickers show it. */
export interface ControlSurfacePort {
  /** Web MIDI port id. */
  id: string;
  /** Human-readable port name. */
  name: string;
}

/** Session state and actions a surface drives or reflects. */
export interface ControlSurfaceOptions {
  /** Learn handle owning the bank window and the slot dispatch. */
  learn: MidiLearnHandle;
  /** Transport actions the surface's transport buttons invoke. */
  transport?: Partial<Record<MidiLearnTransportAction, () => void>>;
  /** Moves the playhead back (a surface REWIND button). */
  rewind?: () => void;
  /** Moves the playhead forward (a surface FAST-FORWARD button). */
  forward?: () => void;
  /** Toggles a track's record arm. */
  toggleTrackArm?: (trackId: number) => void;
  /** Focuses a track. */
  selectTrack?: (trackId: number) => void;
  /** True while the transport rolls (drives the PLAY lamp). */
  isPlaying?: Ref<boolean>;
  /** True while recording (drives the RECORD lamp). */
  isRecording?: Ref<boolean>;
  /** True while cycle is enabled (drives the CYCLE lamp). */
  isLooping?: Ref<boolean>;
  /** Currently record-armed tracks (drives the ARM lamps). */
  armedTrackIds?: Ref<readonly number[]>;
  /** Normalized 0..1 output level of a track, for the strip meters. */
  trackMeter?: (trackId: number) => number;
}

/** Reactive control-surface state returned by {@link useControlSurface}. */
export interface ControlSurfaceHandle {
  /** Web MIDI availability; null until refresh() resolves it. */
  available: Ref<boolean | null>;
  /** Known input ports. */
  inputs: Ref<ControlSurfacePort[]>;
  /** Known output ports. */
  outputs: Ref<ControlSurfacePort[]>;
  /** Message of the last access failure, or null. */
  error: Ref<string | null>;
  /** True while a protocol is selected and its input port is attached. */
  connected: Ref<boolean>;
  /**
   * Input ids the musical path must ignore. A surface reports its buttons as
   * note-ons, so leaving its port in the instrument route would make every
   * button press audible.
   */
  excludedInputIds: ComputedRef<string[]>;
  /** Requests MIDI access and (re-)attaches to the configured ports. */
  refresh(): Promise<boolean>;
  /** Handles one raw message from the surface. */
  handleMessage(bytes: readonly number[]): void;
  /** Pushes the full current state to the surface, ignoring the diff. */
  refreshFeedback(): void;
}

interface MidiPortLike {
  id: string;
  name?: string | null;
}
interface MidiOutputLike extends MidiPortLike {
  send(data: number[]): void;
}
interface MidiInputLike extends MidiPortLike {
  onmidimessage: ((event: { data?: Uint8Array | null }) => void) | null;
  addEventListener?(
    type: 'midimessage',
    listener: (event: { data?: Uint8Array | null }) => void,
  ): void;
  removeEventListener?(
    type: 'midimessage',
    listener: (event: { data?: Uint8Array | null }) => void,
  ): void;
}
interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((event: unknown) => void) | null;
  addEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
  removeEventListener?(type: 'statechange', listener: (event: unknown) => void): void;
}
interface NavigatorWithMidi {
  requestMIDIAccess?(options?: { sysex?: boolean }): Promise<MidiAccessLike>;
}

/** One V-Pot detent, expressed in the 0..127 control range a slot takes. */
const VPOT_STEP = 1;

function ports(map: Map<string, MidiPortLike> | undefined): ControlSurfacePort[] {
  return map ? [...map.values()].map((port) => ({ id: port.id, name: port.name ?? port.id })) : [];
}

/**
 * Native control-surface support: decodes a Mackie Control or HUI surface into
 * mixer actions and mirrors the mixer back onto its faders and lamps.
 *
 * The surface owns its own Web MIDI access rather than sharing the musical one:
 * HUI needs SysEx permission that the instrument path deliberately does not ask
 * for, and the surface port must stay out of the instrument route entirely.
 * Unlike MIDI learn, nothing here is learned — both protocols have a fixed
 * layout, so a configured surface works without binding anything.
 *
 * @param options Learn handle plus the session state the surface reflects.
 * @returns Reactive port lists and the attach/feedback controls.
 */
export function useControlSurface(options: ControlSurfaceOptions): ControlSurfaceHandle {
  const available = ref<boolean | null>(null);
  const inputs = ref<ControlSurfacePort[]>([]);
  const outputs = ref<ControlSurfacePort[]>([]);
  const error = ref<string | null>(null);
  const connected = ref(false);

  let access: MidiAccessLike | null = null;
  let accessHasSysEx = false;
  let detachInput: (() => void) | null = null;
  let detachStateChange: (() => void) | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let decoder: SurfaceDecoder = createSurfaceDecoder('none');
  let lastSent: SurfaceSnapshot | null = null;
  let disposed = false;

  const settings = computed(() => useProjectStore().controlSurface);

  const excludedInputIds = computed(() => {
    const { protocol, inputPortId } = settings.value;
    return protocol === 'none' || inputPortId === null ? [] : [inputPortId];
  });

  /** Number of strips the current protocol and configuration address. */
  function stripCount(): number {
    return Math.min(SURFACE_STRIP_COUNT, settings.value.bankSize);
  }

  /** Output port feedback is written to, or null when unconfigured. */
  function outputPort(): MidiOutputLike | null {
    const id = settings.value.outputPortId;
    if (!access || id === null) return null;
    return access.outputs.get(id) ?? null;
  }

  function send(messages: ReadonlyArray<number[]>): void {
    const port = outputPort();
    if (!port) return;
    for (const message of messages) {
      try {
        port.send(message);
      } catch (err) {
        // A port that has gone away must not break the remaining messages or
        // the state watcher that produced them.
        error.value = err instanceof Error ? err.message : String(err);
        return;
      }
    }
  }

  /** Builds what the surface should currently be showing. */
  function snapshot(): SurfaceSnapshot {
    const store = useProjectStore();
    const surface = settings.value;
    const armed = new Set(options.armedTrackIds?.value ?? []);
    const window = bankWindow(
      store.tracks.map((track) => track.id),
      surface.bankOffset,
      stripCount(),
    );
    const strips: Array<SurfaceStripSnapshot | null> = window.map((trackId) => {
      if (trackId === null) return null;
      const track = store.tracks.find((entry) => entry.id === trackId);
      if (!track) return null;
      return {
        fader: gainDbToFaderPosition(track.mixer?.gainDb ?? 0),
        pan: panToRingPosition(track.mixer?.pan ?? 0),
        mute: track.mute === true,
        solo: track.solo === true,
        armed: armed.has(trackId),
        selected: store.activeTrackId === trackId,
        meter: options.trackMeter?.(trackId) ?? 0,
      };
    });
    return {
      strips,
      master: gainDbToFaderPosition(store.mixer.master.gainDb ?? 0),
      play: options.isPlaying?.value === true,
      record: options.isRecording?.value === true,
      loop: options.isLooping?.value === true,
    };
  }

  function pushFeedback(force: boolean): void {
    if (!settings.value.feedback || settings.value.protocol === 'none') return;
    const next = snapshot();
    const items = surfaceFeedbackDiff(force ? null : lastSent, next);
    lastSent = next;
    for (const item of items) send(encodeSurfaceFeedback(settings.value.protocol, item));
  }

  /** Track a slot addresses right now, or null when the slot is unused. */
  function slotTrackId(slot: number): number | null {
    const store = useProjectStore();
    return bankSlotTrackId(
      store.tracks.map((track) => track.id),
      settings.value.bankOffset,
      settings.value.bankSize,
      slot,
    );
  }

  /** Applies one decoded gesture. */
  function applyEvent(event: SurfaceEvent): void {
    const store = useProjectStore();
    switch (event.kind) {
      case 'ping':
        send(surfaceKeepAlive(settings.value.protocol));
        return;
      case 'fader':
        options.learn.applyTarget(midiLearnBankTargetId(event.slot, 'gain'), event.value * 127);
        return;
      case 'masterFader':
        // The master strip sits outside the bank window; it is the same target
        // a learned fader would drive.
        options.learn.applyTarget(midiLearnTargetId('gain', 'master'), event.value * 127);
        return;
      case 'vpot': {
        const trackId = slotTrackId(event.slot);
        if (trackId === null) return;
        const track = store.tracks.find((entry) => entry.id === trackId);
        const current = panToCc(track?.mixer?.pan ?? 0);
        options.learn.applyTarget(
          midiLearnBankTargetId(event.slot, 'pan'),
          current + event.delta * VPOT_STEP,
        );
        return;
      }
      default:
        applyButton(event);
    }
  }

  /** Applies a button press. Releases are ignored except where noted. */
  function applyButton(event: SurfaceEvent & { kind: 'button' }): void {
    if (!event.pressed) return;
    const store = useProjectStore();
    switch (event.button) {
      case 'play':
      case 'stop':
      case 'record':
        options.transport?.[event.button]?.();
        return;
      case 'loop':
        options.transport?.loop?.();
        return;
      case 'rewind':
        options.rewind?.();
        return;
      case 'forward':
        options.forward?.();
        return;
      case 'bankPrev':
        options.learn.moveBank('prev');
        return;
      case 'bankNext':
        options.learn.moveBank('next');
        return;
      case 'channelPrev':
        options.learn.shiftBank(-1);
        return;
      case 'channelNext':
        options.learn.shiftBank(1);
        return;
      default: {
        const slot = event.slot;
        if (slot === undefined) return;
        const trackId = slotTrackId(slot);
        if (trackId === null) return;
        const track = store.tracks.find((entry) => entry.id === trackId);
        // A surface's strip buttons are momentary, so the press toggles the
        // state rather than latching it the way a learned switch does.
        if (event.button === 'mute') {
          options.learn.applyTarget(
            midiLearnBankTargetId(slot, 'mute'),
            track?.mute === true ? 0 : 127,
          );
        } else if (event.button === 'solo') {
          options.learn.applyTarget(
            midiLearnBankTargetId(slot, 'solo'),
            track?.solo === true ? 0 : 127,
          );
        } else if (event.button === 'arm') {
          options.learn.applyTarget(midiLearnBankTargetId(slot, 'arm'), 127);
        } else if (event.button === 'select') {
          options.learn.applyTarget(midiLearnBankTargetId(slot, 'select'), 127);
        }
      }
    }
  }

  function handleMessage(bytes: readonly number[]): void {
    if (settings.value.protocol === 'none') return;
    for (const event of decoder.decode(bytes)) applyEvent(event);
  }

  function detach(): void {
    detachInput?.();
    detachInput = null;
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    connected.value = false;
  }

  /** Attaches to the configured input port and starts any keep-alive. */
  function attach(): void {
    detach();
    const { protocol, inputPortId } = settings.value;
    decoder = createSurfaceDecoder(protocol);
    lastSent = null;
    if (!access || protocol === 'none' || inputPortId === null) return;
    const input = access.inputs.get(inputPortId);
    if (!input) return;
    const listener = (event: { data?: Uint8Array | null }): void => {
      if (event.data) handleMessage([...event.data]);
    };
    if (input.addEventListener && input.removeEventListener) {
      input.addEventListener('midimessage', listener);
      const remove = input.removeEventListener;
      detachInput = () => remove.call(input, 'midimessage', listener);
    } else {
      const previous = input.onmidimessage;
      input.onmidimessage = (event) => {
        previous?.(event);
        listener(event);
      };
      detachInput = () => {
        input.onmidimessage = previous;
      };
    }
    connected.value = true;
    const keepAlive = surfaceKeepAlive(protocol);
    if (keepAlive.length > 0) {
      keepAliveTimer = setInterval(() => send(keepAlive), SURFACE_KEEP_ALIVE_INTERVAL_MS);
    }
    pushFeedback(true);
  }

  async function refresh(): Promise<boolean> {
    if (disposed) return false;
    error.value = null;
    const nav = navigator as unknown as NavigatorWithMidi;
    if (typeof nav.requestMIDIAccess !== 'function') {
      available.value = false;
      return false;
    }
    const needsSysEx = surfaceRequiresSysEx(settings.value.protocol);
    // HUI cannot work without SysEx, so a protocol switch has to re-request
    // access with the wider scope rather than reuse the narrower grant.
    if (access && (!needsSysEx || accessHasSysEx)) {
      available.value = true;
      inputs.value = ports(access.inputs);
      outputs.value = ports(access.outputs);
      attach();
      return true;
    }
    try {
      const granted = await nav.requestMIDIAccess({ sysex: needsSysEx });
      if (disposed) return false;
      detachStateChange?.();
      access = granted;
      accessHasSysEx = needsSysEx;
      const onChange = (): void => {
        if (disposed || access !== granted) return;
        inputs.value = ports(granted.inputs);
        outputs.value = ports(granted.outputs);
        attach();
      };
      if (granted.addEventListener) {
        granted.addEventListener('statechange', onChange);
        const remove = granted.removeEventListener;
        detachStateChange = () => remove?.call(granted, 'statechange', onChange);
      } else {
        const previous = granted.onstatechange;
        granted.onstatechange = (event) => {
          previous?.(event);
          onChange();
        };
        detachStateChange = () => {
          granted.onstatechange = previous;
        };
      }
      available.value = true;
      inputs.value = ports(granted.inputs);
      outputs.value = ports(granted.outputs);
      attach();
      return true;
    } catch (err) {
      if (disposed) return false;
      available.value = false;
      error.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  // Re-attach whenever the surface identity changes. A protocol change may also
  // need a wider access scope, so it goes back through refresh().
  watch(
    () => `${settings.value.protocol}|${settings.value.inputPortId}`,
    (next, previous) => {
      if (next === previous) return;
      // Leaving a surface behind must not strand its faders and lamps showing a
      // session that no longer drives them, so the reset is encoded with the
      // protocol the surface was still speaking.
      const leaving = previous?.split('|')[0] as ControlSurfaceProtocol | undefined;
      if (leaving !== undefined && leaving !== 'none' && lastSent !== null) {
        for (const item of surfaceResetFeedback(stripCount())) {
          send(encodeSurfaceFeedback(leaving, item));
        }
      }
      lastSent = null;
      if (access) void refresh();
    },
  );

  // Mirror mixer and transport state back to the surface as it changes.
  watch(
    () =>
      settings.value.feedback && settings.value.protocol !== 'none'
        ? JSON.stringify(snapshot())
        : '',
    () => pushFeedback(false),
  );

  // A bank move re-points every strip at once; the surface has to be told in
  // full because its previous positions belong to other tracks now.
  watch(
    () => `${settings.value.bankOffset}|${settings.value.bankSize}|${settings.value.feedback}`,
    () => pushFeedback(true),
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true;
      detach();
      detachStateChange?.();
      detachStateChange = null;
      access = null;
    });
  }

  return {
    available,
    inputs,
    outputs,
    error,
    connected,
    excludedInputIds,
    refresh,
    handleMessage,
    refreshFeedback: () => pushFeedback(true),
  };
}
