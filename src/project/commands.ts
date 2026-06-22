export type { AssistSidecar } from './command/assist';
export { listAssistSidecars, setAssistSidecar } from './command/assist';
export {
  removeAutomationLane,
  setAutomationLaneEnabled,
  setAutomationLanePoints,
} from './command/automation';
export {
  clearProjectChords,
  detectChordsForClip,
  detectChordsFromAudioClip,
  setProjectChords,
} from './command/chords';
export type { AddAudioClipInput, AddBouncedClipInput, AddMidiClipInput } from './command/clips';
export {
  addAudioClip,
  addBouncedClip,
  addMidiClip,
  deleteClip,
  dropClipTakes,
  duplicateClip,
  moveClip,
  renameClip,
  setActiveClip,
  setActiveTrack,
  setClipActiveTake,
  setClipCcLane,
  setClipChannelPressure,
  setClipCompSegments,
  setClipFades,
  setClipGain,
  setClipLoop,
  setClipPitchBend,
  setClipPolyPressure,
  setClipTakes,
  setClipWarp,
  setTrackFrozen,
  splitClip,
  trimClip,
} from './command/clips';
export type { CommandGestureOptions } from './command/history';
export { canRedo, canUndo, clearHistory, redo, undo } from './command/history';
export {
  addMasteringProcessor,
  removeMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
} from './command/mastering';
export { extractMelodyFromAudioClip } from './command/melody';
export { bakeClipMidiFx } from './command/midi-fx';
export type { MixerSnapshot, MixerSnapshotTrack, MixerStripTarget } from './command/mixer';
export {
  addInsert,
  addMixerBus,
  addVcaGroup,
  applyMixerSnapshot,
  buildMixerSnapshot,
  captureMixerSnapshot,
  mergeMixerSnapshot,
  removeInsert,
  removeMixerBus,
  removeVcaGroup,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
  setMixerBusGain,
  setSend,
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripEq,
  setStripGain,
  setStripOutputBus,
  setStripPan,
  setStripPanLaw,
  setStripPanMode,
  setTrackInstrument,
  setTrackSoloSafe,
  setTrackVca,
  setVcaGroupGain,
} from './command/mixer';
export type { MixerSnapshotSlot } from './command/mixer-snapshots';
export {
  activeMixerSnapshotSlot,
  clearMixerSnapshots,
  mixerSnapshotFilled,
  recallMixerSnapshot,
  saveMixerSnapshot,
} from './command/mixer-snapshots';
export {
  addNote,
  deleteNotes,
  humanizeSelectionVelocity,
  nudgeSelectionVelocity,
  quantizeSelection,
  quantizeSelectionLengths,
  setSelection,
  snapSelectionToScale,
  splitNote,
  transposeSelection,
  updateNotes,
} from './command/notes';
export type { NoteAnnotationUpdate } from './command/score-annotations';
export {
  clearNoteAnnotation,
  setDisplayTranspose,
  setNoteAnnotation,
} from './command/score-annotations';
export { splitAudioClipToStems } from './command/stems';
export type { SectionInput } from './command/timeline';
export {
  detectSectionsFromAudioClip,
  removeMarker,
  setMarker,
  setSections,
  setTempoSegments,
  setTimeSignatures,
} from './command/timeline';
export type { AddTrackInput } from './command/tracks';
export {
  addAudioTrack,
  addGroupTrack,
  addTrack,
  removeTrack,
  renameTrack,
  reorderTracks,
  setTrackColor,
  setTrackGroup,
  setTrackMute,
  setTrackPan,
  setTrackSolo,
  setTrackVolume,
} from './command/tracks';
