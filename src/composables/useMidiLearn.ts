import type { InjectionKey, Ref } from 'vue';
import { getCurrentScope, onScopeDispose, ref } from 'vue';
import { isSwitchOn } from '@/lib/midi';
import { mixerBusStripTarget } from '@/project/command/mixer-internal';
import {
  clearAllMidiCcBindings,
  clearMidiCcBinding,
  type MixerStripTarget,
  setMasteringParam,
  setMidiCcBinding,
  setSend,
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripEq,
  setStripGain,
  setStripInputTrim,
  setStripPan,
  setStripPanLaw,
  setStripPanMode,
  setStripPolarityInvert,
  setStripWidth,
  setTrackMute,
  setTrackSolo,
  setVcaGroupGain,
  setVcaGroupMute,
  setVcaGroupSolo,
} from '@/project/commands';
import {
  bankSlotTrackId,
  clampBankOffset,
  nextBankOffset,
  previousBankOffset,
} from '@/project/control-surface';
import {
  DEFAULT_DUAL_PAN,
  MAX_CHANNEL_DELAY_SAMPLES,
  MAX_INPUT_TRIM_DB,
  MAX_STRIP_WIDTH,
  MIN_INPUT_TRIM_DB,
  MIN_STRIP_WIDTH,
  PAN_LAW_IDS,
  PAN_MODE_IDS,
} from '@/project/mixer';
import { processorControlValueFromMidi } from '@/project/processor-controls';
import {
  listQuickControls,
  type QuickControlTarget,
  setQuickControl,
} from '@/project/quick-controls';
import { useProjectStore } from '@/project/store';
import { masteringProcessorControls } from '@/ui/mastering/chain-controls';
import {
  ccToGainDb,
  ccToGainDbFine,
  ccToLogRange,
  ccToPan,
  ccToPanFine,
  ccToRange,
  type MidiCcBinding,
  type MidiCcMessage,
  type MidiLearnBankAction,
  type MidiLearnBankTarget,
  type MidiLearnParam,
  type MidiLearnScope,
  type MidiLearnTransportAction,
  midiCcBindingMatches,
  midiCcMessageValue,
  midiLearnTargetId,
  parseMidiLearnBankActionTargetId,
  parseMidiLearnBankTargetId,
  parseMidiLearnBusStripControlTargetId,
  parseMidiLearnEqTargetId,
  parseMidiLearnInsertTargetId,
  parseMidiLearnInstrumentTargetId,
  parseMidiLearnMasteringTargetId,
  parseMidiLearnSendTargetId,
  parseMidiLearnStripControlTargetId,
  parseMidiLearnTargetId,
  parseMidiLearnTrackStateTargetId,
  parseMidiLearnTransportTargetId,
  parseMidiLearnVcaTargetId,
} from '@/ui/midi/midi-learn';

/**
 * Idle gap after the last CC before a binding's coalesced gesture is committed
 * as one undo entry. A continuous controller sweep stays a single history step.
 */
const COMMIT_DELAY_MS = 250;

const MIDI_EQ_MIN_FREQUENCY_HZ = 20;
const MIDI_EQ_MAX_FREQUENCY_HZ = 20000;
const MIDI_EQ_MIN_GAIN_DB = -15;
const MIDI_EQ_MAX_GAIN_DB = 15;
const MIDI_EQ_MIN_Q = 0.1;
const MIDI_EQ_MAX_Q = 18;

