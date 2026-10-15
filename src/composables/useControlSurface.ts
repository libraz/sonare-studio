import type { ComputedRef, Ref } from 'vue';
import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import type { MeterListener, MeterSource } from '@/engine/meters';
import {
  listenMidiMessages,
  listenStateChange,
  type MidiAccessLike,
  type MidiOutputLike,
  midiNavigator,
  midiPortInfos,
} from '@/lib/web-midi';
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
import { meterFraction } from '@/ui/mixer/meter-model';
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
  /** Live engine meter source for a track, for the strip meters. */
  trackMeterSource?: (trackId: number) => MeterSource | null;
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

/** One V-Pot detent, expressed in the 0..127 control range a slot takes. */
const VPOT_STEP = 1;

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
  let meterFrame: number | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let decoder: SurfaceDecoder = createSurfaceDecoder('none');
  let lastSent: SurfaceSnapshot | null = null;
  /** Latest normalized meter fraction for each track in the current bank. */
  const meterValues = new Map<number, number>();
  /** Sources currently subscribed for the current bank. */
  const meterSources = new Map<number, MeterSource>();
  const meterSubscriptions = new Map<
    MeterSource,
    { trackIds: Set<number>; unsubscribe: (() => void) | null }
  >();
  const meterSourceIds = new WeakMap<object, number>();
  let nextMeterSourceId = 1;
  let meterBindingGeneration = 0;
  let rebindingMeters = false;
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
    if (disposed) return;
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

  /** Converts one stereo peak reading to the surface's normalized meter level. */
  function meterFractionFor(source: MeterSource): number {
    const levels = source.latest;
    // meterFraction owns the shared dB-floor and clamping rules used by the UI
    // meters. Taking the louder channel keeps a stereo strip readable when one
    // side carries the signal and the other is silent.
    return meterFraction(Math.max(levels.peakDbL, levels.peakDbR));
  }

  /** Returns a stable identity token so a reactive source change can rebind. */
  function meterSourceId(source: MeterSource | null): number {
    if (source === null) return 0;
    const object = source as object;
    const existing = meterSourceIds.get(object);
    if (existing !== undefined) return existing;
    const id = nextMeterSourceId;
    nextMeterSourceId += 1;
    meterSourceIds.set(object, id);
    return id;
  }

  /** Track ids currently visible on the native surface's physical strips. */
  function currentMeterTrackIds(): Array<number | null> {
    const store = useProjectStore();
    return bankWindow(
      store.tracks.map((track) => track.id),
      settings.value.bankOffset,
      stripCount(),
    );
  }

  /**
   * Reactive identity of the current bank and its live meter sources. Calling
   * the source resolver here is intentional: the resolver normally reads the
   * reactive engine bridge, so an engine replacement causes a rebind even when
   * the project tracks and surface settings stay unchanged.
   */
  function meterBindingSignature(): string {
    const surface = settings.value;
    const trackIds = currentMeterTrackIds();
    const resolveMeterSource = options.trackMeterSource;
    const sourceIds = resolveMeterSource
      ? trackIds.map((trackId) =>
          trackId === null ? 0 : meterSourceId(resolveMeterSource(trackId)),
        )
      : [];
    return JSON.stringify({
      protocol: surface.protocol,
      feedback: surface.feedback,
      bank: `${surface.bankOffset}|${surface.bankSize}|${trackIds.join(',')}`,
      sourceIds,
    });
  }

  function clearMeterSubscriptions(): void {
    meterBindingGeneration += 1;
    for (const subscription of meterSubscriptions.values()) subscription.unsubscribe?.();
    meterSubscriptions.clear();
    meterSources.clear();
    meterValues.clear();
  }

  /** Rebinds only the sources for the strips currently shown by the surface. */
  function rebindMeterSources(): void {
    clearMeterSubscriptions();
    if (disposed || !settings.value.feedback || settings.value.protocol === 'none') return;

    const generation = meterBindingGeneration;
    const trackIds = currentMeterTrackIds();
    rebindingMeters = true;
    try {
      for (const trackId of trackIds) {
        if (trackId === null) continue;
        const source = options.trackMeterSource?.(trackId) ?? null;
        meterValues.set(
          trackId,
          source ? meterFractionFor(source) : (options.trackMeter?.(trackId) ?? 0),
        );
        if (!source) continue;

        meterSources.set(trackId, source);
        const existing = meterSubscriptions.get(source);
        if (existing) {
          existing.trackIds.add(trackId);
          continue;
        }
        const subscription: {
          trackIds: Set<number>;
          unsubscribe: (() => void) | null;
        } = { trackIds: new Set([trackId]), unsubscribe: null };
        meterSubscriptions.set(source, subscription);
        const listener: MeterListener = (levels): void => {
          if (disposed || generation !== meterBindingGeneration) {
            return;
          }
          const next = meterFraction(Math.max(levels.peakDbL, levels.peakDbR));
          let changed = false;
          for (const subscribedTrackId of subscription.trackIds) {
            if (meterSources.get(subscribedTrackId) !== source) continue;
            if (meterValues.get(subscribedTrackId) === next) continue;
            meterValues.set(subscribedTrackId, next);
            changed = true;
          }
          if (changed && !rebindingMeters) scheduleMeterFeedback();
        };
        subscription.unsubscribe = source.subscribe(listener);
      }
    } finally {
      rebindingMeters = false;
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
    const trackById = new Map(store.tracks.map((track) => [track.id, track]));
    const strips: Array<SurfaceStripSnapshot | null> = window.map((trackId) => {
      if (trackId === null) return null;
      const track = trackById.get(trackId);
      if (!track) return null;
      return {
        fader: gainDbToFaderPosition(track.mixer?.gainDb ?? 0),
        pan: panToRingPosition(track.mixer?.pan ?? 0),
        mute: track.mute === true,
        solo: track.solo === true,
        armed: armed.has(trackId),
        selected: store.activeTrackId === trackId,
        meter: meterValues.get(trackId) ?? options.trackMeter?.(trackId) ?? 0,
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

  /** Meter records arrive per target; one diffed push per frame covers them all. */
  function scheduleMeterFeedback(): void {
    if (meterFrame !== null) return;
    meterFrame = requestAnimationFrame(() => {
      meterFrame = null;
      pushFeedback(false);
    });
  }

  function pushFeedback(force: boolean): void {
    if (disposed) return;
    if (!settings.value.feedback || settings.value.protocol === 'none') return;
    const next = snapshot();
    const items = surfaceFeedbackDiff(force ? null : lastSent, next);
    lastSent = next;
    for (const item of items) send(encodeSurfaceFeedback(settings.value.protocol, item));
  }

  /**
   * Leaves a physical surface in a harmless neutral state before this binding
   * stops driving it. This must run before `disposed` flips because `send()`
   * deliberately rejects all output after disposal.
   */
  function resetFeedback(protocol: ControlSurfaceProtocol): void {
    if (protocol === 'none' || lastSent === null) return;
    for (const item of surfaceResetFeedback(stripCount())) {
      send(encodeSurfaceFeedback(protocol, item));
    }
    lastSent = null;
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
    if (disposed || settings.value.protocol === 'none') return;
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
    detachInput = listenMidiMessages(input, listener);
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
    const nav = midiNavigator();
    if (typeof nav.requestMIDIAccess !== 'function') {
      available.value = false;
      return false;
    }
    const needsSysEx = surfaceRequiresSysEx(settings.value.protocol);
    // HUI cannot work without SysEx, so a protocol switch has to re-request
    // access with the wider scope rather than reuse the narrower grant.
    if (access && (!needsSysEx || accessHasSysEx)) {
      available.value = true;
      inputs.value = midiPortInfos(access.inputs);
      outputs.value = midiPortInfos(access.outputs);
      attach();
      return true;
    }
    try {
      const granted = await nav.requestMIDIAccess({ sysex: needsSysEx });
      if (disposed) return false;
      detachStateChange?.();
      access = granted;
      accessHasSysEx = needsSysEx;
      detachStateChange = listenStateChange(granted, () => {
        if (disposed || access !== granted) return;
        inputs.value = midiPortInfos(granted.inputs);
        outputs.value = midiPortInfos(granted.outputs);
        attach();
      });
      available.value = true;
      inputs.value = midiPortInfos(granted.inputs);
      outputs.value = midiPortInfos(granted.outputs);
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
      if (leaving !== undefined) resetFeedback(leaving);
      if (access) void refresh();
    },
  );

  // Meter sources are live subscriptions rather than one-shot reads. Rebind
  // when the bank/track topology, feedback mode, protocol, or engine-provided
  // source identities change; a source callback handles level-only changes.
  watch(
    meterBindingSignature,
    (next, previous) => {
      const nextState = JSON.parse(next) as {
        protocol: ControlSurfaceProtocol;
        feedback: boolean;
        bank: string;
      };
      const previousState = previous
        ? (JSON.parse(previous) as {
            protocol: ControlSurfaceProtocol;
            feedback: boolean;
            bank: string;
          })
        : null;
      rebindMeterSources();
      if (!nextState.feedback || nextState.protocol === 'none') return;
      if (!previousState) {
        pushFeedback(true);
      } else if (nextState.protocol !== previousState.protocol) {
        // The protocol watcher above re-attaches and performs the full push.
        return;
      } else if (
        nextState.bank !== previousState.bank ||
        nextState.feedback !== previousState.feedback
      ) {
        // A bank/topology change points every physical strip at a new track;
        // enabling feedback also needs a complete initial state.
        pushFeedback(true);
      } else {
        // A new engine/source has the same strip topology; reflect its latest
        // reading without needlessly re-driving every motor fader and lamp.
        pushFeedback(false);
      }
    },
    { immediate: true },
  );

  // Mirror mixer and transport state back to the surface as it changes.
  watch(
    () =>
      settings.value.feedback && settings.value.protocol !== 'none'
        ? JSON.stringify(snapshot())
        : '',
    () => pushFeedback(false),
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      // A scoped composable is normally torn down when the app/session is
      // replaced. Explicitly clear motor faders, lamps, meters, and rings so
      // hardware never keeps displaying that no-longer-live session.
      resetFeedback(settings.value.protocol);
      disposed = true;
      if (meterFrame !== null) cancelAnimationFrame(meterFrame);
      meterFrame = null;
      clearMeterSubscriptions();
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
