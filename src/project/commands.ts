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
  consolidateAudioClips,
  deleteClip,
  dropClipTakes,
  duplicateClip,
  glueMidiClips,
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
  setClipPolyPressureForPitches,
  setClipTakes,
  setClipWarp,
  setTrackFrozen,
  splitClip,
  trimClip,
} from './command/clips';
export type { GenerateProgressionParams } from './command/generate-progression';
export { generateProgressionCommand } from './command/generate-progression';
export type { CommandGestureOptions, HistoryReferencedMediaIds } from './command/history';
export {
  canRedo,
  canUndo,
  clearHistory,
  collectHistoryReferencedMediaIds,
  redo,
  undo,
} from './command/history';
export {
  addMasteringProcessor,
  removeMasteringProcessor,
  reorderMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
  setMasteringPresetOverride,
} from './command/mastering';
export { extractMelodyFromAudioClip } from './command/melody';
export {
  clearAllMidiCcBindings,
  clearMidiCcBinding,
  setMidiCcBinding,
} from './command/midi-bindings';
export { bakeClipMidiFx, clearTrackMidiFx, setTrackMidiFx } from './command/midi-fx';
export type { AddRecordedMidiClipInput } from './command/midi-recording';
export { addRecordedMidiClip } from './command/midi-recording';
export type { MixerSnapshot, MixerSnapshotTrack, MixerStripTarget } from './command/mixer';
export {
  addInsert,
  addMixerBus,
  addVcaGroup,
  applyMixerSceneJson,
  applyMixerSnapshot,
  captureMixerSnapshot,
  isMixerBusStripTarget,
  mixerBusIdFromTarget,
  mixerBusStripTarget,
  removeInsert,
  removeMixerBus,
  removeVcaGroup,
  renameMixerBus,
  renameVcaGroup,
  reorderInsert,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
  setMixerBusGain,
  setMixerSoloMode,
  setProjectExternalMidiDefault,
  setProjectExternalMidiDefaultForTracks,
  setSend,
  setStripChannelDelaySamples,
  setStripDualPan,
  setStripEq,
  setStripGain,
  setStripInputTrim,
  setStripOutputBus,
  setStripPan,
  setStripPanLaw,
  setStripPanMode,
  setStripPolarityInvert,
  setStripWidth,
  setTrackExternalMidiMode,
  setTrackExternalMidiModes,
  setTrackInstrument,
  setTrackInstruments,
  setTrackSoloSafe,
  setTrackVca,
  setVcaGroupGain,
  setVcaGroupMute,
  setVcaGroupSolo,
} from './command/mixer';
export type { MixerSnapshotSlot, MixerSnapshotSlotState } from './command/mixer-snapshots';
export {
  activeMixerSnapshotSlot,
  clearMixerSnapshots,
  exportMixerSnapshotSlots,
  importMixerSnapshotSlots,
  mixerSnapshotFilled,
  mixerSnapshotSlots,
  recallMixerSnapshot,
  saveMixerSnapshot,
} from './command/mixer-snapshots';
export {
  addNote,
  cleanupOverlaps,
  deleteNotes,
  duplicateSelection,
  fadeSelectionVelocity,
  humanizeSelectionVelocity,
  legatoSelection,
  mergeSelection,
  normalizeSelectionVelocity,
  nudgeSelectionVelocity,
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
  transposeSelection,
  transposeSelectionDiatonic,
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
  setTrackRecordInputChannel,
  setTrackRecordInputDeviceId,
  setTrackSolo,
  setTrackVolume,
} from './command/tracks';