/** Reactive MIDI-learn state and controls returned by {@link useMidiLearn}. */
export interface MidiLearnHandle {
  /** Live bindings keyed by target id (reactive). */
  bindings: Map<string, MidiCcBinding>;
  /** Target id currently waiting to capture the next CC, or null. */
  armed: Ref<string | null>;
  /** Arms a target so the next incoming CC binds to it (toggles off if re-armed). */
  arm(param: MidiLearnParam, scope: MidiLearnScope): void;
  /** Cancels any pending arm without binding. */
  cancelArm(): void;
  /** Removes a target's binding (and any pending commit). */
  clear(param: MidiLearnParam, scope: MidiLearnScope): void;
  /** Removes every binding. */
  clearAll(): void;
  /** True when this target is the one waiting to capture a CC. */
  isArmed(param: MidiLearnParam, scope: MidiLearnScope): boolean;
  /** Returns a target's binding, or undefined when unbound. */
  bindingFor(param: MidiLearnParam, scope: MidiLearnScope): MidiCcBinding | undefined;
  /** Arms an arbitrary target id (toggles off if already armed). */
  armId(id: string): void;
  /** Removes the binding (and pending commit) of an arbitrary target id. */
  clearId(id: string): void;
  /** True when the given target id is the one waiting to capture a CC. */
  isArmedId(id: string): boolean;
  /** Returns the binding of an arbitrary target id, or undefined when unbound. */
  bindingForId(id: string): MidiCcBinding | undefined;
  /**
   * Handles an incoming CC: binds it to the armed target, or applies it to
   * every target bound to that channel + controller.
   */
  handleCc(message: MidiCcMessage): void;
  /**
   * Applies a value to a target without a binding, for a surface whose layout
   * is fixed by its protocol rather than learned. Coalesces into one undo entry
   * exactly like a learned controller sweep does.
   *
   * @param id Target id to drive.
   * @param value Control value in the 0..127 range; fractional values keep a
   *   14-bit fader's resolution.
   */
  applyTarget(id: string, value: number): void;
  /** Pages the bank window, clamped to the current track count. */
  moveBank(action: MidiLearnBankAction): void;
  /** Shifts the bank window by whole tracks (a surface CHANNEL button). */
  shiftBank(delta: number): void;
}

/** Session actions a control surface can drive through learned bindings. */
export interface MidiLearnOptions {
  /**
   * Transport actions invoked by a bound button press. Absent handlers make
   * their bindings inert rather than an error, so a project learned on a rig
   * with transport control still loads elsewhere.
   */
  transport?: Partial<Record<MidiLearnTransportAction, () => void>>;
  /**
   * Toggles a track's record arm. Arming is session state owned by the
   * recording controls rather than the document, so it arrives as a handler
   * like the transport actions.
   */
  toggleTrackArm?: (trackId: number) => void;
  /** Focuses a track (a surface SELECT button). */
  selectTrack?: (trackId: number) => void;
}

/** Injection key sharing the app's single MIDI-learn handle with descendants. */
export const MIDI_LEARN_KEY: InjectionKey<MidiLearnHandle> = Symbol('midiLearn');

/**
 * App-level MIDI CC "learn": maps hardware controllers to mixer strip gain/pan
 * and instrument/insert quick controls, driving them through the real commands
 * so a moved knob is audible through the engine in realtime. Bindings live in
 * the project store and persist with the document; because target ids are
 * stable within a project, a restored binding always drives the same target,
 * and a binding whose target no longer exists is dropped on first use.
 *
 * Rapid CC streams are coalesced: each value is applied immediately as an
 * uncommitted gesture, and a single undo entry is committed once the stream
 * goes idle.
 *
 * @returns Reactive MIDI-learn state and arm/clear/handle controls.
 */
