import { mixerSnapshotSlotsKey } from './command/mixer-snapshots';
import { canonicalJson, fnv1a32Hex } from './hash';
import { midiCcBindingsKey } from './midi-learn-targets';
import type { useProjectStore } from './store';

type ProjectStore = ReturnType<typeof useProjectStore>;

/**
 * Returns the store mirror fields that make up the persisted project document.
 *
 * Autosave and dirty-state tracking must watch the same surface so adding a
 * persisted field cannot make one indicator update without the other.
 */
export function persistedProjectStateKey(store: ProjectStore) {
  return fnv1a32Hex(
    canonicalJson({
      name: store.projectName,
      tracks: store.tracks,
      clips: store.clips,
      markers: store.markers,
      sections: store.sections,
      tempoSegments: store.tempoSegments,
      timeSignatures: store.timeSignatures,
      // Keep the complete serialized control-surface block in the revision
      // key, including bankOffset: serialization persists that field, and a
      // direct surface-setting change must dirty/autosave the project.
      controlSurface: store.controlSurface,
      mixer: store.mixer,
      externalMidiDefault: store.projectExternalMidi,
      scoreAnnotations: store.scoreAnnotations,
      displayTransposeSemitones: store.displayTransposeSemitones,
      scoreDisplaySettings: store.scoreDisplaySettings,
      scaleHighlight: store.scaleHighlight,
      pickupLengthPpq: store.pickupLengthPpq,
      automationLanes: store.automationLanes,
      chords: store.chords,
      // Both registries mutate in place/outside the Pinia mirror, so fold
      // their deterministic content signatures into the same revision.
      midiCcBindings: midiCcBindingsKey(store.midiCcBindings),
      mixerSnapshots: mixerSnapshotSlotsKey(),
    }),
  );
}
