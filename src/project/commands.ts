export {
  type AlignClipOutcome,
  type AlignClipRefusal,
  alignClipToReference,
} from './command/align';
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
  arrangementMelodyPitchClasses,
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
  SliceAudioClipOptions,
} from './command/clips';
export {
  addAudioClip,
  addBouncedClip,
  addMidiClip,
  clearActiveClipSelection,
  consolidateAudioClips,
  copyActiveClip,
  crossfadeClips,
  cutActiveClip,
  deleteClip,
  dropClipTakes,
  dropClipTakesBatch,
  duplicateClip,
  glueMidiClips,
  moveClip,
  moveClips,
  pasteClipAt,
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
  setClipSelection,
  setClipTakes,
  setClipWarp,
  setTrackFrozen,
  setTrackSelection,
  sliceAudioClipAtTransients,
  splitClip,
  trimClip,
} from './command/clips';
export type {
  ExternalStemImport,
  ImportExternalStemsOptions,
} from './command/external-stems';
export { importExternalStems } from './command/external-stems';
export type { BackingStyle, GenerateBackingParams } from './command/generate-backing';
export { generateBackingCommand } from './command/generate-backing';
export type { GenerateBassParams } from './command/generate-bass';
export { generateBassLineCommand } from './command/generate-bass';
export type { BatchPartSpec, BatchTarget, TrackPart } from './command/generate-batch';
export { generateTracksBatchCommand } from './command/generate-batch';
export type { GenerateCounterMelodyParams } from './command/generate-counter-melody';
export { generateCounterMelodyCommand } from './command/generate-counter-melody';
export type { GenerateDrumsParams } from './command/generate-drums';
export {
  generateDrumsCommand,
  MAX_DRUM_DIFFICULTY,
  MIN_DRUM_DIFFICULTY,
} from './command/generate-drums';
export type {
  DrumsRangePlan,
  RegenerateDrumsRangeParams,
} from './command/generate-drums-range';
export { regenerateDrumsRangeCommand } from './command/generate-drums-range';
export type {
  HarmonizeFromMelodyParams,
  ReharmonizeStrength,
} from './command/generate-harmonize';
export { harmonizeFromMelodyCommand } from './command/generate-harmonize';
export { createLeadMelodyCommand } from './command/generate-lead';
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
export { applyKeyChangeMarkers } from './command/key-changes';
export { setTrackLeadFollow } from './command/lead-follow';
export {
  addMasteringProcessor,
  applyMasteringPresetWithOverrides,
  removeMasteringProcessor,
  reorderMasteringProcessor,
  setMasteringEnabled,
  setMasteringParam,
  setMasteringPreset,
  setMasteringPresetOverride,
} from './command/mastering';
export type { TranscribeAudioClipToMidiOptions } from './command/melody';
export {
  extractMelodyFromAudioClip,
  transcribeAudioClipToMidi,
} from './command/melody';
export {
  clearAllMidiCcBindings,
  clearMidiCcBinding,
  setMidiCcBinding,
} from './command/midi-bindings';
export { bakeClipMidiFx, clearTrackMidiFx, setTrackMidiFx } from './command/midi-fx';
export type { AddRecordedMidiClipInput } from './command/midi-recording';
export {
  addRecordedMidiClip,
  flattenClipMidiComp,
  overwriteRecordedMidiClip,
  replaceRecordedMidiMaterial,
  setClipMidiActiveTake,
  setClipMidiCompSegments,
} from './command/midi-recording';
export type {
  MixerSidechainSource,
  MixerSnapshot,
  MixerSnapshotTrack,
  MixerStripTarget,
} from './command/mixer';
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
  replaceInsert,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
  setMixerBusChannelLayout,
  setMixerBusGain,
  setMixerBusMute,
  setMixerBusSolo,
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
  applyGrooveToActiveClip,
  applyGrooveToSelection,
  applyNoteEdits,
  captureGrooveFromActiveClip,
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
  nudgeSelectionVelocity,
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
export type { NoteAnnotationUpdate, OrnamentClipOptions } from './command/score-annotations';
export {
  clearNoteAnnotation,
  ornamentClipNotes,
  setDisplayTranspose,
  setNoteAnnotation,
} from './command/score-annotations';
export { splitAudioClipToComponents, splitAudioClipToStems } from './command/stems';
export type { DetectedSectionSummary, SectionInput } from './command/timeline';
export {
  deleteTime,
  detectSectionsFromArrangement,
  detectSectionsFromAudioClip,
  duplicateTime,
  insertTime,
  removeMarker,
  setMarker,
  setSections,
  setTempoSegments,
  setTimeSignatures,
} from './command/timeline';
export {
  applyTrackChannelPreset,
  copyTrackChannelPreset,
  hasCopiedTrackChannelPreset,
  pasteTrackChannelPreset,
} from './command/track-presets';
export type { AddTrackInput } from './command/tracks';
export {
  addAudioTrack,
  addGroupTrack,
  addTrack,
  clearAllSolo,
  removeTrack,
  removeTracks,
  renameTrack,
  reorderTracks,
  setExclusiveTrackSolo,
  setTrackChordFollow,
  setTrackColor,
  setTrackExpressionMap,
  setTrackGroup,
  setTrackMute,
  setTrackPan,
  setTrackPercussion,
  setTrackPitchRange,
  setTrackRecordInputChannel,
  setTrackRecordInputDeviceId,
  setTrackSolo,
  setTracksColor,
  setTracksGroup,
  setTrackVolume,
} from './command/tracks';
export { type TuneToMidiOutcome, tuneAudioClipToMidiTrack } from './command/tune';
export type { TrackChannelPreset } from './track-preset';
