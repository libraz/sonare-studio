/**
 * Document-to-engine bus graph shared by live playback (strip-sync) and the
 * offline renderer (engine-render-context): compact bus numbering, the bus
 * declarations with their layout, output route and sends, and the per-track
 * output bus and send lists. Both paths replay this one result, so the
 * realtime and exported mixes cannot route a project differently.
 *
 * Numbering is 1-based in key order: return buses in document order, then one
 * `group:<ref>` bus per group track, then the return-solo discard sink. A
 * group's ref is the live track id or the offline document track index.
 */

import { SILENCE_DB } from '@/lib/db';
import { groupBusTopologyId, RESERVED_MIXER_BUS_ID } from '@/project/bus-topology';
import {
  type MixerBus,
  type MixerStrip,
  mixerChannelLayoutCode,
  type ReturnSoloRouting,
  type StripSend,
} from '@/project/mixer';
import type { EngineTrackSend } from '@/wasm/index.js';

/** Engine bus slots available to return buses, group buses and the discard sink. */
export const MAX_ENGINE_BUSES = 8;

/** One engine bus declaration, including routing metadata. */
export interface EngineBusDeclaration {
  busId: number;
  gainDb: number;
  channelLayout?: number;
  outputBusId?: number;
  sends?: EngineTrackSend[];
}

/** A group track's bus, keyed by the caller's track reference. */
export interface BusGraphGroup {
  ref: number;
  strip: MixerStrip | undefined;
  gainDb: number;
}

export interface BusGraphInput {
  buses: ReadonlyArray<
    Pick<MixerBus, 'id' | 'gainDb' | 'mute' | 'solo' | 'channelLayout' | 'strip'>
  >;
  returnSolo: ReturnSoloRouting;
  groups: ReadonlyArray<BusGraphGroup>;
}

/** The routing-relevant view of one track. */
export interface BusGraphTrack {
  kind: string;
  /** Ref of the group track this track belongs to. */
  groupRef?: number;
  mixer?: Pick<MixerStrip, 'outputBusId' | 'sends'>;
}

export interface BusGraph {
  /** Bus keys in engine-number order. */
  keys: string[];
  /** Engine bus number (1-based) keyed by bus key. */
  busNumberByKey: Map<string, number>;
  declarations: EngineBusDeclaration[];
  /** Silent sink parking direct outputs during a return solo, if declared. */
  discardBusId?: number;
  /** Engine bus number for a store bus id; undefined when not declared. */
  resolve(storeBusId: string): number | undefined;
  /** Engine output bus for a track; 0 is the master mix. */
  trackOutputBus(track: BusGraphTrack): number;
  /** Engine send list for a track strip. */
  trackSends(track: BusGraphTrack): EngineTrackSend[];
}

/** Maps a persisted strip send list to the engine's numeric bus ids. */
export function engineBusSends(
  sends: ReadonlyArray<StripSend> | undefined,
  resolveBus: (storeBusId: string) => number | undefined,
  ownBusId?: number,
): EngineTrackSend[] {
  const mapped: EngineTrackSend[] = [];
  const seen = new Set<number>();
  for (const send of sends ?? []) {
    const busId = resolveBus(send.busId);
    // The engine rejects a send to an undeclared bus, to itself, or a second
    // send to the same destination.
    if (busId === undefined || busId === ownBusId || seen.has(busId)) continue;
    seen.add(busId);
    const entry: EngineTrackSend = {
      busId,
      levelDb: send.levelDb,
      enabled: send.enabled,
    };
    if (send.timing === 'preFader') entry.sendTiming = 'preFader';
    mapped.push(entry);
  }
  return mapped;
}

/**
 * Builds the engine bus graph for a project mixer. Does not enforce
 * {@link MAX_ENGINE_BUSES}; the discard sink is declared only while a slot is
 * free.
 */
export function engineBusGraph(input: BusGraphInput): BusGraph {
  const { buses, returnSolo, groups } = input;
  const withDiscard = returnSolo.active && buses.length + groups.length < MAX_ENGINE_BUSES;
  const keys = [
    ...buses.map((bus) => bus.id),
    ...groups.map((group) => groupBusTopologyId(group.ref)),
    ...(withDiscard ? [RESERVED_MIXER_BUS_ID] : []),
  ];
  const busNumberByKey = new Map(keys.map((key, index) => [key, index + 1]));
  const resolve = (storeBusId: string) => busNumberByKey.get(storeBusId);
  const discardBusId = withDiscard ? busNumberByKey.get(RESERVED_MIXER_BUS_ID) : undefined;

  const declaration = (
    busId: number,
    gainDb: number,
    strip: MixerStrip | undefined,
    channelLayout?: MixerBus['channelLayout'],
  ): EngineBusDeclaration => {
    const entry: EngineBusDeclaration = { busId, gainDb };
    if (channelLayout !== undefined && channelLayout !== 'stereo') {
      entry.channelLayout = mixerChannelLayoutCode(channelLayout);
    }
    const outputBusId = strip?.outputBusId === undefined ? undefined : resolve(strip.outputBusId);
    if (outputBusId !== undefined && outputBusId !== busId) entry.outputBusId = outputBusId;
    const sends = engineBusSends(strip?.sends, resolve, busId);
    if (sends.length > 0) entry.sends = sends;
    return entry;
  };
  const declarations = [
    ...buses.map((bus, index) =>
      declaration(index + 1, returnSolo.busGainDb(bus), bus.strip, bus.channelLayout),
    ),
    ...groups.map((group, index) =>
      declaration(buses.length + index + 1, group.gainDb, group.strip),
    ),
    ...(discardBusId === undefined ? [] : [declaration(discardBusId, SILENCE_DB, undefined)]),
  ];

  return {
    keys,
    busNumberByKey,
    declarations,
    ...(discardBusId !== undefined ? { discardBusId } : {}),
    resolve,
    trackOutputBus: (track) => {
      // A return solo parks every direct output on the discard sink; group
      // routing wins over a user-chosen bus, which wins over the master mix.
      if (discardBusId !== undefined && track.kind !== 'group') return discardBusId;
      if (track.groupRef !== undefined) {
        return busNumberByKey.get(groupBusTopologyId(track.groupRef)) ?? 0;
      }
      if (track.kind !== 'group' && track.mixer?.outputBusId !== undefined) {
        return resolve(track.mixer.outputBusId) ?? 0;
      }
      return 0;
    },
    trackSends: (track) => engineBusSends(track.mixer?.sends, resolve),
  };
}