export function useMidiLearn(options: MidiLearnOptions = {}): MidiLearnHandle {
  // Bindings are the store's persisted map (stable identity across loads); arm
  // state and pending-commit timers are transient session state.
  const bindings = useProjectStore().midiCcBindings as Map<string, MidiCcBinding>;
  const armed = ref<string | null>(null);
  const commitTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cancels a target's pending commit timer, if any. */
  function clearTimer(id: string): void {
    const timer = commitTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      commitTimers.delete(id);
    }
  }

  /** Resolves a target id to the quick-control device + param it drives. */
  function quickControlOf(id: string): { target: QuickControlTarget; paramId: string } | null {
    const insert = parseMidiLearnInsertTargetId(id);
    if (insert) {
      const store = useProjectStore();
      const strip =
        insert.scope === 'master'
          ? store.mixer.master
          : store.tracks.find((track) => track.id === insert.scope)?.mixer;
      const index =
        insert.processorId !== undefined
          ? (strip?.inserts.findIndex((slot) => slot.id === insert.processorId) ?? -1)
          : (insert.index ?? -1);
      if (index < 0) return null;
      return {
        target: { type: 'insert', trackId: insert.scope, index },
        paramId: insert.paramId,
      };
    }
    const instrument = parseMidiLearnInstrumentTargetId(id);
    if (instrument) {
      return {
        target: { type: 'instrument', trackId: instrument.trackId },
        paramId: instrument.paramId,
      };
    }
    return null;
  }

  /**
   * Applies a CC value to an instrument/insert quick control, mapping it across
   * the control's range. Returns false when the device or parameter is gone
   * (the caller drops the stale binding).
   */
  function dispatchQuickControl(
    target: QuickControlTarget,
    paramId: string,
    value: number,
    commit: boolean,
  ): boolean {
    try {
      const control = listQuickControls(target).find((c) => c.id === paramId);
      if (!control) return false;
      const mapped =
        control.kind === 'boolean' || control.kind === 'enum'
          ? processorControlValueFromMidi(control, value)
          : ccToRange(value, control.min, control.max);
      setQuickControl(target, paramId, mapped, { commit });
      return true;
    } catch {
      // Stale binding (e.g. the device/track was removed): drop it.
      return false;
    }
  }

  /** Moves the bank window, clamped to the current track count. */
  function moveBank(action: MidiLearnBankAction): void {
    const store = useProjectStore();
    const surface = store.controlSurface;
    const count = store.tracks.length;
    const offset =
      action === 'home'
        ? 0
        : action === 'next'
          ? nextBankOffset(surface.bankOffset, count, surface.bankSize)
          : previousBankOffset(surface.bankOffset, count, surface.bankSize);
    store.controlSurface = { ...surface, bankOffset: offset };
  }

  /** Shifts the bank window by whole tracks (a surface CHANNEL button). */
  function shiftBank(delta: number): void {
    const store = useProjectStore();
    const surface = store.controlSurface;
    store.controlSurface = {
      ...surface,
      bankOffset: clampBankOffset(
        surface.bankOffset + Math.round(delta),
        store.tracks.length,
        surface.bankSize,
      ),
    };
  }

  /**
   * Applies a value to the track a bank slot currently points at. A slot past
   * the end of the track list is inert: the surface strip simply does nothing
   * until the bank moves, which is not a reason to drop the binding.
   */
  function dispatchBankSlot(target: MidiLearnBankTarget, value: number, commit: boolean): boolean {
    const store = useProjectStore();
    const surface = store.controlSurface;
    const trackId = bankSlotTrackId(
      store.tracks.map((track) => track.id),
      surface.bankOffset,
      surface.bankSize,
      target.slot,
    );
    if (trackId === null) return true;
    try {
      switch (target.param) {
        case 'gain':
          // The fine mappers keep a 14-bit surface fader's resolution; for the
          // integer values a learned CC sends they are identical.
          setStripGain(trackId, ccToGainDbFine(value), { commit });
          break;
        case 'pan':
          setStripPan(trackId, ccToPanFine(value), { commit });
          break;
        case 'mute':
          setTrackMute(trackId, isSwitchOn(value));
          break;
        case 'solo':
          setTrackSolo(trackId, isSwitchOn(value));
          break;
        case 'arm':
          if (isSwitchOn(value)) options.toggleTrackArm?.(trackId);
          break;
        default:
          if (isSwitchOn(value)) options.selectTrack?.(trackId);
          break;
      }
      return true;
    } catch {
      // The window pointed at a track that has since been removed; the binding
      // itself stays valid for whatever the slot resolves to next.
      return true;
    }
  }

  /** Applies a value to the bound command, returning false on a stale target. */
  function dispatch(id: string, value: number, commit: boolean): boolean {
    const transportAction = parseMidiLearnTransportTargetId(id);
    if (transportAction !== null) {
      // Momentary button: act on press, ignore the release so one push does
      // not toggle twice.
      if (isSwitchOn(value)) options.transport?.[transportAction]?.();
      return true;
    }
    const bankAction = parseMidiLearnBankActionTargetId(id);
    if (bankAction !== null) {
      if (isSwitchOn(value)) moveBank(bankAction);
      return true;
    }
    const bankSlot = parseMidiLearnBankTargetId(id);
    if (bankSlot !== null) return dispatchBankSlot(bankSlot, value, commit);
    const quickControl = quickControlOf(id);
    if (quickControl) {
      return dispatchQuickControl(quickControl.target, quickControl.paramId, value, commit);
    }
    const send = parseMidiLearnSendTargetId(id);
    if (send) {
      try {
        const current = useProjectStore()
          .tracks.find((track) => track.id === send.scope)
          ?.mixer?.sends.find((entry) => entry.busId === send.busId);
        if (send.param === 'level') {
          setSend(
            send.scope,
            send.busId,
            { levelDb: ccToGainDb(value), enabled: true },
            { commit },
          );
        } else if (send.param === 'enabled') {
          setSend(send.scope, send.busId, {
            levelDb: current?.levelDb ?? ccToGainDb(127),
            enabled: isSwitchOn(value),
            timing: current?.timing,
          });
        } else {
          setSend(send.scope, send.busId, {
            levelDb: current?.levelDb ?? ccToGainDb(127),
            enabled: current?.enabled ?? true,
            timing: isSwitchOn(value) ? 'preFader' : 'postFader',
          });
        }
        return true;
      } catch {
        return false;
      }
    }
    const trackState = parseMidiLearnTrackStateTargetId(id);
    if (trackState) {
      try {
        if (trackState.param === 'mute') setTrackMute(trackState.trackId, isSwitchOn(value));
        else setTrackSolo(trackState.trackId, isSwitchOn(value));
        return true;
      } catch {
        return false;
      }
    }
    const vca = parseMidiLearnVcaTargetId(id);
    if (vca) {
      try {
        if (vca.param === 'gain') setVcaGroupGain(vca.groupId, ccToGainDb(value), { commit });
        else if (vca.param === 'mute') setVcaGroupMute(vca.groupId, isSwitchOn(value));
        else setVcaGroupSolo(vca.groupId, isSwitchOn(value));
        return true;
      } catch {
        return false;
      }
    }
    const eqTarget = parseMidiLearnEqTargetId(id);
    if (eqTarget) {
      try {
        const store = useProjectStore();
        const strip =
          eqTarget.scope === 'master'
            ? store.mixer.master
            : store.tracks.find((track) => track.id === eqTarget.scope)?.mixer;
        const eq = strip?.eq;
        const band = eq?.bands[eqTarget.bandIndex];
        if (!eq || !band) return false;
        const nextValue =
          eqTarget.param === 'frequencyHz'
            ? ccToLogRange(value, MIDI_EQ_MIN_FREQUENCY_HZ, MIDI_EQ_MAX_FREQUENCY_HZ)
            : eqTarget.param === 'gainDb'
              ? ccToRange(value, MIDI_EQ_MIN_GAIN_DB, MIDI_EQ_MAX_GAIN_DB)
              : ccToLogRange(value, MIDI_EQ_MIN_Q, MIDI_EQ_MAX_Q);
        setStripEq(
          eqTarget.scope,
          {
            ...eq,
            bands: eq.bands.map((entry, index) =>
              index === eqTarget.bandIndex ? { ...entry, [eqTarget.param]: nextValue } : entry,
            ),
          },
          { commit },
        );
        return true;
      } catch {
        return false;
      }
    }
    const mastering = parseMidiLearnMasteringTargetId(id);
    if (mastering) {
      try {
        const processors = useProjectStore().mixer.masteringChain?.processors ?? [];
        const index =
          mastering.processorId !== undefined
            ? processors.findIndex((slot) => slot.id === mastering.processorId)
            : (mastering.index ?? -1);
        const slot = processors[index];
        if (!slot || index < 0) return false;
        const control = masteringProcessorControls(slot).find(
          (entry) => entry.id === mastering.paramId,
        );
        if (!control) return false;
        const mapped =
          control.kind === 'boolean' || control.kind === 'enum'
            ? processorControlValueFromMidi(control, value)
            : ccToRange(value, control.min, control.max);
        if (typeof mapped === 'string') return false;
        setMasteringParam(index, mastering.paramId, mapped, { commit });
        return true;
      } catch {
        return false;
      }
    }
    const stripControl = parseMidiLearnStripControlTargetId(id);
    if (stripControl) {
      try {
        if (stripControl.param === 'inputTrimDb') {
          setStripInputTrim(
            stripControl.scope,
            ccToRange(value, MIN_INPUT_TRIM_DB, MAX_INPUT_TRIM_DB),
            { commit },
          );
        } else if (stripControl.param === 'width') {
          setStripWidth(stripControl.scope, ccToRange(value, MIN_STRIP_WIDTH, MAX_STRIP_WIDTH), {
            commit,
          });
        } else if (
          stripControl.param === 'polarityLeft' ||
          stripControl.param === 'polarityRight'
        ) {
          const strip =
            stripControl.scope === 'master'
              ? useProjectStore().mixer.master
              : (useProjectStore().tracks.find((track) => track.id === stripControl.scope)?.mixer ??
                null);
          const enabled = isSwitchOn(value);
          const left =
            stripControl.param === 'polarityLeft' ? enabled : strip?.polarityInvertLeft === true;
          const right =
            stripControl.param === 'polarityRight' ? enabled : strip?.polarityInvertRight === true;
          setStripPolarityInvert(stripControl.scope, left, right);
        } else {
          if (stripControl.scope === 'master') return false;
          if (stripControl.param === 'panLaw') {
            const index = Math.min(
              PAN_LAW_IDS.length - 1,
              Math.floor((value / 128) * PAN_LAW_IDS.length),
            );
            setStripPanLaw(stripControl.scope, PAN_LAW_IDS[index]);
          } else if (stripControl.param === 'panMode') {
            const index = Math.min(
              PAN_MODE_IDS.length - 1,
              Math.floor((value / 128) * PAN_MODE_IDS.length),
            );
            setStripPanMode(stripControl.scope, PAN_MODE_IDS[index]);
          } else {
            const strip =
              useProjectStore().tracks.find((track) => track.id === stripControl.scope)?.mixer ??
              null;
            if (stripControl.param === 'channelDelaySamples') {
              setStripChannelDelaySamples(
                stripControl.scope,
                Math.round(ccToRange(value, 0, MAX_CHANNEL_DELAY_SAMPLES)),
              );
            } else {
              const next = ccToPan(value);
              const left =
                stripControl.param === 'dualPanLeft'
                  ? next
                  : (strip?.dualPan?.left ?? DEFAULT_DUAL_PAN.left);
              const right =
                stripControl.param === 'dualPanRight'
                  ? next
                  : (strip?.dualPan?.right ?? DEFAULT_DUAL_PAN.right);
              setStripDualPan(stripControl.scope, left, right);
            }
          }
        }
        return true;
      } catch {
        return false;
      }
    }
    const busStripControl = parseMidiLearnBusStripControlTargetId(id);
    if (busStripControl) {
      try {
        const target = mixerBusStripTarget(busStripControl.busId);
        if (busStripControl.param === 'inputTrimDb') {
          setStripInputTrim(target, ccToRange(value, MIN_INPUT_TRIM_DB, MAX_INPUT_TRIM_DB), {
            commit,
          });
        } else if (busStripControl.param === 'width') {
          setStripWidth(target, ccToRange(value, MIN_STRIP_WIDTH, MAX_STRIP_WIDTH), { commit });
        } else {
          const strip = useProjectStore().mixer.buses.find(
            (bus) => bus.id === busStripControl.busId,
          )?.strip;
          const enabled = isSwitchOn(value);
          setStripPolarityInvert(
            target,
            busStripControl.param === 'polarityLeft' ? enabled : strip?.polarityInvertLeft === true,
            busStripControl.param === 'polarityRight'
              ? enabled
              : strip?.polarityInvertRight === true,
          );
        }
        return true;
      } catch {
        return false;
      }
    }
    const target = parseMidiLearnTargetId(id);
    if (!target) return false;
    const strip: MixerStripTarget = target.scope;
    try {
      if (target.param === 'gain') setStripGain(strip, ccToGainDb(value), { commit });
      else setStripPan(strip, ccToPan(value), { commit });
      return true;
    } catch {
      // Stale binding (e.g. the track was removed): drop it.
      return false;
    }
  }

  /** True for button targets that act once per press, with no gesture to commit. */
  function isEdgeTriggered(id: string): boolean {
    if (parseMidiLearnTransportTargetId(id) !== null) return true;
    if (parseMidiLearnBankActionTargetId(id) !== null) return true;
    const slot = parseMidiLearnBankTargetId(id);
    return slot !== null && (slot.param === 'arm' || slot.param === 'select');
  }

  /** Applies a CC value to a bound target, coalescing the gesture's commit. */
  function apply(id: string, value: number): void {
    if (!dispatch(id, value, false)) {
      clearTimer(id);
      // Stale targets are project metadata too: remove them through the
      // command layer so the cleanup is undoable like an explicit clear.
      clearMidiCcBinding(id);
      return;
    }
    clearTimer(id);
    if (isEdgeTriggered(id)) return;
    commitTimers.set(
      id,
      setTimeout(() => {
        commitTimers.delete(id);
        // The target may have disappeared while the gesture was pending. Keep
        // the same command/history guarantee as the immediate apply path.
        if (!dispatch(id, value, true)) clearMidiCcBinding(id);
      }, COMMIT_DELAY_MS),
    );
  }

  function armId(id: string): void {
    armed.value = armed.value === id ? null : id;
  }

  function arm(param: MidiLearnParam, scope: MidiLearnScope): void {
    armId(midiLearnTargetId(param, scope));
  }

  function cancelArm(): void {
    armed.value = null;
  }

  function clearId(id: string): void {
    clearTimer(id);
    clearMidiCcBinding(id);
    if (armed.value === id) armed.value = null;
  }

  function clear(param: MidiLearnParam, scope: MidiLearnScope): void {
    clearId(midiLearnTargetId(param, scope));
  }

  function clearAll(): void {
    for (const id of commitTimers.keys()) clearTimer(id);
    clearAllMidiCcBindings();
    armed.value = null;
  }

  function isArmedId(id: string): boolean {
    return armed.value === id;
  }

  function isArmed(param: MidiLearnParam, scope: MidiLearnScope): boolean {
    return isArmedId(midiLearnTargetId(param, scope));
  }

  function bindingForId(id: string): MidiCcBinding | undefined {
    return bindings.get(id);
  }

  function bindingFor(param: MidiLearnParam, scope: MidiLearnScope): MidiCcBinding | undefined {
    return bindingForId(midiLearnTargetId(param, scope));
  }

  function applyTarget(id: string, value: number): void {
    apply(id, value);
  }

  function handleCc(message: MidiCcMessage): void {
    const value = midiCcMessageValue(message);
    if (armed.value !== null) {
      const id = armed.value;
      armed.value = null;
      setMidiCcBinding(id, {
        channel: message.channel,
        controller: message.controller,
        ...(message.kind && message.kind !== 'cc' ? { kind: message.kind } : {}),
        ...(message.parameter !== undefined ? { parameter: message.parameter } : {}),
      });
      apply(id, value);
      return;
    }
    for (const [id, binding] of bindings) {
      if (midiCcBindingMatches(binding, message)) {
        apply(id, value);
      }
    }
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const id of commitTimers.keys()) clearTimer(id);
    });
  }

  return {
    bindings,
    armed,
    arm,
    cancelArm,
    clear,
    clearAll,
    isArmed,
    bindingFor,
    armId,
    clearId,
    isArmedId,
    bindingForId,
    handleCc,
    applyTarget,
    moveBank,
    shiftBank,
  };
}
