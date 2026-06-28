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
export type {
  MixerSnapshot,
  MixerSnapshotTrack,
} from './mixer-snapshots';
export {
  applyMixerSnapshot,
  buildMixerSnapshot,
  captureMixerSnapshot,
  mergeMixerSnapshot,
} from './mixer-snapshots';
export {
  addInsert,
  removeInsert,
  setInsertEnabled,
  setInsertParam,
  setInsertSidechain,
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
  setTrackInstrument,
} from './mixer-strip';
export {
  addVcaGroup,
  removeVcaGroup,
  renameVcaGroup,
  setTrackVca,
  setVcaGroupGain,
} from './mixer-vca';
