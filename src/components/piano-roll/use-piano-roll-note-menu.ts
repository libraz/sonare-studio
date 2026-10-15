/**
 * Right-click note menu for the piano roll: the selection-wide operation items
 * shared by the note and empty-space menus, and the handler that assembles and
 * opens the menu for a note or an empty grid position.
 */

import type { Ref } from 'vue';
import {
  applyGrooveToSelection,
  captureGrooveFromSelection,
  cleanupOverlaps,
  copySelectedNotes,
  cutSelectedNotes,
  deleteNotes,
  duplicateSelection,
  fadeSelectionVelocity,
  humanizeSelectionVelocity,
  legatoSelection,
  mergeSelection,
  normalizeSelectionVelocity,
  pasteNotesAt,
  quantizeSelection,
  quantizeSelectionEnds,
  quantizeSelectionLengths,
  repeatSelection,
  scaleSelectionVelocityDynamics,
  selectOutOfScale,
  selectOverlaps,
  selectSameChannel,
  selectSamePitch,
  selectVelocityRange,
  setSelection,
  snapSelectionToScale,
  splitNote,
  tidySelection,
  transposeSelection,
  transposeSelectionDiatonic,
} from '@/project/commands';
import { grooveTemplateIsUsable } from '@/project/groove';
import { midiSourcePpqToTimeline } from '@/project/midi-projection';
import { useProjectStore } from '@/project/store';
import { firstBlock } from '@/ui/disabled-reason';
import { useI18n } from '@/ui/i18n';
import { type ContextMenuItem, openContextMenu } from '@/ui/menu/context-menu';
import { detectPlatform, formatKeyCombo } from '@/ui/settings/key-combo';
import { shortcutHint } from '@/ui/settings/shortcut-hint';

/** Pointer payload of a right-click on the note grid. */
export interface NoteContextPayload {
  x: number;
  y: number;
  noteId: number | null;
  ppq: number;
}

/** Configuration for {@link usePianoRollNoteMenu}. */
export interface UsePianoRollNoteMenuOptions {
  /** True while the active track is frozen and its content cannot be edited. */
  contentReadOnly: Ref<boolean>;
  /** Current snap grid step in PPQ (the configured division). */
  gridPpq: Ref<number>;
  /** Resolves a point on the piano roll's meter-aware snap grid. */
  snapPpq(ppq: number): number;
  /** Length in PPQ of the bar containing a piano-roll position. */
  barLengthPpq(ppq: number): number;
}

/** Note context-menu handler returned by {@link usePianoRollNoteMenu}. */
export interface PianoRollNoteMenu {
  /** Builds and opens the right-click menu for a note (or empty grid space). */
  onNoteContext(payload: NoteContextPayload): void;
}

/**
 * Creates the right-click note menu for one piano-roll editor.
 *
 * @param options - Read-only flag, grid step and meter-aware snap.
 * @returns The context-menu handler.
 */
