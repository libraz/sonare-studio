// ---------------------------------------------------------------------------
// Clip commands (re-export barrel)
// ---------------------------------------------------------------------------

export { replaceAudioClipAsset } from './clips-asset';
export { copyActiveClip, cutActiveClip, pasteClipAt } from './clips-clipboard';
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
export type { SliceAudioClipOptions } from './clips-editing';
export {
  consolidateAudioClips,
  deleteClip,
  duplicateClip,
  glueMidiClips,
  moveClip,
  moveClips,
  renameClip,
  sliceAudioClipAtTransients,
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
  crossfadeClips,
  setActiveClip,
  setActiveTrack,
  setClipFades,
  setClipGain,
  setClipLoop,
  setClipSelection,
  setClipWarp,
  setTrackFrozen,
  setTrackSelection,
} from './clips-state';
