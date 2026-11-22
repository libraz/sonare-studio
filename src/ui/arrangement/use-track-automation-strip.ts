/**
 * Automation sublane strip of the arrangement track headers: which tracks show
 * it, the parameter each edits, the store lane behind it and the parameter
 * choices its picker offers.
 */

import {
  type AutomationLaneState,
  type AutomationParam,
  insertAutomationParam,
  instrumentAutomationParam,
  isAutomationParam,
} from '@/project/automation';
import { setAutomationLaneEnabled } from '@/project/commands';
import {
  AUTOMATABLE_SYNTH_PARAMS,
  type AutomatableSynthParam,
  isNativeSynthInstrument,
  synthParamReachesSoundingVoices,
  trackInstrument,
} from '@/project/instrument';
import { catalogParamInfo } from '@/project/processor-controls';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { patchFieldSpec } from '@/ui/devices/patch-draft';
import { formatMessage, useI18n } from '@/ui/i18n';

/** Configuration for {@link useTrackAutomationStrip}. */
export interface UseTrackAutomationStripOptions {
  /** Header list props mirroring the container's sublane state. */
  props: {
    readonly automationExpandedIds?: readonly number[];
    readonly automationParams?: Record<number, AutomationParam>;
  };
  /** Header list emit for the sublane requests. */
  emit: {
    (event: 'toggleAutomation', trackId: number, expanded: boolean): void;
    (event: 'automationParam', trackId: number, param: AutomationParam): void;
  };
}

/** Sublane state and handlers returned by {@link useTrackAutomationStrip}. */
export interface TrackAutomationStrip {
  isAutomationExpanded(track: EditorTrack): boolean;
  automationParamFor(track: EditorTrack): AutomationParam;
  automationLaneFor(track: EditorTrack): AutomationLaneState | null;
  automationParamOptions(
    track: EditorTrack,
  ): ReadonlyArray<{ value: AutomationParam; label: string }>;
  onToggleAutomation(track: EditorTrack): void;
  onAutomationParamChange(track: EditorTrack, value: string): void;
  onAutomationEnabledChange(track: EditorTrack, enabled: boolean): void;
}

/**
 * Creates the automation sublane state for one track header list.
 *
 * @param options - Header list props and emit.
 * @returns The sublane queries and handlers.
 */
export function useTrackAutomationStrip(
  options: UseTrackAutomationStripOptions,
): TrackAutomationStrip {
  const { props, emit } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  /** True when the container reports the track's automation sublane as expanded. */
  function isAutomationExpanded(track: EditorTrack): boolean {
    return props.automationExpandedIds?.includes(track.id) ?? false;
  }

  /** Parameter the track's automation sublane currently edits. */
  function automationParamFor(track: EditorTrack): AutomationParam {
    const param = props.automationParams?.[track.id] ?? 'faderDb';
    return track.kind === 'group' && param === 'pan' ? 'faderDb' : param;
  }

  /** Store lane behind the track's sublane, or null when none exists yet. */
  function automationLaneFor(track: EditorTrack): AutomationLaneState | null {
    const param = automationParamFor(track);
    return (
      store.automationLanes.find((lane) => lane.target === track.id && lane.param === param) ?? null
    );
  }

  function onToggleAutomation(track: EditorTrack): void {
    emit('toggleAutomation', track.id, !isAutomationExpanded(track));
  }

  /**
   * Parameter choices for a track's automation sublane picker: the fader and pan
   * lanes plus, per insert slot, that processor's realtime-safe parameters as
   * insert-parameter automation targets.
   */
  function automationParamOptions(
    track: EditorTrack,
  ): ReadonlyArray<{ value: AutomationParam; label: string }> {
    const options: { value: AutomationParam; label: string }[] = [
      { value: 'faderDb', label: t.value.shell.arrangement.trackHeader.volumeDb },
    ];
    if (track.kind !== 'group') {
      options.push({ value: 'pan', label: t.value.shell.arrangement.trackHeader.pan });
    }
    (track.mixer?.inserts ?? []).forEach((slot, index) => {
      for (const param of catalogParamInfo(slot.processor)) {
        if (!param.rtSafe) continue;
        options.push({
          value: insertAutomationParam(slot.id ?? index, param.name),
          label: `${slot.processor} · ${param.name}`,
        });
      }
    });
    if (
      track.kind === 'midi' &&
      track.frozen === undefined &&
      isNativeSynthInstrument(trackInstrument(track))
    ) {
      for (const param of AUTOMATABLE_SYNTH_PARAMS) {
        options.push({ value: instrumentAutomationParam(param), label: synthParamLabel(param) });
      }
    }
    return options;
  }

  /** Patch-editor section each synth field sits under, as its lane-label prefix. */
  const SYNTH_SECTION_LABEL_KEYS = {
    osc: 'oscillator',
    filter: 'filter',
    amp: 'ampEnvelope',
    'filter-env': 'filterEnvelope',
    lfo: 'lfo',
    global: 'global',
  } as const;

  /**
   * "Section · Field" label for a synth parameter lane, e.g. "Amp envelope ·
   * Attack", marked when the lane only reaches notes that start after it moves.
   */
  function synthParamLabel(param: AutomatableSynthParam): string {
    const spec = patchFieldSpec(param);
    if (!spec) return param;
    const editor = t.value.shell.patchEditor;
    const section = editor.sections[SYNTH_SECTION_LABEL_KEYS[spec.section]];
    const label = `${section} · ${editor.fields[spec.labelKey] ?? spec.label}`;
    return synthParamReachesSoundingVoices(param)
      ? label
      : formatMessage(t.value.shell.arrangement.trackHeader.synthParamNextNote, { label });
  }

  function onAutomationParamChange(track: EditorTrack, value: string): void {
    if (isAutomationParam(value)) emit('automationParam', track.id, value);
  }

  function onAutomationEnabledChange(track: EditorTrack, enabled: boolean): void {
    setAutomationLaneEnabled(track.id, automationParamFor(track), enabled);
  }

  return {
    isAutomationExpanded,
    automationParamFor,
    automationLaneFor,
    automationParamOptions,
    onToggleAutomation,
    onAutomationParamChange,
    onAutomationEnabledChange,
  };
}
