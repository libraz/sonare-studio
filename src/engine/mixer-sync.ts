/**
 * Realtime mixer synchronisation: mirrors the store's track/master mixer
 * state onto the engine's per-track lanes (fader, pan, solo/mute) and the
 * master strip, so level changes apply immediately without re-scheduling.
 *
 * Lane order contract (engine side): lane indices are append-only — once a
 * track id occupies a lane its index is fixed for the engine's lifetime. The
 * sync therefore keeps already-declared lanes in place (tracks deleted from
 * the project keep their lane, muted) and appends new track ids in store
 * order. The declared order is exposed via laneTrackIds() so meter target ids
 * can be mapped back to project tracks.
 */

import {
  clampPan,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  type MixerStrip,
  type PanLawId,
  type PanModeId,
} from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import type { EngineHandle } from './engine';

/** Fader floor used for a linear volume of 0 (effectively silence). */
export const SILENCE_DB = -120;

/**
 * Converts a linear volume factor to decibels, clamped to the silence floor.
 *
 * @param volume Linear volume (>= 0; 1 = unity).
 * @returns Gain in dB (SILENCE_DB for 0).
 */
export function linearToDb(volume: number): number {
  if (!(volume > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(volume));
}

/** The per-lane values mirrored to the engine, kept for change detection. */
interface LaneState {
  gainDb: number;
  pan: number;
  solo: boolean;
  mute: boolean;
  channelDelaySamples: number;
  panLaw: PanLawId;
  panMode: PanModeId;
  dualPanLeft: number;
  dualPanRight: number;
}

/** Mirrors store mixer state onto a running engine. */
export interface MixerSync {
  /**
   * Sends the current track/master mixer state to the engine. Only changed
   * values are transmitted (the command ring has a per-block budget).
   *
   * @param tracks Project tracks in store order.
   * @param master Master strip (gainDb/pan audible).
   * @param vcaGainDb VCA group id -> fader offset in dB; a member track's gain
   *   is raised by its group's offset. Omit when there are no VCA groups.
   */
  sync(
    tracks: ReadonlyArray<EditorTrack>,
    master: MixerStrip,
    vcaGainDb?: ReadonlyMap<string, number>,
  ): void;
  /** Lane order as declared so far (lane index -> project track id). */
  laneTrackIds(): readonly number[];
}

/**
 * Creates a mixer sync bound to one engine handle. Create a fresh instance
 * per engine start: the lane registry restarts with the engine.
 *
 * @param handle Running engine handle from createEngine.
 * @returns The sync facade.
 */
export function createMixerSync(handle: EngineHandle): MixerSync {
  const laneIds: number[] = [];
  const laneStates = new Map<number, LaneState>();
  let masterState: { gainDb: number; pan: number } | undefined;

  const sync = (
    tracks: ReadonlyArray<EditorTrack>,
    master: MixerStrip,
    vcaGainDb?: ReadonlyMap<string, number>,
  ): void => {
    const known = new Set(laneIds);
    const appended = tracks.filter((track) => !known.has(track.id)).map((track) => track.id);
    if (appended.length > 0) {
      laneIds.push(...appended);
      handle.engine.setTrackLanes([...laneIds]);
    }
    // Solo-safe tracks join the solo group whenever any solo is active, so the
    // engine keeps them audible instead of silencing them with the rest.
    const anySolo = tracks.some((track) => track.solo);
    for (const track of tracks) {
      const strip = track.mixer;
      const vcaOffset = track.vcaId !== undefined ? (vcaGainDb?.get(track.vcaId) ?? 0) : 0;
      const pan = clampPan(strip?.pan ?? 0);
      const next: LaneState = {
        gainDb: linearToDb(track.volume) + (strip?.gainDb ?? 0) + vcaOffset,
        pan,
        solo: track.solo || (anySolo && track.soloSafe === true),
        mute: track.mute,
        channelDelaySamples: Math.max(0, Math.round(strip?.channelDelaySamples ?? 0)),
        panLaw: strip?.panLaw ?? DEFAULT_PAN_LAW,
        panMode: strip?.panMode ?? DEFAULT_PAN_MODE,
        // Dual pan defaults to the strip pan position on both channels.
        dualPanLeft: clampPan(strip?.dualPan?.left ?? pan),
        dualPanRight: clampPan(strip?.dualPan?.right ?? pan),
      };
      const prev = laneStates.get(track.id);
      if (prev?.gainDb !== next.gainDb) handle.engine.setStripGain(track.id, next.gainDb);
      if (prev?.pan !== next.pan) handle.engine.setStripPan(track.id, next.pan);
      if (prev?.solo !== next.solo || prev?.mute !== next.mute) {
        handle.engine.setSoloMute(track.id, next.solo, next.mute);
      }
      if (prev?.channelDelaySamples !== next.channelDelaySamples) {
        handle.engine.setTrackStripChannelDelaySamples(track.id, next.channelDelaySamples);
      }
      if (prev?.panLaw !== next.panLaw) handle.engine.setTrackStripPanLaw(track.id, next.panLaw);
      if (prev?.panMode !== next.panMode)
        handle.engine.setTrackStripPanMode(track.id, next.panMode);
      if (prev?.dualPanLeft !== next.dualPanLeft || prev?.dualPanRight !== next.dualPanRight) {
        handle.engine.setTrackStripDualPan(track.id, next.dualPanLeft, next.dualPanRight);
      }
      laneStates.set(track.id, next);
    }
    const masterNext = { gainDb: master.gainDb, pan: clampPan(master.pan) };
    if (masterState?.gainDb !== masterNext.gainDb) {
      handle.engine.setStripGain('master', masterNext.gainDb);
    }
    if (masterState?.pan !== masterNext.pan) {
      handle.engine.setStripPan('master', masterNext.pan);
    }
    masterState = masterNext;
  };

  return { sync, laneTrackIds: () => laneIds };
}
