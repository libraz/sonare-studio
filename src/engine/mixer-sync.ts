/**
 * Realtime mixer synchronisation: mirrors the store's track/master mixer
 * state onto the engine's per-track lanes (fader, pan, solo/mute) and the
 * master strip, so level changes apply immediately without re-scheduling.
 *
 * Engine lanes are append-only for the engine's lifetime: a declaration must
 * keep every lane already declared, in order. A deleted track therefore keeps
 * its lane, muted, and takes it back unchanged if the deletion is undone. When
 * those retired lanes would push a declaration past the engine's lane limit,
 * the sync stops declaring and asks for an engine rebuild, which declares only
 * the live tracks.
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
import { createRetryTimer } from './retry-timer';

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

/**
 * The lane values the engine has accepted. Fader, pan and solo/mute go through
 * the command ring and may be refused, so they stay unset until accepted.
 */
type AppliedLaneState = Omit<LaneState, 'gainDb' | 'pan' | 'solo' | 'mute'> &
  Partial<Pick<LaneState, 'gainDb' | 'pan' | 'solo' | 'mute'>>;

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
  /** Tracks needing an engine strip solely for automatic channel alignment. */
  positiveChannelDelayTrackIds(): ReadonlySet<number>;
  /** Sends deferred channel delays after strip-sync has declared the strips. */
  applyChannelDelays(stripSceneGeneration: number): void;
  /**
   * True once lanes kept for deleted tracks leave no room for a live track's
   * lane; only an engine rebuild reclaims them.
   */
  laneReclaimNeeded?(): boolean;
}

/** Track lanes the realtime engine accepts in one declaration. */
export const MAX_ENGINE_TRACK_LANES = 32;

/** Options for {@link createMixerSync}. */
export interface MixerSyncOptions {
  /** Optional processor-latency resolver used for automatic track PDC. */
  insertLatency?: InsertLatencyResolver;
  /** Studio defers PDC until after strip scenes have been installed. */
  deferChannelDelay?: boolean;
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
  const laneStates = new Map<number, AppliedLaneState>();
  // Lanes of deleted tracks that have already been muted.
  const retiredMuted = new Set<number>();
  let masterState: { gainDb?: number; pan?: number } | undefined;
  const retry = createRetryTimer(() => handle.ctx.state === 'closed');
  let lastArgs: Parameters<MixerSync['sync']> | undefined;
  let sceneGeneration = 0;
  const pendingChannelDelays = new Map<number, number>();
  const appliedChannelDelays = new Map<number, number>();
  let appliedStripSceneGeneration: number | undefined;
  const resolveInsertLatency = options.insertLatency ?? zeroInsertLatency;
  let laneReclaimNeeded = false;

  const sync = (
    tracks: ReadonlyArray<EditorTrack>,
    master: MixerStrip,
    vcaGainDb?: ReadonlyMap<string, number>,
    vcaControls?: ReadonlyMap<string, VcaControlState>,
    soloMode?: MixerSoloMode,
    pdcBuses?: ReadonlyArray<InsertPdcBus>,
  ): void => {
    lastArgs = [tracks, master, vcaGainDb, vcaControls, soloMode, pdcBuses];
    // A refused command leaves its value unrecorded so the next pass re-sends it.
    let refused = false;
    const appended = tracks.filter((track) => !laneIds.includes(track.id)).map((track) => track.id);
    if (
      appended.length > 0 &&
      laneIds.length + appended.length > MAX_ENGINE_TRACK_LANES &&
      tracks.length <= MAX_ENGINE_TRACK_LANES
    ) {
      laneReclaimNeeded = true;
    } else if (appended.length > 0) {
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
      if (!handle.engine.setSoloMute(id, false, true)) {
        refused = true;
        continue;
      }
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
    pendingChannelDelays.clear();
    for (const track of tracks) {
      // A track waiting for the reclaiming rebuild has no lane to address yet.
      if (!laneIds.includes(track.id)) continue;
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
      const applied: AppliedLaneState = { ...next };
      if (prev?.gainDb !== next.gainDb) {
        if (!handle.engine.setStripGain(track.id, next.gainDb)) {
          applied.gainDb = prev?.gainDb;
          refused = true;
        }
      }
      if (prev?.pan !== next.pan) {
        if (!handle.engine.setStripPan(track.id, next.pan)) {
          applied.pan = prev?.pan;
          refused = true;
        }
      }
      if (prev?.solo !== next.solo || prev?.mute !== next.mute) {
        if (!handle.engine.setSoloMute(track.id, next.solo, next.mute)) {
          applied.solo = prev?.solo;
          applied.mute = prev?.mute;
          refused = true;
        }
      }
      if (
        prev
          ? prev.channelDelaySamples !== next.channelDelaySamples
          : next.channelDelaySamples !== 0
      ) {
        if (!options.deferChannelDelay) {
          handle.engine.setTrackStripChannelDelaySamples(track.id, next.channelDelaySamples);
        }
      }
      if (options.deferChannelDelay) pendingChannelDelays.set(track.id, next.channelDelaySamples);
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
      laneStates.set(track.id, applied);
    }
    const masterNext = { gainDb: master.gainDb, pan: clampPan(master.pan) };
    const masterApplied = { ...masterState };
    if (masterState?.gainDb !== masterNext.gainDb) {
      if (handle.engine.setStripGain('master', masterNext.gainDb)) {
        masterApplied.gainDb = masterNext.gainDb;
      } else {
        refused = true;
      }
    }
    if (masterState?.pan !== masterNext.pan) {
      if (handle.engine.setStripPan('master', masterNext.pan)) {
        masterApplied.pan = masterNext.pan;
      } else {
        refused = true;
      }
    }
    masterState = masterApplied;
    if (refused) retry.schedule('sync', () => sync(...(lastArgs as Parameters<MixerSync['sync']>)));
  };

  return {
    sync,
    laneReclaimNeeded: () => laneReclaimNeeded,
    laneTrackIds: () => laneIds,
    sceneGeneration: () => sceneGeneration,
    positiveChannelDelayTrackIds: () =>
      new Set(
        [...pendingChannelDelays].filter(([, delay]) => delay > 0).map(([trackId]) => trackId),
      ),
    applyChannelDelays: (stripSceneGeneration) => {
      if (!options.deferChannelDelay) return;
      const sceneChanged = appliedStripSceneGeneration !== stripSceneGeneration;
      for (const [trackId, delay] of pendingChannelDelays) {
        if (delay === 0 && !appliedChannelDelays.has(trackId)) continue;
        if (sceneChanged || appliedChannelDelays.get(trackId) !== delay) {
          handle.engine.setTrackStripChannelDelaySamples(trackId, delay);
          appliedChannelDelays.set(trackId, delay);
        }
      }
      appliedStripSceneGeneration = stripSceneGeneration;
    },
  };
}
