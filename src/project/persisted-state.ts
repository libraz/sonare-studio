import { midiCcBindingsKey } from '@/ui/midi/midi-learn';
import type { useProjectStore } from './store';

type ProjectStore = ReturnType<typeof useProjectStore>;

/**
 * Returns the store mirror fields that make up the persisted project document.
 *
 * Autosave and dirty-state tracking must watch the same surface so adding a
 * persisted field cannot make one indicator update without the other.
 */
export function persistedProjectStateKey(store: ProjectStore) {
  return [
    store.projectName,
    store.tracks,
    store.clips,
    store.markers,
    store.sections,
    store.tempoSegments,
    store.timeSignatures,
    store.mixer,
    store.scoreAnnotations,
    store.displayTransposeSemitones,
    store.automationLanes,
    store.chords,
    // The binding map is mutated in place, so observe its contents.
    midiCcBindingsKey(store.midiCcBindings),
  ] as const;
}
