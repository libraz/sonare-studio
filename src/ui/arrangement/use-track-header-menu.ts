/**
 * Right-click menu of the arrangement track headers and the actions only it
 * triggers: saved channel presets, pitch range and lead following.
 */

import { computed, onMounted, type Ref, ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { isDrumTrack } from '@/compose/tracks';
import { describeError } from '@/lib/errors';
import { isOpfsAvailable } from '@/persistence/opfs';
import {
  deleteTrackChannelPreset,
  listTrackChannelPresets,
  saveTrackChannelPreset,
} from '@/persistence/track-presets';
import {
  addVcaGroup,
  applyTrackChannelPreset,
  copyTrackChannelPreset,
  hasCopiedTrackChannelPreset,
  pasteTrackChannelPreset,
  setActiveTrack,
  setTrackChordFollow,
  setTrackExpressionMap,
  setTrackLeadFollow,
  setTrackMute,
  setTrackPercussion,
  setTrackPitchRange,
  setTrackSelection,
  setTrackSolo,
  setTrackVca,
  type TrackPart,
} from '@/project/commands';
import { EXPRESSION_MAP_PRESETS, matchingExpressionMapPreset } from '@/project/expression-map';
import { partForTrack } from '@/project/generation';
import { MAX_VCA_GROUPS } from '@/project/mixer';
import {
  PITCH_RANGE_PRESET_IDS,
  PITCH_RANGE_PRESETS,
  type PitchRangePresetId,
} from '@/project/pitch-range';
import { useProjectStore } from '@/project/store';
import { type TrackChannelPreset, trackChannelPresetFromTrack } from '@/project/track-preset';
import type { EditorTrack } from '@/project/types';
import type { TrackFreezeBounce } from '@/ui/arrangement/use-track-freeze-bounce';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { shortcutHint } from '@/ui/settings/shortcut-hint';

/** Configuration for {@link useTrackHeaderMenu}. */
export interface UseTrackHeaderMenuOptions {
  /** Error line shown above the headers; preset actions clear and set it. */
  error: Ref<string>;
  /** Shift-click range anchor; opening the menu moves it to the clicked track. */
  selectionAnchorTrackId: Ref<number | null>;
  /** Freeze/bounce state shared with the header buttons. */
  freezeBounce: TrackFreezeBounce;
  /** Starts the inline rename of a track. */
  startRename(track: EditorTrack): void;
  /** Why a frozen track refuses an edit, or null. */
  frozenReason(track: EditorTrack): string | null;
  /** True when the shell reports the track as record-armed. */
  isArmed(track: EditorTrack): boolean;
  /** Why the record-arm toggle is unavailable, or null. */
  armBlocked(track: EditorTrack): string | null;
  /** Requests the opposite record-arm state. */
  onToggleArm(track: EditorTrack): void;
  /** Advances the track, or the selection holding it, to the next palette color. */
  cycleColor(track: EditorTrack): void;
  /** Confirms and removes the track, or the selection holding it. */
  onDelete(track: EditorTrack): Promise<void>;
  /** Header list emit for the requests the menu raises. */
  emit: {
    (event: 'changeInstrument', trackId: number): void;
    (event: 'regenerateTrack', trackId: number, part: TrackPart): void;
  };
}

/** Context-menu handler returned by {@link useTrackHeaderMenu}. */
export interface TrackHeaderMenu {
  /** Builds and opens the track header's right-click action menu. */
  onContextMenu(track: EditorTrack, event: MouseEvent): void;
}

/**
 * Creates the right-click menu for one track header list.
 *
 * @param options - Error line, selection anchor and the header actions the menu repeats.
 * @returns The context-menu handler.
 */
export function useTrackHeaderMenu(options: UseTrackHeaderMenuOptions): TrackHeaderMenu {
  const {
    error,
    selectionAnchorTrackId,
    freezeBounce,
    startRename,
    frozenReason,
    isArmed,
    armBlocked,
    onToggleArm,
    cycleColor,
    onDelete,
    emit,
  } = options;
  const { freezeBlocked, onToggleFreeze, trackHasClips, bounceBlocked, onBounce } = freezeBounce;
  const store = useProjectStore();
  const { t } = useI18n();

  const savedTrackPresets = ref<TrackChannelPreset[]>([]);

  async function refreshSavedTrackPresets(): Promise<void> {
    savedTrackPresets.value = await listTrackChannelPresets();
  }

  onMounted(() => {
    if (!isOpfsAvailable()) return;
    void refreshSavedTrackPresets().catch((reason: unknown) => {
      error.value = describeError(reason, t.value.notices.errors);
    });
  });

  async function savePreset(track: EditorTrack): Promise<void> {
    const name = await promptDialog({
      title: t.value.shell.arrangement.trackHeader.saveChannelPreset,
      message: t.value.shell.arrangement.trackHeader.saveChannelPresetMessage,
      defaultValue: track.name,
      confirmLabel: t.value.shell.arrangement.trackHeader.savePreset,
    });
    if (!name) return;
    try {
      await saveTrackChannelPreset(trackChannelPresetFromTrack(track, name));
      await refreshSavedTrackPresets();
      error.value = '';
    } catch (reason) {
      error.value = describeError(reason, t.value.notices.errors);
    }
  }

  async function deletePreset(name: string): Promise<void> {
    try {
      await deleteTrackChannelPreset(name);
      await refreshSavedTrackPresets();
      error.value = '';
    } catch (reason) {
      error.value = describeError(reason, t.value.notices.errors);
    }
  }

  /** A track's notes across all of its clips, for {@link isDrumTrack}. */
  function notesOfTrack(track: EditorTrack) {
    return (store.clipsByTrack.get(track.id) ?? []).flatMap((clip) => clip.notes);
  }

  /** True when the track's saved pitch range matches this preset exactly. */
  function matchesPitchRangePreset(track: EditorTrack, id: PitchRangePresetId): boolean {
    const range = track.pitchRange;
    const preset = PITCH_RANGE_PRESETS[id];
    return range !== undefined && range.low === preset.low && range.high === preset.high;
  }

  /** Tracks `track` may follow: not itself, not percussion, not already following another. */
  function leadFollowCandidates(track: EditorTrack): EditorTrack[] {
    return store.tracks.filter(
      (entry) =>
        entry.id !== track.id &&
        entry.leadFollow === undefined &&
        !isDrumTrack(entry, notesOfTrack(entry)),
    );
  }

  const headerReasons = computed(() => t.value.shell.arrangement.trackHeader.reasons);

  /**
   * Why `track` cannot take part in lead following: percussion neither follows
   * nor leads, and a track already followed would form a chain by following.
   */
  function leadFollowBlocked(track: EditorTrack): string | null {
    return firstBlock(
      [isDrumTrack(track, notesOfTrack(track)), headerReasons.value.percussionNoLeadFollow],
      [
        store.tracks.some((entry) => entry.leadFollow?.leadTrackId === track.id),
        headerReasons.value.alreadyLead,
      ],
    );
  }

  /** Saved presets live in OPFS, so every preset action needs it. */
  const presetStorageBlocked = computed(() =>
    firstBlock([!isOpfsAvailable(), t.value.reasons.noStorage]),
  );
  const savedPresetsBlocked = computed(() =>
    firstBlock(presetStorageBlocked.value, [
      savedTrackPresets.value.length === 0,
      headerReasons.value.noSavedPresets,
    ]),
  );

  // --- Right-click menu ------------------------------------------------------

  /** Builds and opens the track header's right-click action menu. */
  function onContextMenu(track: EditorTrack, event: MouseEvent): void {
    if (store.trackSelection.has(track.id)) {
      setTrackSelection(store.trackSelection, track.id);
    } else {
      setActiveTrack(track.id);
    }
    selectionAnchorTrackId.value = track.id;
    const items: ContextMenuItem[] = [
      {
        id: 'rename',
        label: t.value.shell.arrangement.trackHeader.rename,
        disabledReason: frozenReason(track),
        run: () => startRename(track),
      },
      { id: 'sep-1', separator: true },
      {
        id: 'mute',
        label: track.mute
          ? t.value.shell.arrangement.trackHeader.unmute
          : t.value.shell.arrangement.trackHeader.mute,
        hint: shortcutHint('track.toggleMute'),
        run: () => setTrackMute(track.id, !track.mute),
      },
      {
        id: 'solo',
        label: track.solo
          ? t.value.shell.arrangement.trackHeader.unsolo
          : t.value.shell.arrangement.trackHeader.solo,
        hint: shortcutHint('track.toggleSolo'),
        run: () => setTrackSolo(track.id, !track.solo),
      },
    ];
    if (track.kind === 'audio' || track.kind === 'midi') {
      items.push({
        id: 'arm',
        label: isArmed(track)
          ? t.value.shell.arrangement.trackHeader.disarmRecording
          : t.value.shell.arrangement.trackHeader.recordEnable,
        hint: shortcutHint('track.toggleArm'),
        disabledReason: armBlocked(track),
        run: () => onToggleArm(track),
      });
    }
    if (track.kind === 'midi') {
      items.push({
        id: 'change-instrument',
        label: t.value.shell.arrangement.trackHeader.changeInstrument,
        run: () => emit('changeInstrument', track.id),
      });
      const header = t.value.shell.arrangement.trackHeader;
      items.push(
        { id: 'sep-percussion', separator: true },
        {
          id: 'percussion-auto',
          label: `${header.percussion}: ${header.percussionAuto}`,
          checked: track.percussion === undefined,
          run: () => setTrackPercussion(track.id, null),
        },
        {
          id: 'percussion-on',
          label: `${header.percussion}: ${header.percussionOn}`,
          checked: track.percussion === true,
          run: () => setTrackPercussion(track.id, true),
        },
        {
          id: 'percussion-off',
          label: `${header.percussion}: ${header.percussionOff}`,
          checked: track.percussion === false,
          run: () => setTrackPercussion(track.id, false),
        },
        { id: 'sep-expression-map', separator: true },
        {
          id: 'expression-map-off',
          label: `${header.expressionMap}: ${header.expressionMapOff}`,
          checked: track.expressionMap === undefined,
          run: () => setTrackExpressionMap(track.id, null),
        },
        ...EXPRESSION_MAP_PRESETS.map((preset) => ({
          id: `expression-map-${preset.id}`,
          label: `${header.expressionMap}: ${header.expressionMapPresets[preset.id]}`,
          checked: matchingExpressionMapPreset(track.expressionMap)?.id === preset.id,
          run: () => setTrackExpressionMap(track.id, preset.map),
        })),
        { id: 'sep-chord-follow', separator: true },
        {
          id: 'chord-follow-off',
          label: `${header.chordFollow}: ${header.chordFollowOff}`,
          checked: track.chordFollow === undefined,
          run: () => setTrackChordFollow(track.id, null),
        },
        {
          id: 'chord-follow-tones',
          label: `${header.chordFollow}: ${header.chordFollowChordTones}`,
          checked: track.chordFollow === 'chordTones',
          run: () => setTrackChordFollow(track.id, 'chordTones'),
        },
        {
          id: 'chord-follow-root',
          label: `${header.chordFollow}: ${header.chordFollowRoot}`,
          checked: track.chordFollow === 'root',
          run: () => setTrackChordFollow(track.id, 'root'),
        },
        { id: 'sep-pitch-lead-follow', separator: true },
        {
          id: 'pitch-range',
          label: header.pitchRange,
          children: [
            {
              id: 'pitch-range-off',
              label: header.pitchRangeOff,
              checked: track.pitchRange === undefined,
              run: () => setTrackPitchRange(track.id, null),
            },
            ...PITCH_RANGE_PRESET_IDS.map((id) => ({
              id: `pitch-range-${id}`,
              label: header.pitchRangePresets[id],
              checked: matchesPitchRangePreset(track, id),
              run: () => setTrackPitchRange(track.id, PITCH_RANGE_PRESETS[id]),
            })),
          ],
        },
        {
          id: 'lead-follow',
          label: header.leadFollow,
          disabledReason: leadFollowBlocked(track),
          children: [
            {
              id: 'lead-follow-off',
              label: header.leadFollowOff,
              checked: track.leadFollow === undefined,
              run: () => setTrackLeadFollow(track.id, null),
            },
            ...leadFollowCandidates(track).map((candidate) => ({
              id: `lead-follow-${candidate.id}`,
              label: candidate.name,
              checked: track.leadFollow?.leadTrackId === candidate.id,
              run: () => setTrackLeadFollow(track.id, candidate.id),
            })),
          ],
        },
      );
    }
    if (track.kind === 'group') {
      const memberIds = store.tracks
        .filter((entry) => entry.groupId === track.id)
        .map((entry) => entry.id);
      items.push({ id: 'sep-group-members', separator: true });
      items.push({
        id: 'select-group-members',
        label: t.value.shell.arrangement.trackHeader.selectGroupMembers,
        disabledReason: firstBlock([memberIds.length === 0, headerReasons.value.noGroupMembers]),
        run: () => setTrackSelection([track.id, ...memberIds], track.id),
      });
    }
    items.push(
      { id: 'sep-channel-preset', separator: true },
      {
        id: 'copy-channel-settings',
        label: t.value.shell.arrangement.trackHeader.copyChannelSettings,
        run: () => copyTrackChannelPreset(track.id),
      },
      {
        id: 'paste-channel-settings',
        label: t.value.shell.arrangement.trackHeader.pasteChannelSettings,
        disabledReason: firstBlock([
          !hasCopiedTrackChannelPreset(),
          headerReasons.value.noCopiedChannel,
        ]),
        run: () => pasteTrackChannelPreset(track.id),
      },
      {
        id: 'save-channel-preset',
        label: t.value.shell.arrangement.trackHeader.savePreset,
        disabledReason: presetStorageBlocked.value,
        run: () => savePreset(track),
      },
      {
        id: 'apply-channel-preset',
        label: t.value.shell.arrangement.trackHeader.applyPreset,
        disabledReason: savedPresetsBlocked.value,
        children: savedTrackPresets.value.map((preset) => ({
          id: `apply-channel-preset-${preset.name}`,
          label: preset.name,
          run: () => applyTrackChannelPreset(track.id, preset),
        })),
      },
      {
        id: 'delete-channel-preset',
        label: t.value.shell.arrangement.trackHeader.deletePreset,
        disabledReason: savedPresetsBlocked.value,
        children: savedTrackPresets.value.map((preset) => ({
          id: `delete-channel-preset-${preset.name}`,
          label: preset.name,
          danger: true,
          run: () => deletePreset(preset.name),
        })),
      },
    );
    items.push(
      { id: 'sep-2', separator: true },
      {
        id: 'color',
        label: t.value.shell.arrangement.trackHeader.nextColor,
        run: () => cycleColor(track),
      },
    );
    if (track.kind !== 'group') {
      items.push({
        id: 'freeze',
        label: track.frozen
          ? t.value.shell.arrangement.trackHeader.unfreeze
          : t.value.shell.arrangement.trackHeader.freeze,
        disabledReason: freezeBlocked(track),
        run: () => {
          void onToggleFreeze(track);
        },
      });
      if (trackHasClips(track)) {
        items.push({
          id: 'bounce',
          label: t.value.shell.arrangement.trackHeader.bounceInPlace,
          disabledReason: bounceBlocked(track),
          run: () => {
            void onBounce(track);
          },
        });
      }
    }
    const groups = store.mixer.vcaGroups ?? [];
    items.push({ id: 'sep-vca', separator: true });
    for (const group of groups) {
      const assigned = track.vcaId === group.id;
      items.push({
        id: `vca-${group.id}`,
        label: group.name,
        checked: assigned,
        run: () => setTrackVca(track.id, assigned ? null : group.id),
      });
    }
    if (groups.length < MAX_VCA_GROUPS) {
      items.push({
        id: 'vca-new',
        label: t.value.shell.arrangement.trackHeader.newVcaGroup,
        run: () => setTrackVca(track.id, addVcaGroup()),
      });
    }
    const generatedPart = partForTrack(track);
    if (generatedPart !== null) {
      items.push(
        { id: 'sep-regenerate', separator: true },
        {
          id: 'regenerate',
          label: t.value.shell.arrangement.trackHeader.regenerate,
          disabledReason: frozenReason(track),
          run: () => emit('regenerateTrack', track.id, generatedPart),
        },
      );
    }
    items.push(
      { id: 'sep-3', separator: true },
      {
        id: 'delete',
        label: t.value.shell.arrangement.trackHeader.removeTrack,
        danger: true,
        run: () => void onDelete(track),
      },
    );
    openContextMenu(event.clientX, event.clientY, items);
  }

  return { onContextMenu };
}
