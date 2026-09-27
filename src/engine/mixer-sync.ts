/**
 * Realtime mixer synchronisation: mirrors the store's track/master mixer
 * state onto the engine's per-track lanes (fader, pan, solo/mute) and the
 * master strip, so level changes apply immediately without re-scheduling.
 *
 * Engine lanes are append-only for the engine's lifetime: a declaration must
 * keep every lane already declared, in order. A deleted track therefore keeps
 * its lane, muted, and takes it back unchanged if the deletion is undone.
 */

import {
  createInsertPdcPlan,
  type InsertLatencyResolver,
  type InsertPdcBus,
} from '@/project/insert-latency';
import {
  clampPan,
  DEFAULT_PAN_LAW,
  DEFAULT_PAN_MODE,
  effectiveTrackMute,
  laneGainDb,
  type MixerSoloMode,
  type MixerStrip,
  normalizeMixerSoloMode,
  type PanLawId,
  type PanModeId,
  tracksWithVcaSolo,
  type VcaControlState,
  vcaOffsetDb,
} from '@/project/mixer';
import { expandedSoloStates } from '@/project/scheduling';
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
   * @param vcaControls VCA group id -> mute/solo state folded into member lanes.
   * @param soloMode Solo audition tap. PFL auditions soloed lanes before their
   *   fader/pan; in-place/AFL keep the normal lane fader/pan.
   * @param pdcBuses Return buses whose insert latency contributes to PDC.
   */
  sync(
    tracks: ReadonlyArray<EditorTrack>,
    master: MixerStrip,
    vcaGainDb?: ReadonlyMap<string, number>,
    vcaControls?: ReadonlyMap<string, VcaControlState>,
    soloMode?: MixerSoloMode,
    pdcBuses?: ReadonlyArray<InsertPdcBus>,
  ): void;
  /** Current lane order (lane index -> project track id). */
  laneTrackIds(): readonly number[];
  /**
   * Monotonic generation of lane-scene declarations. A consumer that caches
   * state outside the lane scene must replay it when this changes.
   */
  sceneGeneration?(): number;
}

/** Options for {@link createMixerSync}. */
export interface MixerSyncOptions {
  /** Optional processor-latency resolver used for automatic track PDC. */
  insertLatency?: InsertLatencyResolver;
}

const zeroInsertLatency: InsertLatencyResolver = () => 0;

/** Safety trim for PFL, which is auditioned through the main output bus. */
export const PFL_AUDITION_GAIN_DB = -12;

/**
 * Resolves the lanes that PFL auditions before their fader and pan controls.
 * Shared with automation wiring so an installed automation lane cannot undo
 * the attenuated/centered PFL override on the next audio block.
 */
export function pflAuditionStates(
  tracks: ReadonlyArray<EditorTrack>,
  vcaControls: ReadonlyMap<string, VcaControlState> | undefined,
  soloMode: MixerSoloMode | undefined,
): boolean[] {
  if (normalizeMixerSoloMode(soloMode) !== 'pfl') return [];
  const tracksForSolo = tracksWithVcaSolo(tracks, vcaControls);
  return expandedSoloStates(
    tracksForSolo.map((track) => ({ ...track, soloSafe: false })),
    {
      isGroup: (track) => track.kind === 'group',
      groupKey: (track) => track.id,
      memberGroupKey: (track) => track.groupId,
    },
  );
}

/**
 * Creates a mixer sync bound to one engine handle. Create a fresh instance
 * per engine start: the lane registry restarts with the engine.
 *
 * @param handle Running engine handle from createEngine.
 * @returns The sync facade.
 */
