/**
 * The cell the pencil would write, in the active clip's source frame: the
 * draft note while a draw drag runs, otherwise the draw cell under the hover.
 * Only the draw tool has a cell. Also formats one row's placement verdict for
 * the piano roll's live status cell.
 */

import { type ComputedRef, computed, type Ref } from 'vue';
import type { PlacementReason, PlacementVerdict } from '@/compose/placement';
import type { EditorNote } from '@/project/types';
import type { EditorToolId } from '@/ui/editor/tools';
import { formatMessage, type Messages } from '@/ui/i18n';

/** A candidate note cell in source-relative PPQ. */
export interface PlacementCell {
  startPpq: number;
  lengthPpq: number;
}

/**
 * @param deps.hoverPpq Hovered source PPQ, null while the pointer is off the grid.
 * @param deps.previewNotes In-flight gesture preview; a draw's draft note has a negative id.
 * @param deps.drawCellAt Snaps a hovered PPQ to the cell a click there would draw.
 */
export function usePlacementCell(deps: {
  hoverPpq: Ref<number | null>;
  tool: Ref<EditorToolId>;
  previewNotes: Ref<EditorNote[] | null>;
  drawCellAt: (ppq: number) => PlacementCell;
}): ComputedRef<PlacementCell | null> {
  return computed(() => {
    if (deps.tool.value !== 'draw') return null;
    const preview = deps.previewNotes.value;
    if (preview !== null) {
      const draft = preview.find((note) => note.id < 0);
      return draft === undefined
        ? null
        : { startPpq: draft.startPpq, lengthPpq: draft.durationPpq };
    }
    const ppq = deps.hoverPpq.value;
    return ppq === null ? null : deps.drawCellAt(ppq);
  });
}

/** Reasons that come from a sounding clash, so naming the partner explains them. */
const CLASH_REASONS: ReadonlySet<PlacementReason> = new Set([
  'preparedSuspension',
  'steppedNonChordTone',
  'unpreparedDissonance',
  'leapIntoDissonance',
  'accompanimentThinnable',
  'accompanimentRootClash',
]);

type PlacementMessages = Messages['shell']['pianoRoll']['placement'];

/**
 * One row's verdict as status text: the level, its heaviest reason, and the
 * clashing notes when that reason is a clash.
 *
 * @param trackName Display name of a partner's track; null is the edited clip.
 */
export function describePlacementVerdict(
  verdict: PlacementVerdict,
  strings: PlacementMessages,
  formatPitch: (pitch: number) => string,
  trackName: (trackId: number | null) => string,
): string {
  const level = strings.level[verdict.level];
  const reason = verdict.reasons[0];
  if (reason === undefined) return level;
  const partnerList = (partners: PlacementVerdict['partners']): string =>
    [
      ...new Set(
        partners.map((partner) =>
          formatMessage(strings.partner, {
            track: trackName(partner.trackId),
            pitch: formatPitch(partner.pitch),
          }),
        ),
      ),
    ].join(', ');
  if (reason === 'accompanimentThinned') {
    const thinned = verdict.partners.filter((partner) => partner.thinned);
    return `${level}: ${formatMessage(strings.thins, { partners: partnerList(thinned) })}`;
  }
  const text = strings.reason[reason];
  if (!CLASH_REASONS.has(reason) || verdict.partners.length === 0) return `${level}: ${text}`;
  return `${level}: ${formatMessage(strings.withPartners, {
    text,
    partners: partnerList(verdict.partners),
  })}`;
}
