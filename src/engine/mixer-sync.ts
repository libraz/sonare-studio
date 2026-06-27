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

import { linearToDb } from '@/lib/db';
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

// The fader silence floor and linear->dB conversion live in the shared
// @/lib/db module; re-exported so existing engine importers keep one site.
export { linearToDb, SILENCE_DB } from '@/lib/db';

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
    // Lanes whose track was deleted keep their (fixed) index but must fall
    // silent, or stale content would still play — most dangerously, a leftover
    // solo would duck every live track. Mute each once and remember it.
    const currentIds = new Set(tracks.map((track) => track.id));
    for (const laneId of laneIds) {
      if (currentIds.has(laneId)) continue;
      const prev = laneStates.get(laneId);
      if (prev?.mute && !prev.solo) continue;
      handle.engine.setSoloMute(laneId, false, true);
      laneStates.set(
        laneId,
        prev
          ? { ...prev, solo: false, mute: true }
          : {
              gainDb: 0,
              pan: 0,
              solo: false,
              mute: true,
              channelDelaySamples: 0,
              panLaw: DEFAULT_PAN_LAW,
              panMode: DEFAULT_PAN_MODE,
              dualPanLeft: 0,
              dualPanRight: 0,
            },
      );
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
