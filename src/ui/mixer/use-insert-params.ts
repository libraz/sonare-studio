/**
 * Inline parameter controls of the expanded insert slot: which slot is
 * expanded, its quick controls, coalesced knob gestures and the MIDI-learn
 * state of each control.
 */

import { type ComputedRef, computed, inject, onBeforeUnmount, type Ref, ref } from 'vue';
import { MIDI_LEARN_KEY } from '@/composables/useMidiLearn';
import type { CommandGestureOptions, MixerStripTarget } from '@/project/commands';
import { isMixerBusStripTarget } from '@/project/commands';
import type { MixerStrip } from '@/project/mixer';
import type { ProcessorControlValue } from '@/project/processor-controls';
import { listQuickControls, type QuickControl, setQuickControl } from '@/project/quick-controls';
import { formatMessage, useI18n } from '@/ui/i18n';
import { midiLearnInsertTargetId } from '@/ui/midi/midi-learn';
import { coupledKeyList, insertEditErrorMessage } from '@/ui/mixer/insert-edit-error';
import { createValueGesture, type ValueGesture } from '@/ui/mixer/strip-gestures';

/** Configuration for {@link useInsertParams}. */
export interface UseInsertParamsOptions {
  /** Rack props: the strip target the controls edit. */
  props: {
    readonly target: MixerStripTarget;
  };
  /** The strip whose inserts the rack shows. */
  strip: ComputedRef<MixerStrip>;
  /** The rack's error banner, set when a parameter edit is rejected. */
  error: Ref<string>;
}

/** Expanded-slot controls and actions returned by {@link useInsertParams}. */
export interface InsertParams {
  /** Index of the slot whose parameters are shown inline, or null. */
  expandedIndex: Ref<number | null>;
  /** Quick controls of the expanded slot. */
  expandedControls: ComputedRef<QuickControl[]>;
  /** Expands the slot, or collapses it when already expanded. */
  toggleExpanded(index: number): void;
  /** Applies a control edit; number knobs coalesce until commit. */
  onParamChange(control: QuickControl, value: ProcessorControlValue, commit: boolean): void;
  /** Tooltip remark for a knob whose accepted range moves with sibling keys. */
  coupledNote(control: QuickControl): string;
  /** Flips a boolean control. */
  onBooleanToggle(control: Extract<QuickControl, { kind: 'boolean' }>): void;
  /** Selects an enum control value. */
  onEnumChange(control: Extract<QuickControl, { kind: 'enum' }>, value: string | number): void;
  /** MIDI-learn state for a control's knob menu, or undefined when unavailable. */
  learnState(control: QuickControl): 'unbound' | 'armed' | 'bound' | undefined;
  /** Arms MIDI learn for the control. */
  onMidiLearn(control: QuickControl): void;
  /** Clears the control's MIDI binding. */
  onMidiForget(control: QuickControl): void;
}

/**
 * Creates the expanded-slot parameter state of one insert rack.
 *
 * @param options - The rack props, the strip being shown and the error banner.
 * @returns The expanded slot, its controls and their edit actions.
 */
export function useInsertParams(options: UseInsertParamsOptions): InsertParams {
  const { props, strip, error } = options;
  const { t } = useI18n();

  // --- Expand / parameter knobs ------------------------------------------------

  const expandedIndex = ref<number | null>(null);

  const expandedControls = computed<QuickControl[]>(() => {
    const index = expandedIndex.value;
    if (index === null || index >= strip.value.inserts.length) return [];
    try {
      return listQuickControls({ type: 'insert', trackId: props.target, index });
    } catch {
      return [];
    }
  });

  function toggleExpanded(index: number): void {
    expandedIndex.value = expandedIndex.value === index ? null : index;
  }

  /** In-flight knob gestures keyed by slot index and control id (one per dragged knob). */
  const gestures = new Map<string, ValueGesture>();

  function onParamChange(
    control: QuickControl,
    value: ProcessorControlValue,
    commit: boolean,
  ): void {
    const index = expandedIndex.value;
    if (index === null) return;
    const apply = (v: number, options: CommandGestureOptions): void => {
      setQuickControl({ type: 'insert', trackId: props.target, index }, control.id, v, options);
    };
    try {
      if (control.kind !== 'number') {
        // Toggles and enum selections are atomic edits; only number knobs need a
        // coalesced gesture map.
        setQuickControl({ type: 'insert', trackId: props.target, index }, control.id, value, {
          commit: true,
        });
        error.value = '';
        return;
      }
      const gestureKey = `${index}:${control.id}`;
      if (!commit) {
        let gesture = gestures.get(gestureKey);
        if (!gesture) {
          gesture = createValueGesture(apply, control.value);
          gestures.set(gestureKey, gesture);
        }
        gesture.update(value as number);
      } else {
        const gesture = gestures.get(gestureKey);
        if (gesture) gesture.end(value as number);
        else apply(value as number, { commit: true });
        gestures.delete(gestureKey);
      }
      error.value = '';
    } catch (err) {
      error.value = insertEditErrorMessage(err, t.value);
    }
  }

  /** Tooltip remark for a knob whose accepted range moves with sibling keys. */
  function coupledNote(control: QuickControl): string {
    if (control.kind !== 'number' || !control.coupledWith) return '';
    return formatMessage(t.value.shell.mixer.controls.coupledNote, {
      related: coupledKeyList(control.coupledWith),
    });
  }

  function onBooleanToggle(control: Extract<QuickControl, { kind: 'boolean' }>): void {
    onParamChange(control, !control.value, true);
  }

  function onEnumChange(
    control: Extract<QuickControl, { kind: 'enum' }>,
    value: string | number,
  ): void {
    onParamChange(control, value, true);
  }

  // --- MIDI learn (shared app handle, injected; null in isolated tests) --------

  const midiLearn = inject(MIDI_LEARN_KEY, null);

  /** Learn target id for a control on the currently expanded insert slot. */
  function learnTargetId(control: QuickControl): string {
    if (isMixerBusStripTarget(props.target)) return '';
    const index = expandedIndex.value ?? -1;
    return midiLearnInsertTargetId(
      props.target,
      strip.value.inserts[index]?.id ?? index,
      control.id,
    );
  }

  /** MIDI-learn state for a control's knob menu, or undefined when unavailable. */
  function learnState(control: QuickControl): 'unbound' | 'armed' | 'bound' | undefined {
    if (!midiLearn || isMixerBusStripTarget(props.target)) return undefined;
    const id = learnTargetId(control);
    if (midiLearn.isArmedId(id)) return 'armed';
    return midiLearn.bindingForId(id) ? 'bound' : 'unbound';
  }

  function onMidiLearn(control: QuickControl): void {
    if (isMixerBusStripTarget(props.target)) return;
    midiLearn?.armId(learnTargetId(control));
  }

  function onMidiForget(control: QuickControl): void {
    if (isMixerBusStripTarget(props.target)) return;
    midiLearn?.clearId(learnTargetId(control));
  }

  onBeforeUnmount(() => {
    for (const gesture of gestures.values()) gesture.end();
    gestures.clear();
  });

  return {
    expandedIndex,
    expandedControls,
    toggleExpanded,
    onParamChange,
    coupledNote,
    onBooleanToggle,
    onEnumChange,
    learnState,
    onMidiLearn,
    onMidiForget,
  };
}
