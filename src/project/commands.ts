export type { AssistSidecar } from './command/assist';
export { listAssistSidecars, setAssistSidecar } from './command/assist';
export type { AddRecordedAudioClipInput } from './command/audio-recording';
export { addRecordedAudioClips } from './command/audio-recording';
export {
  removeAutomationLane,
  setAutomationLaneEnabled,
  setAutomationLanePoints,
} from './command/automation';
export type { EstimatedChordSummary } from './command/chords';
export {
  clearProjectChords,
  detectChordsForClip,
  detectChordsFromAudioClip,
  estimateChordsFromArrangement,
  setProjectChords,
} from './command/chords';
export type {
  AddAudioClipInput,
  AddBouncedClipInput,
  AddMidiClipInput,
  DropClipTakesInput,
} from './command/clips';
export {
  addAudioClip,
  addBouncedClip,
  addMidiClip,
  clearActiveClipSelection,
  consolidateAudioClips,
  deleteClip,
  dropClipTakes,
  dropClipTakesBatch,
  duplicateClip,
  glueMidiClips,
  moveClip,
  renameClip,
  replaceAudioClipAsset,
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
  setClipPolyPressureForPitchPoints,
  setClipTakes,
  setClipWarp,
  setTrackFrozen,
  splitClip,
  trimClip,
} from './command/clips';
export type { GenerateArrangementParams } from './command/generate-arrangement';
export { generateArrangementCommand } from './command/generate-arrangement';
export type { BackingStyle, GenerateBackingParams } from './command/generate-backing';
export { generateBackingCommand } from './command/generate-backing';
export type { GenerateBassParams } from './command/generate-bass';
export { generateBassLineCommand } from './command/generate-bass';
export type { BatchPartSpec, BatchTarget, TrackPart } from './command/generate-batch';
export {
  generateTracksBatchCommand,
  partForTrackName,
} from './command/generate-batch';
export type { GenerateCounterMelodyParams } from './command/generate-counter-melody';
export { generateCounterMelodyCommand } from './command/generate-counter-melody';
export type { GenerateDrumsParams } from './command/generate-drums';
export { generateDrumsCommand } from './command/generate-drums';
export type {
  HarmonizeFromMelodyParams,
  ReharmonizeStrength,
} from './command/generate-harmonize';
export { harmonizeFromMelodyCommand } from './command/generate-harmonize';
export type { GenerateMotifParams } from './command/generate-motif';
export { generateMotifCommand } from './command/generate-motif';
export type { GenerateProgressionParams } from './command/generate-progression';
export { generateProgressionCommand } from './command/generate-progression';
export type { CommandGestureOptions, HistoryReferencedMediaIds } from './command/history';
export {
  canRedo,
  canUndo,
  clearHistory,
  collectHistoryReferencedMediaIds,
  configureHistoryByteBudget,
  executeAtomic,
  historyBudgetStats,
  redo,
  undo,
} from './command/history';
export { insertSecondaryDominantBefore } from './command/insert-secondary-dominant';
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
export type { NoteEditPlan } from './command/notes';
export {
  addNote,
  addNotes,
  applyNoteEdits,
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
export { reharmonizeChord } from './command/reharm';
export type {
  ProjectReharmonizationProposal,
  ReactiveReharmonizeParams,
} from './command/reharmonize-reactive';
export {
  applyReharmonizationProposal,
  proposeReharmonizationForActiveClip,
} from './command/reharmonize-reactive';
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
