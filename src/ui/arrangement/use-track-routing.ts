/**
 * Routing pickers of the arrangement track headers: output group, VCA group,
 * and the per-track record input channel and device, each with its options
 * and change handler.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import { describeError } from '@/lib/errors';
import {
  setTrackGroup,
  setTrackRecordInputChannel,
  setTrackRecordInputDeviceId,
  setTracksGroup,
  setTracksRecordInputChannel,
  setTracksRecordInputDeviceId,
  setTracksVca,
  setTrackVca,
} from '@/project/commands';
import { useProjectStore } from '@/project/store';
import type { EditorTrack } from '@/project/types';
import { formatMessage, useI18n } from '@/ui/i18n';

/** SelectMenu value for the "No group" output-group option. */
const GROUP_NONE = '';
/** SelectMenu value for the "No VCA" option. */
const VCA_NONE = '';
/** SelectMenu value used for automatic input-channel assignment. */
const RECORD_INPUT_AUTO = -1;
/** Compact fixed menu; actual capture channel availability is known only after recording starts. */
const RECORD_INPUT_CHANNEL_OPTIONS = 8;
/** SelectMenu value for the global (non-overridden) input device. */
const RECORD_DEVICE_DEFAULT = '';

/** Configuration for {@link useTrackRouting}. */
export interface UseTrackRoutingOptions {
  /** Header list props supplying the available record input devices. */
  props: { readonly recordInputDevices?: readonly { value: string; label: string }[] };
  /** The header list's error banner, set when a command rejects. */
  error: Ref<string>;
  /** Ids a header action applies to: the multi-selection when it holds the track, else the track. */
  selectedTrackIds: (fallbackTrackId: number) => number[];
}

/** Picker state and handlers returned by {@link useTrackRouting}. */
export interface TrackRouting {
  /** Group tracks available as routing targets, in track order. */
  groupTracks: ComputedRef<EditorTrack[]>;
  /** Sentinel value for the "No group" option. */
  GROUP_NONE: string;
  groupOptions: ComputedRef<{ value: string | number; label: string }[]>;
  onGroupChange(track: EditorTrack, value: string | number): void;
  /** VCA groups available as remote fader targets. */
  vcaGroups: ComputedRef<NonNullable<ReturnType<typeof useProjectStore>['mixer']['vcaGroups']>>;
  /** Sentinel value for the "No VCA" option. */
  VCA_NONE: string;
  vcaOptions: ComputedRef<{ value: string; label: string }[]>;
  onVcaChange(track: EditorTrack, value: string): void;
  recordInputChannelOptions: ComputedRef<{ value: number; label: string }[]>;
  recordInputChannelValue(track: EditorTrack): number;
  onRecordInputChannelChange(track: EditorTrack, value: number): void;
  recordInputDeviceOptions: ComputedRef<{ value: string; label: string }[]>;
  recordInputDeviceValue(track: EditorTrack): string;
  onRecordInputDeviceChange(track: EditorTrack, value: string): void;
}

/**
 * Creates the routing pickers for one track header list.
 *
 * @param options - Record device props, the error banner and the selection resolver.
 * @returns Picker options, current values and change handlers.
 */
export function useTrackRouting(options: UseTrackRoutingOptions): TrackRouting {
  const { props, error, selectedTrackIds } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  const groupTracks = computed<EditorTrack[]>(() =>
    store.tracks.filter((track) => track.kind === 'group'),
  );

  /** Output-group picker options: "No group" plus every group track. */
  const groupOptions = computed<{ value: string | number; label: string }[]>(() => [
    { value: GROUP_NONE, label: t.value.shell.arrangement.trackHeader.noGroup },
    ...groupTracks.value.map((group) => ({ value: group.id, label: group.name })),
  ]);

  function onGroupChange(track: EditorTrack, value: string | number): void {
    try {
      const ids = selectedTrackIds(track.id);
      const groupId = value === GROUP_NONE ? null : Number(value);
      if (ids.length === 1) setTrackGroup(track.id, groupId);
      else setTracksGroup(ids, groupId);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  const vcaGroups = computed(() => store.mixer.vcaGroups ?? []);

  /** VCA picker options: "No VCA" plus every mixer VCA group. */
  const vcaOptions = computed<{ value: string; label: string }[]>(() => [
    { value: VCA_NONE, label: t.value.shell.arrangement.trackHeader.noVca },
    ...vcaGroups.value.map((group) => ({ value: group.id, label: group.name })),
  ]);

  function onVcaChange(track: EditorTrack, value: string): void {
    try {
      const ids = selectedTrackIds(track.id);
      const groupId = value === VCA_NONE ? null : value;
      if (ids.length === 1) setTrackVca(track.id, groupId);
      else setTracksVca(ids, groupId);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  const recordInputChannelOptions = computed<{ value: number; label: string }[]>(() => [
    { value: RECORD_INPUT_AUTO, label: t.value.shell.arrangement.trackHeader.recordInputAuto },
    ...Array.from({ length: RECORD_INPUT_CHANNEL_OPTIONS }, (_, index) => ({
      value: index,
      label: formatMessage(t.value.shell.arrangement.trackHeader.recordInputChannel, {
        channel: String(index + 1),
      }),
    })),
  ]);

  function recordInputChannelValue(track: EditorTrack): number {
    return track.recordInputChannel ?? RECORD_INPUT_AUTO;
  }

  function onRecordInputChannelChange(track: EditorTrack, value: number): void {
    try {
      const ids = selectedTrackIds(track.id);
      const channel = value === RECORD_INPUT_AUTO ? null : value;
      if (ids.length === 1) setTrackRecordInputChannel(track.id, channel);
      else setTracksRecordInputChannel(ids, channel);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  const recordInputDeviceOptions = computed<{ value: string; label: string }[]>(() => [
    {
      value: RECORD_DEVICE_DEFAULT,
      label: t.value.shell.arrangement.trackHeader.recordInputDeviceDefault,
    },
    ...(props.recordInputDevices ?? [])
      .filter((device) => device.value !== RECORD_DEVICE_DEFAULT)
      .map((device) => ({ value: device.value, label: device.label })),
  ]);

  function recordInputDeviceValue(track: EditorTrack): string {
    return track.recordInputDeviceId ?? RECORD_DEVICE_DEFAULT;
  }

  function onRecordInputDeviceChange(track: EditorTrack, value: string): void {
    try {
      const ids = selectedTrackIds(track.id);
      const deviceId = value === RECORD_DEVICE_DEFAULT ? null : value;
      if (ids.length === 1) setTrackRecordInputDeviceId(track.id, deviceId);
      else setTracksRecordInputDeviceId(ids, deviceId);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  return {
    groupTracks,
    GROUP_NONE,
    groupOptions,
    onGroupChange,
    vcaGroups,
    VCA_NONE,
    vcaOptions,
    onVcaChange,
    recordInputChannelOptions,
    recordInputChannelValue,
    onRecordInputChannelChange,
    recordInputDeviceOptions,
    recordInputDeviceValue,
    onRecordInputDeviceChange,
  };
}
