/**
 * Right-click clip menu of the arrangement view and the clip actions only it
 * triggers: glue, consolidate, align, slice, crossfade, rename and MIDI export.
 */

import type { Ref } from 'vue';
import { promptDialog } from '@/composables/useDialogs';
import { useFileDownloads } from '@/composables/useFileDownloads';
import { confirmLossReport } from '@/composables/useLossConfirm';
import { describeError } from '@/lib/errors';
import {
  type CrossfadeBlockReason,
  crossfadePartner,
  DEFAULT_CLIP_CROSSFADE_PPQ,
  planClipCrossfade,
} from '@/project/clip-crossfade';
import { touchingClipRunIds } from '@/project/clip-runs';
import { clipSplitBlockReason } from '@/project/clip-split';
import { canPasteClipAt, hasCopiedClip } from '@/project/command/clips-clipboard';
import {
  alignClipToReference,
  applyGrooveToActiveClip,
  captureGrooveFromActiveClip,
  consolidateAudioClips,
  copyActiveClip,
  crossfadeClips,
  cutActiveClip,
  deleteClip,
  duplicateClip,
  glueMidiClips,
  pasteClipAt,
  renameClip,
  setActiveClip,
  setClipLoop,
  sliceAudioClipAtTransients,
  splitClip,
} from '@/project/commands';
import { exportClipSmf } from '@/project/export';
import { unfreezeTrack } from '@/project/freeze';
import { grooveTemplateIsUsable } from '@/project/groove';
import { useProjectStore } from '@/project/store';
import { clipKind, type EditorClip, isAudioClip } from '@/project/types';
import type { AudioClipSourceBounds } from '@/ui/arrangement/audio-clip-content';
import { firstBlock } from '@/ui/disabled-reason';
import { formatMessage, useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { shortcutHint } from '@/ui/settings/shortcut-hint';

/** Configuration for {@link useArrangementClipMenu}. */
export interface UseArrangementClipMenuOptions {
  /** Error line shown above the view; actions clear and set it. */
  error: Ref<string>;
  /** Result line shown above the view until the next action. */
  notice: Ref<string>;
  /** Whether the track with this id is frozen. */
  isTrackFrozen(trackId: number | undefined): boolean;
  /** Current snap grid step in PPQ (0 when snapping is off). */
  gridPpq: Ref<number>;
  /** Resolves a point on the arrangement's meter-aware snap grid. */
  snapPpq(ppq: number): number;
  /** Trim bounds of a clip against its backing asset; null when unbounded. */
  sourceBoundsFor(clipId: number): AudioClipSourceBounds | null;
  /** Resolves the content track under a viewport (client) y coordinate, or null. */
  trackIdAtClientY(clientY: number): number | null;
}

/** Clip context-menu handler returned by {@link useArrangementClipMenu}. */
export interface ArrangementClipMenu {
  /** Builds and opens the right-click menu for a clip (or an empty lane). */
  onClipContext(payload: { x: number; y: number; clipId: number | null; ppq: number }): void;
}

/**
 * Creates the right-click clip menu for one arrangement view.
 *
 * @param options - Shared error/notice lines, snap grid, source bounds and track hit-testing.
 * @returns The context-menu handler.
 */
export function useArrangementClipMenu(
  options: UseArrangementClipMenuOptions,
): ArrangementClipMenu {
  const {
    error,
    notice,
    isTrackFrozen,
    gridPpq,
    snapPpq: snapArrangementPpq,
    sourceBoundsFor,
    trackIdAtClientY,
  } = options;
  const store = useProjectStore();
  const { t } = useI18n();
  const { downloadBlobFile } = useFileDownloads();

  function glueClusterClipIds(clipId: number): number[] {
    const source = store.clips.find((clip) => clip.id === clipId);
    if (!source || isAudioClip(source)) return [];
    return touchingClipRunIds(
      store.clips.filter(
        (clip) =>
          clip.trackId === source.trackId && !isAudioClip(clip) && clipKind(clip) === 'midi',
      ),
      clipId,
    );
  }

  function audioConsolidateClipIds(clipId: number): number[] {
    const source = store.clips.find((clip) => clip.id === clipId);
    if (!source || !isAudioClip(source)) return [];
    return touchingClipRunIds(
      store.clips.filter((clip) => clip.trackId === source.trackId && isAudioClip(clip)),
      clipId,
    );
  }

  /**
   * Resolves the crossfade the clip's right edge would form: which clip it pairs
   * with and why it is unavailable, so the menu can show the reason instead of a
   * silently disabled action.
   */
  function crossfadeStateFor(clipId: number): {
    partnerId: number | null;
    reason: CrossfadeBlockReason | null;
  } {
    const clip = store.clips.find((entry) => entry.id === clipId);
    if (!clip) return { partnerId: null, reason: null };
    const partner = crossfadePartner(clip, store.clips);
    if (!partner) return { partnerId: null, reason: null };
    const plan = planClipCrossfade(clip, partner, crossfadeOptionsFor(clip, partner));
    return {
      partnerId: partner.id,
      reason: 'reason' in plan ? plan.reason : null,
    };
  }

  /** Default crossfade length and the source limit that lets touching clips overlap. */
  function crossfadeOptionsFor(
    a: { id: number; startPpq: number },
    b: { id: number; startPpq: number },
  ): { lengthPpq: number; leftSourceEndPpq?: number } {
    const leftId = a.startPpq <= b.startPpq ? a.id : b.id;
    const bounds = sourceBoundsFor(leftId);
    return {
      lengthPpq: gridPpq.value > 0 ? gridPpq.value : DEFAULT_CLIP_CROSSFADE_PPQ,
      ...(bounds === null ? {} : { leftSourceEndPpq: bounds.maxEndPpq }),
    };
  }

  /** Localized explanation for a blocked crossfade. */
  function crossfadeReasonText(reason: CrossfadeBlockReason): string {
    return t.value.shell.arrangement.clipActions.crossfadeReasons[reason];
  }

  /** Crossfades the clip with its right-hand neighbour, reporting refusals inline. */
  function runCrossfade(clipId: number): void {
    const clip = store.clips.find((entry) => entry.id === clipId);
    if (!clip) return;
    const partner = crossfadePartner(clip, store.clips);
    if (!partner) return;
    try {
      crossfadeClips(clip.id, partner.id, crossfadeOptionsFor(clip, partner));
    } catch (cause) {
      const plan = planClipCrossfade(clip, partner, crossfadeOptionsFor(clip, partner));
      error.value =
        'reason' in plan
          ? crossfadeReasonText(plan.reason)
          : describeError(cause, t.value.notices.errors);
    }
  }

  /**
   * Cuts an audio clip at its transients, optionally snapping the slices to the
   * arrangement grid. Failures surface in the view's error line instead of
   * leaving the clip half-sliced (the command itself is atomic).
   */
  async function runTransientSlice(clipId: number, quantize: boolean): Promise<void> {
    try {
      const ids = await sliceAudioClipAtTransients(clipId, {
        quantize,
        snap: snapArrangementPpq,
      });
      if (ids !== null && ids.length < 2)
        error.value = t.value.shell.arrangement.clipActions.sliceNoTransients;
    } catch (cause) {
      error.value = describeError(cause, t.value.notices.errors);
    }
  }

  /** Audio clips that cover a clip's whole window, the references it can be aligned to. */
  function alignmentReferences(clip: EditorClip): EditorClip[] {
    const end = clip.startPpq + clip.lengthPpq;
    return store.clips.filter(
      (other) =>
        other.id !== clip.id &&
        isAudioClip(other) &&
        other.startPpq <= clip.startPpq &&
        other.startPpq + other.lengthPpq >= end,
    );
  }

  /** Warps an audio clip so its timing follows a reference clip. */
  function alignToReference(clip: EditorClip, reference: EditorClip): void {
    error.value = '';
    notice.value = '';
    void (async () => {
      try {
        const outcome = await alignClipToReference(clip.id, reference.id);
        if (outcome.applied) {
          notice.value = formatMessage(t.value.shell.arrangement.alignedTo, {
            clip: clip.name,
            reference: reference.name,
          });
        } else {
          error.value = formatMessage(t.value.shell.arrangement.alignRefused[outcome.reason], {
            reference: reference.name,
          });
        }
      } catch (err) {
        error.value = describeError(err, t.value.notices.errors);
      }
    })();
  }

  /** Builds and opens the right-click menu for a clip (or an empty lane). */
  function onClipContext(payload: {
    x: number;
    y: number;
    clipId: number | null;
    ppq: number;
  }): void {
    const clip = payload.clipId === null ? null : store.clips.find((c) => c.id === payload.clipId);
    if (!clip) {
      const trackId = trackIdAtClientY(payload.y);
      if (trackId === null) return;
      const pastePpq = snapArrangementPpq(payload.ppq);
      if (!canPasteClipAt(trackId, pastePpq)) return;
      openContextMenu(payload.x, payload.y, [
        {
          id: 'paste',
          label: t.value.shell.arrangement.clipActions.paste,
          hint: shortcutHint('edit.paste'),
          run: () => pasteClipAt(trackId, pastePpq),
        },
      ]);
      return;
    }
    setActiveClip(clip.id);
    const end = clip.startPpq + clip.lengthPpq;
    const splitPpq = snapArrangementPpq(payload.ppq);
    const pastePpq = splitPpq;
    const glueIds = glueClusterClipIds(clip.id);
    const consolidateIds = audioConsolidateClipIds(clip.id);
    const frozen = isTrackFrozen(clip.trackId);
    const crossfade = crossfadeStateFor(clip.id);
    const r = t.value.reasons;
    const why = t.value.shell.arrangement.reasons;
    const actions = t.value.shell.arrangement.clipActions;
    const frozenBlock = firstBlock([frozen, r.trackFrozen]);
    const audio = isAudioClip(clip);
    const sliceBlocked = firstBlock(
      frozenBlock,
      [!audio, why.audioClipsOnly],
      [clip.loopEnabled, why.loopOn],
    );
    const items: ContextMenuItem[] = [
      ...(frozen
        ? [
            {
              id: 'unfreeze',
              label: t.value.shell.arrangement.trackHeader.unfreeze,
              run: () => unfreezeTrack(clip.trackId),
            },
            { id: 'sep-frozen', separator: true },
          ]
        : []),
      {
        id: 'split',
        label: t.value.shell.arrangement.splitHere,
        hint: shortcutHint('tool.split'),
        disabledReason: firstBlock(frozenBlock, [
          clipSplitBlockReason(clip, splitPpq) !== null,
          t.value.shell.arrangement.loopSplitUnavailable,
        ]),
        run: () => setActiveClip(splitClip(clip.id, splitPpq)),
      },
      {
        id: 'duplicate',
        label: actions.duplicate,
        hint: shortcutHint('arrange.duplicateClip'),
        disabledReason: frozenBlock,
        run: () => duplicateClip(clip.id, end),
      },
      { id: 'sep-clipboard', separator: true },
      {
        id: 'copy',
        label: actions.copy,
        hint: shortcutHint('edit.copy'),
        run: () => copyActiveClip(),
      },
      {
        id: 'cut',
        label: actions.cut,
        hint: shortcutHint('edit.cut'),
        disabledReason: frozenBlock,
        run: () => cutActiveClip(),
      },
      {
        id: 'paste',
        label: actions.paste,
        hint: shortcutHint('edit.paste'),
        disabledReason: firstBlock(
          frozenBlock,
          [!hasCopiedClip(), r.nothingToPaste],
          [!canPasteClipAt(clip.trackId, pastePpq), r.noRoomToPaste],
        ),
        run: () => pasteClipAt(clip.trackId, pastePpq),
      },
      { id: 'sep-clip-edit', separator: true },
      {
        id: 'glue',
        label: actions.glue,
        disabledReason: firstBlock(
          frozenBlock,
          [audio, why.midiClipsOnly],
          [glueIds.length < 2, why.nothingToJoin],
        ),
        run: () => glueMidiClips(glueIds),
      },
      {
        id: 'consolidate-audio',
        label: actions.consolidateAudio,
        disabledReason: firstBlock(
          frozenBlock,
          [!audio, why.audioClipsOnly],
          [consolidateIds.length < 2, why.nothingToJoin],
        ),
        run: () => consolidateAudioClips(consolidateIds),
      },
      ...(audio
        ? (() => {
            const references = alignmentReferences(clip);
            const trackName = (trackId: number): string =>
              store.tracks.find((track) => track.id === trackId)?.name ?? '';
            return [
              {
                id: 'align-to',
                label: t.value.shell.arrangement.alignTo,
                disabledReason: firstBlock(frozenBlock, [
                  references.length === 0,
                  t.value.shell.arrangement.alignToNone,
                ]),
                children: references.map((reference) => ({
                  id: `align-to-${reference.id}`,
                  label: `${trackName(reference.trackId)} · ${reference.name}`,
                  run: () => alignToReference(clip, reference),
                })),
              },
            ];
          })()
        : []),
      {
        id: 'slice-transients',
        label: actions.sliceTransients,
        disabledReason: sliceBlocked,
        run: () => runTransientSlice(clip.id, false),
      },
      {
        id: 'slice-transients-quantize',
        label: actions.sliceTransientsQuantize,
        disabledReason: sliceBlocked,
        run: () => runTransientSlice(clip.id, true),
      },
      {
        id: 'crossfade',
        label: actions.crossfade,
        disabledReason: firstBlock(
          frozenBlock,
          [crossfade.partnerId === null, actions.crossfadeNoPartner],
          crossfade.reason === null ? null : crossfadeReasonText(crossfade.reason),
        ),
        run: () => runCrossfade(clip.id),
      },
      {
        id: 'rename',
        label: actions.rename,
        disabledReason: frozenBlock,
        run: () => renameClipFromPrompt(clip.id, clip.name),
      },
      {
        id: 'loop',
        label: clip.loopEnabled ? actions.disableLoop : actions.enableLoop,
        disabledReason: frozenBlock,
        run: () => setClipLoop(clip.id, !clip.loopEnabled),
      },
    ];
    if (!isAudioClip(clip)) {
      items.push(
        { id: 'sep-groove', separator: true },
        {
          id: 'groove-capture',
          label: actions.grooveCapture,
          run: () => {
            store.grooveTemplate = captureGrooveFromActiveClip();
          },
        },
        {
          id: 'groove-apply',
          label: actions.grooveApply,
          disabledReason: firstBlock(frozenBlock, [
            !grooveTemplateIsUsable(store.grooveTemplate),
            t.value.shell.editor.reasons.noGroove,
          ]),
          run: () => {
            const groove = store.grooveTemplate;
            if (groove) applyGrooveToActiveClip(groove, store.quantizeStrength);
          },
        },
        {
          id: 'export-midi',
          label: actions.exportMidi,
          run: () => exportClipToSmf(clip.id),
        },
      );
    }
    items.push(
      { id: 'sep-1', separator: true },
      {
        id: 'delete',
        label: t.value.common.delete,
        hint: shortcutHint('arrange.deleteClip'),
        danger: true,
        disabledReason: frozenBlock,
        run: () => deleteClip(clip.id),
      },
    );
    openContextMenu(payload.x, payload.y, items);
  }

  /** Exports a single MIDI clip to a Standard MIDI File download. */
  function exportClipToSmf(clipId: number): void {
    error.value = '';
    void (async () => {
      try {
        const result = await exportClipSmf(clipId);
        const copy = t.value.shell.project.midiExportLoss;
        if (!(await confirmLossReport(result.loss, { ...copy.smf, items: copy.items }))) return;
        downloadBlobFile(
          new Blob([new Uint8Array(result.bytes)], { type: 'audio/midi' }),
          result.filename,
        );
      } catch (err) {
        error.value = describeError(err, t.value.notices.errors);
      }
    })();
  }

  /** Renames a clip via a prompt, ignoring an empty or unchanged name. */
  async function renameClipFromPrompt(clipId: number, current: string): Promise<void> {
    const next = await promptDialog({
      title: t.value.shell.arrangement.clipActions.renameTitle,
      message: t.value.shell.arrangement.clipActions.renameMessage,
      defaultValue: current,
      placeholder: t.value.shell.arrangement.clipActions.clipName,
      confirmLabel: t.value.shell.arrangement.clipActions.renameConfirm,
    });
    if (next && next !== current) renameClip(clipId, next);
  }

  return { onClipContext };
}
