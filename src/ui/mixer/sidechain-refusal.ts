import type { StripSync } from '@/engine/strip-sync';
import {
  isMixerBusStripTarget,
  type MixerStripTarget,
  mixerBusIdFromTarget,
} from '@/project/commands';
import type { MixerSidechainSource } from '@/project/mixer';
import type { EditorTrack } from '@/project/types';
import type { SidechainRefusal, SidechainSource } from '@/wasm/index.js';
import type { SonareEngine } from '@/wasm/worklet.js';

/** Engine queries answering whether a sidechain binding would be accepted. */
export type SidechainCheckEngine = Pick<
  SonareEngine,
  'canSetStripSidechain' | 'canSetBusSidechain'
>;

/** Store-to-engine bus and insert index mapping (strip-sync owns it). */
export type SidechainIdResolver = Pick<
  StripSync,
  'busIdFor' | 'groupBusIdFor' | 'busInsertIndexFor' | 'groupInsertIndexFor'
>;

/**
 * Asks the engine why it would refuse keying one store insert from a source.
 * Null when it would accept or when an id is not declared yet.
 */
export type SidechainRefusalLookup = (
  target: MixerStripTarget,
  insertIndex: number,
  source: MixerSidechainSource,
) => SidechainRefusal | null;

/**
 * Builds a refusal lookup over a running engine, resolving store ids the way
 * strip-sync declares them: ordinary tracks are lanes keyed by track id,
 * group tracks and return buses are engine buses, the master indexes its
 * store inserts directly.
 *
 * @param engine The running engine.
 * @param ids strip-sync's id mapping for the same engine.
 * @param tracks Current project tracks (group-ness of a track target).
 * @returns The lookup.
 */
export function createSidechainRefusalLookup(
  engine: SidechainCheckEngine,
  ids: SidechainIdResolver,
  tracks: () => ReadonlyArray<Pick<EditorTrack, 'id' | 'kind'>>,
): SidechainRefusalLookup {
  const engineSource = (source: MixerSidechainSource): SidechainSource | undefined => {
    if (source.kind === 'track') return { kind: 'track', id: source.trackId };
    const id =
      source.kind === 'group' ? ids.groupBusIdFor(source.trackId) : ids.busIdFor(source.busId);
    return id === undefined ? undefined : { kind: 'bus', id };
  };

  return (target, insertIndex, source) => {
    const resolved = engineSource(source);
    if (!resolved) return null;
    if (target === 'master') {
      return engine.canSetStripSidechain('master', insertIndex, resolved).reason ?? null;
    }
    if (isMixerBusStripTarget(target)) {
      const busId = mixerBusIdFromTarget(target);
      const engineBus = ids.busIdFor(busId);
      const engineIndex = ids.busInsertIndexFor(busId, insertIndex);
      if (engineBus === undefined || engineIndex === undefined) return null;
      return engine.canSetBusSidechain(engineBus, engineIndex, resolved).reason ?? null;
    }
    if (tracks().find((track) => track.id === target)?.kind === 'group') {
      const engineBus = ids.groupBusIdFor(target);
      const engineIndex = ids.groupInsertIndexFor(target, insertIndex);
      if (engineBus === undefined || engineIndex === undefined) return null;
      return engine.canSetBusSidechain(engineBus, engineIndex, resolved).reason ?? null;
    }
    // Lanes take track keys only; store validation refuses the rest.
    if (resolved.kind !== 'track') return null;
    return engine.canSetStripSidechain(target, insertIndex, resolved).reason ?? null;
  };
}