export function createMixerSync(handle: EngineHandle, options: MixerSyncOptions = {}): MixerSync {
  const laneIds: number[] = [];
  const laneStates = new Map<number, LaneState>();
  // Lanes of deleted tracks that have already been muted.
  const retiredMuted = new Set<number>();
  let masterState: { gainDb: number; pan: number } | undefined;
  let sceneGeneration = 0;
  const resolveInsertLatency = options.insertLatency ?? zeroInsertLatency;

  const sync = (
    tracks: ReadonlyArray<EditorTrack>,
    master: MixerStrip,
    vcaGainDb?: ReadonlyMap<string, number>,
    vcaControls?: ReadonlyMap<string, VcaControlState>,
    soloMode?: MixerSoloMode,
    pdcBuses?: ReadonlyArray<InsertPdcBus>,
  ): void => {
    const appended = tracks.filter((track) => !laneIds.includes(track.id)).map((track) => track.id);
    if (appended.length > 0) {
      // Record the lanes only once the engine has accepted them.
      handle.engine.setTrackLanes([...laneIds, ...appended]);
      laneIds.push(...appended);
      sceneGeneration += 1;
      // A new lane declaration replaces the engine's lane state, so all live
      // values must be replayed even when the track mirror itself is unchanged.
      laneStates.clear();
      retiredMuted.clear();
    }
    const currentIds = new Set(tracks.map((track) => track.id));
    for (const id of laneIds) {
      if (currentIds.has(id)) {
        retiredMuted.delete(id);
        continue;
      }
      if (retiredMuted.has(id)) continue;
      handle.engine.setSoloMute(id, false, true);
      retiredMuted.add(id);
      laneStates.delete(id);
    }
    // Solo-safe tracks join the solo group whenever any solo is active, and a
    // soloed group track expands to the members whose lanes feed that group.
    const tracksForSolo = tracksWithVcaSolo(tracks, vcaControls);
    const soloStates = expandedSoloStates(tracksForSolo, {
      isGroup: (track) => track.kind === 'group',
      groupKey: (track) => track.id,
      memberGroupKey: (track) => track.groupId,
    });
    const auditionSoloStates = pflAuditionStates(tracks, vcaControls, soloMode);
    const pdc = createInsertPdcPlan(tracks, pdcBuses ?? [], resolveInsertLatency);
    for (const track of tracks) {
      const trackIndex = tracks.indexOf(track);
      const strip = track.mixer;
      const vcaOffset = vcaOffsetDb(track.vcaId, vcaGainDb);
      const pflAudition = auditionSoloStates[trackIndex] === true;
      // Older documents may have only the legacy track-level pan. Keep that
      // fallback aligned with the offline renderer until a strip is written.
      const pan = pflAudition ? 0 : clampPan(strip?.pan ?? track.pan ?? 0);
      const next: LaneState = {
        gainDb: pflAudition
          ? PFL_AUDITION_GAIN_DB
          : laneGainDb(track.volume, strip?.gainDb, vcaOffset),
        pan,
        solo: soloStates[trackIndex] ?? false,
        mute: effectiveTrackMute(track.mute, track.vcaId, vcaControls),
        channelDelaySamples: pdc.delayFor(track),
        panLaw: strip?.panLaw ?? DEFAULT_PAN_LAW,
        panMode: strip?.panMode ?? DEFAULT_PAN_MODE,
        // The engine's neutral dual-pan state preserves the stereo image. A
        // strip pan value must not collapse both channels when dual-pan mode
        // is selected without explicit per-channel positions.
        dualPanLeft: pflAudition ? 0 : clampPan(strip?.dualPan?.left ?? -1),
        dualPanRight: pflAudition ? 0 : clampPan(strip?.dualPan?.right ?? 1),
      };
      const prev = laneStates.get(track.id);
      if (prev?.gainDb !== next.gainDb) handle.engine.setStripGain(track.id, next.gainDb);
      if (prev?.pan !== next.pan) handle.engine.setStripPan(track.id, next.pan);
      if (prev?.solo !== next.solo || prev?.mute !== next.mute) {
        handle.engine.setSoloMute(track.id, next.solo, next.mute);
      }
      if (
        prev
          ? prev.channelDelaySamples !== next.channelDelaySamples
          : next.channelDelaySamples !== 0
      ) {
        handle.engine.setTrackStripChannelDelaySamples(track.id, next.channelDelaySamples);
      }
      if (prev ? prev.panLaw !== next.panLaw : next.panLaw !== DEFAULT_PAN_LAW) {
        handle.engine.setTrackStripPanLaw(track.id, next.panLaw);
      }
      if (prev ? prev.panMode !== next.panMode : next.panMode !== DEFAULT_PAN_MODE) {
        handle.engine.setTrackStripPanMode(track.id, next.panMode);
      }
      if (prev?.dualPanLeft !== next.dualPanLeft || prev?.dualPanRight !== next.dualPanRight) {
        const defaultDualPan = !prev && next.dualPanLeft === -1 && next.dualPanRight === 1;
        if (!defaultDualPan) {
          handle.engine.setTrackStripDualPan(track.id, next.dualPanLeft, next.dualPanRight);
        }
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

  return { sync, laneTrackIds: () => laneIds, sceneGeneration: () => sceneGeneration };
}