export function usePianoRollNoteMenu(options: UsePianoRollNoteMenuOptions): PianoRollNoteMenu {
  const { contentReadOnly, gridPpq, snapPpq, barLengthPpq } = options;
  const store = useProjectStore();
  const { t } = useI18n();
  /** Edits are refused on a frozen track; every editing item carries this reason. */
  const frozen = (): string | null => (contentReadOnly.value ? t.value.reasons.trackFrozen : null);

  /** Maximum per-note random velocity jitter applied by the Humanize action. */
  const HUMANIZE_VELOCITY_AMOUNT = 12;

  /** Length of the bar holding the start of the selection, the repeat interval. */
  function selectionBarPpq(): number {
    const selected = store.selectedNotes;
    if (selected.length === 0) return 0;
    return barLengthPpq(Math.min(...selected.map((note) => note.startPpq)));
  }

  /** Selection-wide note operations shared by the note and empty-space menus. */
  function selectionOpItems(): ContextMenuItem[] {
    return [
      {
        id: 'edit-submenu',
        label: t.value.shell.pianoRoll.context.edit,
        disabledReason: frozen(),
        children: [
          {
            id: 'duplicate-grid',
            label: t.value.shell.pianoRoll.context.duplicateByGrid,
            hint: formatKeyCombo('alt+arrowright', detectPlatform()),
            run: () => duplicateSelection(gridPpq.value),
          },
          {
            id: 'repeat-bar',
            label: t.value.shell.pianoRoll.context.repeatBar,
            run: () => repeatSelection(3, selectionBarPpq()),
          },
          { id: 'sep-edit-tools', separator: true },
          {
            id: 'legato',
            label: t.value.shell.pianoRoll.context.legato,
            run: () => legatoSelection(),
          },
          {
            id: 'merge',
            label: t.value.shell.pianoRoll.context.merge,
            run: () => mergeSelection(),
          },
          {
            id: 'cleanup-overlaps',
            label: t.value.shell.pianoRoll.context.cleanupOverlaps,
            run: () => cleanupOverlaps(),
          },
          {
            id: 'tidy',
            label: t.value.shell.pianoRoll.context.tidy,
            run: () => tidySelection(),
          },
        ],
      },
      {
        id: 'quantize-submenu',
        label: t.value.shell.pianoRoll.context.quantize,
        disabledReason: frozen(),
        children: [
          {
            id: 'quantize',
            label: t.value.shell.pianoRoll.context.quantizeStarts,
            hint: shortcutHint('edit.quantizeSelection'),
            run: () => quantizeSelection(),
          },
          {
            id: 'quantize-len',
            label: t.value.shell.pianoRoll.context.quantizeLengths,
            run: () => quantizeSelectionLengths(),
          },
          {
            id: 'quantize-end',
            label: t.value.shell.pianoRoll.context.quantizeEnds,
            run: () => quantizeSelectionEnds(),
          },
          { id: 'sep-quantize-feel', separator: true },
          ...[0.25, 0.5, 0.75, 1].map((strength) => ({
            id: `quantize-strength-${strength}`,
            label: `${t.value.shell.pianoRoll.midiTransform.strength} ${Math.round(strength * 100)}%`,
            checked: Math.abs(store.quantizeStrength - strength) < 1e-9,
            run: () => {
              store.quantizeStrength = strength;
              quantizeSelection();
            },
          })),
          ...[0, 25, 50, 75, 100].map((swing) => ({
            id: `quantize-swing-${swing}`,
            label: `${t.value.shell.editor.swing} ${swing}%`,
            checked: store.quantizeSwing === swing,
            run: () => {
              store.quantizeSwing = swing;
              quantizeSelection();
            },
          })),
          { id: 'sep-groove', separator: true },
          {
            id: 'groove-capture',
            label: t.value.shell.pianoRoll.context.grooveCapture,
            run: () => {
              store.grooveTemplate = captureGrooveFromSelection();
            },
          },
          {
            id: 'groove-apply',
            label: t.value.shell.pianoRoll.context.grooveApply,
            disabledReason: firstBlock(frozen(), [
              !grooveTemplateIsUsable(store.grooveTemplate),
              t.value.shell.editor.reasons.noGroove,
            ]),
            run: () => {
              const groove = store.grooveTemplate;
              if (groove) applyGrooveToSelection(groove, store.quantizeStrength);
            },
          },
          {
            id: 'groove-clear',
            label: t.value.shell.pianoRoll.context.grooveClear,
            disabledReason: firstBlock([
              store.grooveTemplate === null,
              t.value.shell.editor.reasons.noGroove,
            ]),
            run: () => {
              store.grooveTemplate = null;
            },
          },
        ],
      },
      {
        id: 'transpose-submenu',
        label: t.value.shell.pianoRoll.context.transpose,
        disabledReason: frozen(),
        children: [
          {
            id: 'transpose-up',
            label: t.value.shell.pianoRoll.context.transposeUpOctave,
            hint: shortcutHint('edit.transposeOctaveUp'),
            run: () => transposeSelection(12),
          },
          {
            id: 'transpose-down',
            label: t.value.shell.pianoRoll.context.transposeDownOctave,
            hint: shortcutHint('edit.transposeOctaveDown'),
            run: () => transposeSelection(-12),
          },
          { id: 'sep-transpose', separator: true },
          {
            id: 'diatonic-up',
            label: t.value.shell.pianoRoll.context.diatonicUp,
            run: () => transposeSelectionDiatonic(1),
          },
          {
            id: 'diatonic-down',
            label: t.value.shell.pianoRoll.context.diatonicDown,
            run: () => transposeSelectionDiatonic(-1),
          },
          {
            id: 'snap-scale',
            label: t.value.shell.pianoRoll.context.snapToScale,
            run: () => snapSelectionToScale(),
          },
        ],
      },
      {
        id: 'velocity-submenu',
        label: t.value.shell.pianoRoll.context.velocity,
        disabledReason: frozen(),
        children: [
          {
            id: 'humanize',
            label: t.value.shell.pianoRoll.context.humanizeVelocity,
            run: () => humanizeSelectionVelocity(HUMANIZE_VELOCITY_AMOUNT),
          },
          {
            id: 'vel-fade-in',
            label: t.value.shell.pianoRoll.context.velocityFadeIn,
            run: () => fadeSelectionVelocity(40, 110),
          },
          {
            id: 'vel-fade-out',
            label: t.value.shell.pianoRoll.context.velocityFadeOut,
            run: () => fadeSelectionVelocity(110, 40),
          },
          {
            id: 'vel-normalize',
            label: t.value.shell.pianoRoll.context.velocityNormalize,
            run: () => normalizeSelectionVelocity(110),
          },
          {
            id: 'vel-compress',
            label: t.value.shell.pianoRoll.context.velocityCompress,
            run: () => scaleSelectionVelocityDynamics(0.6),
          },
          {
            id: 'vel-expand',
            label: t.value.shell.pianoRoll.context.velocityExpand,
            run: () => scaleSelectionVelocityDynamics(1.35),
          },
        ],
      },
      {
        id: 'select-submenu',
        label: t.value.shell.pianoRoll.context.select,
        children: [
          {
            id: 'select-same-pitch',
            label: t.value.shell.pianoRoll.context.selectSamePitch,
            run: () => selectSamePitch(),
          },
          {
            id: 'select-same-channel',
            label: t.value.shell.pianoRoll.context.selectSameChannel,
            run: () => selectSameChannel(),
          },
          {
            id: 'select-velocity-range',
            label: t.value.shell.pianoRoll.context.selectVelocityRange,
            run: () => selectVelocityRange(),
          },
          {
            id: 'select-out-scale',
            label: t.value.shell.pianoRoll.context.selectOutOfScale,
            run: () => selectOutOfScale(),
          },
          {
            id: 'select-overlaps',
            label: t.value.shell.pianoRoll.context.selectOverlaps,
            run: () => selectOverlaps(),
          },
        ],
      },
    ];
  }

  /** Builds and opens the right-click menu for a note (or empty grid space). */
  function onNoteContext(payload: NoteContextPayload): void {
    const items: ContextMenuItem[] = [];
    const activeClip = store.activeClip;
    const pasteAtCursor = () => {
      if (activeClip === null) return;
      pasteNotesAt(midiSourcePpqToTimeline(activeClip, payload.ppq));
    };
    if (payload.noteId !== null) {
      const note = store.notes.find((n) => n.id === payload.noteId);
      if (note) {
        if (!store.selection.has(note.id)) setSelection([note.id]);
        const step = store.snapEnabled ? gridPpq.value : 0;
        const splitPpq = step > 0 ? snapPpq(payload.ppq) : payload.ppq;
        const canSplit = splitPpq > note.startPpq && splitPpq < note.startPpq + note.durationPpq;
        items.push(
          {
            id: 'split',
            label: t.value.shell.pianoRoll.context.splitHere,
            hint: shortcutHint('tool.split'),
            disabledReason: firstBlock(frozen(), [
              !canSplit,
              t.value.shell.editor.reasons.splitOutsideNote,
            ]),
            run: () => setSelection([splitNote(note.id, splitPpq)]),
          },
          { id: 'sep-clipboard', separator: true },
          {
            id: 'copy',
            label: t.value.shell.pianoRoll.context.copy,
            hint: shortcutHint('edit.copy'),
            run: () => copySelectedNotes(),
          },
          {
            id: 'cut',
            label: t.value.shell.pianoRoll.context.cut,
            hint: shortcutHint('edit.cut'),
            disabledReason: frozen(),
            run: () => cutSelectedNotes(),
          },
          {
            id: 'paste',
            label: t.value.shell.pianoRoll.context.paste,
            hint: shortcutHint('edit.paste'),
            disabledReason: frozen(),
            run: pasteAtCursor,
          },
          { id: 'sep-selection', separator: true },
          ...selectionOpItems(),
          { id: 'sep-1', separator: true },
          {
            id: 'delete',
            label: t.value.common.delete,
            danger: true,
            hint: shortcutHint('edit.deleteSelectedNotes'),
            disabledReason: frozen(),
            run: () => deleteNotes([...store.selection]),
          },
        );
      }
    } else if (store.selection.size > 0) {
      items.push(
        {
          id: 'copy',
          label: t.value.shell.pianoRoll.context.copy,
          hint: shortcutHint('edit.copy'),
          run: () => copySelectedNotes(),
        },
        {
          id: 'cut',
          label: t.value.shell.pianoRoll.context.cut,
          hint: shortcutHint('edit.cut'),
          disabledReason: frozen(),
          run: () => cutSelectedNotes(),
        },
        {
          id: 'paste',
          label: t.value.shell.pianoRoll.context.paste,
          hint: shortcutHint('edit.paste'),
          disabledReason: frozen(),
          run: pasteAtCursor,
        },
        { id: 'sep-selection', separator: true },
        ...selectionOpItems(),
      );
    } else {
      items.push({
        id: 'paste',
        label: t.value.shell.pianoRoll.context.paste,
        hint: shortcutHint('edit.paste'),
        disabledReason: frozen(),
        run: pasteAtCursor,
      });
    }
    openContextMenu(payload.x, payload.y, items);
  }

  return { onNoteContext };
}
