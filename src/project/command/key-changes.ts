/**
 * Applies detected key-change proposals as `Key:` markers.
 *
 * The proposal set and which of them are checked live in the dialog; this
 * module only turns the ones the user kept into markers, all as one undoable
 * edit, mirroring {@link setMarker}'s store-only shape (no native Project
 * call backs a marker).
 */

import { isMinorKey } from '@libraz/libcantus';
import { keyScaleToKeyFifths } from '@/compose/key';
import type { KeyChangeProposal } from '@/compose/key-changes';
import { keyMarkerName } from '@/compose/key-name';
import { allocateMarkerId, useProjectStore } from '../store';
import { execute } from './history';

/**
 * Adds one `Key:` marker per selected proposal as a single undoable edit.
 *
 * @param selected Proposals the user kept, from {@link proposeKeyChanges}.
 * @returns The number of markers added.
 * @throws {RangeError} When `selected` is empty; applying nothing is not success.
 */
export function applyKeyChangeMarkers(selected: ReadonlyArray<KeyChangeProposal>): number {
  if (selected.length === 0) {
    throw new RangeError('No key changes selected');
  }
  const store = useProjectStore();
  return execute(0, () => {
    const added = selected.map((proposal) => {
      const fifths = keyScaleToKeyFifths(proposal.key);
      const minor = isMinorKey(proposal.key);
      return {
        id: allocateMarkerId(),
        ppq: proposal.startPpq,
        name: keyMarkerName(fifths, minor),
      };
    });
    store.markers = [...store.markers, ...added].sort((a, b) => a.ppq - b.ppq || a.id - b.id);
    store.refresh();
    return added.length;
  });
}
