/**
 * Mixer command barrel.
 *
 * Re-exports the mixer commands, target helpers and A/B snapshot API from their
 * focused submodules so existing importers keep a single entry point.
 */

export type { AddMixerBusInput } from './mixer-buses';
export {
  addMixerBus,
  removeMixerBus,
  renameMixerBus,
  setMixerBusGain,
  setMixerBusMute,
  setTrackSoloSafe,
} from './mixer-buses';
export type {
  MixerBusStripTarget,
  MixerStripTarget,
} from './mixer-internal';
export {
  isMixerBusStripTarget,
  mixerBusIdFromTarget,
  mixerBusStripTarget,
} from './mixer-internal';
export type { ApplyMixerSceneResult } from './mixer-scenes';
export { applyMixerSceneJson } from './mixer-scenes';
export type {
  MixerSnapshot,
  MixerSnapshotSlotState,
  MixerSnapshotTrack,
} from './mixer-snapshots';
export {
  applyMixerSnapshot,
  buildMixerSnapshot,
  captureMixerSnapshot,
  exportMixerSnapshotSlots,
  importMixerSnapshotSlots,
  mergeMixerSnapshot,
} from './mixer-snapshots';
export {
  addInsert,
  removeInsert,
  reorderInsert,
  replaceInsert,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
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
} from './mixer-strip';
export {
  addVcaGroup,
  removeVcaGroup,
  renameVcaGroup,
  setTrackVca,
  setVcaGroupGain,
  setVcaGroupMute,
  setVcaGroupSolo,
} from './mixer-vca';
