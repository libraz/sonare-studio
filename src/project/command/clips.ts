// ---------------------------------------------------------------------------
// Clip commands (re-export barrel)
// ---------------------------------------------------------------------------

export { replaceAudioClipAsset } from './clips-asset';
export type { DropClipTakesInput } from './clips-comp';
export {
  dropClipTakes,
  dropClipTakesBatch,
  setClipActiveTake,
  setClipCompSegments,
  setClipTakes,
} from './clips-comp';
export type {
  AddAudioClipInput,
  AddBouncedClipInput,
  AddMidiClipInput,
} from './clips-create';
export { addAudioClip, addBouncedClip, addMidiClip } from './clips-create';
export {
  consolidateAudioClips,
  deleteClip,
  duplicateClip,
  glueMidiClips,
  moveClip,
  renameClip,
  splitClip,
  trimClip,
} from './clips-editing';
export {
  setClipCcLane,
  setClipChannelPressure,
  setClipPitchBend,
  setClipPolyPressure,
  setClipPolyPressureForPitches,
  setClipPolyPressureForPitchPoints,
} from './clips-expression';
export {
  clearActiveClipSelection,
  setActiveClip,
  setActiveTrack,
  setClipFades,
  setClipGain,
  setClipLoop,
  setClipWarp,
  setTrackFrozen,
} from './clips-state';
