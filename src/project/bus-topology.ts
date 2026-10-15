import type { MixerStrip, ProjectMixerState, StripSend } from './mixer';

/** Bus ids occupied by internal routing nodes. */
export const RESERVED_MIXER_BUS_ID = 'return-solo-discard';

/** True when an id is reserved for an internal bus/group namespace. */
export function isReservedMixerBusId(id: string, allowMaster = false): boolean {
  if (!allowMaster && id === 'master') return true;
  return id === RESERVED_MIXER_BUS_ID || id.startsWith('group:');
}

/** Validates a persisted or newly-created mixer bus id. */
export function assertValidMixerBusId(
  id: unknown,
  existing?: ReadonlySet<string>,
  options?: { allowMaster?: boolean },
): asserts id is string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new RangeError('Mixer bus id must not be empty');
  }
  if (isReservedMixerBusId(id, options?.allowMaster === true)) {
    throw new RangeError(`Mixer bus id is reserved: ${id}`);
  }
  if (existing?.has(id)) {
    throw new RangeError(`Mixer bus id already exists: ${id}`);
  }
}

/** A node participating in the bus-to-bus routing graph. */
export interface MixerBusTopologyNode {
  /** Stable app-level id. Group nodes use the `group:<trackId>` spelling. */
  id: string;
  /** Optional output route into another bus node. */
  outputBusId?: string;
  /** Sends into other bus nodes. */
  sends?: ReadonlyArray<Pick<StripSend, 'busId'>>;
  /** Bus/group nodes whose signal keys this node's insert sidechains. */
  sidechainSources?: ReadonlyArray<string>;
}

/** Minimal group-track view needed to include its internal bus in the graph. */
export type MixerGroupBusInput =
  | number
  | { id: number; mixer?: Pick<MixerStrip, 'outputBusId' | 'sends' | 'inserts'> };

/** Returns the stable graph id used for a group track's internal bus. */
export function groupBusTopologyId(trackId: number): string {
  return `group:${trackId}`;
}

function sidechainSources(strip: Pick<MixerStrip, 'inserts'> | undefined): string[] {
  const sources: string[] = [];
  for (const insert of strip?.inserts ?? []) {
    if (insert.sidechainSourceBusId !== undefined) sources.push(insert.sidechainSourceBusId);
    if (insert.sidechainSourceGroupTrackId !== undefined) {
      sources.push(groupBusTopologyId(insert.sidechainSourceGroupTrackId));
    }
  }
  return sources;
}

function topologyNode(
  id: string,
  strip: Pick<MixerStrip, 'outputBusId' | 'sends' | 'inserts'> | undefined,
): MixerBusTopologyNode {
  const sources = sidechainSources(strip);
  return {
    id,
    ...(strip?.outputBusId !== undefined ? { outputBusId: strip.outputBusId } : {}),
    ...(strip?.sends !== undefined ? { sends: strip.sends } : {}),
    ...(sources.length > 0 ? { sidechainSources: sources } : {}),
  };
}

/** Builds the routing graph nodes represented by the project mixer. */
export function mixerBusTopology(
  mixer: Pick<ProjectMixerState, 'buses'>,
  groupTracks: ReadonlyArray<MixerGroupBusInput> = [],
): MixerBusTopologyNode[] {
  const nodes: MixerBusTopologyNode[] = mixer.buses.map((bus) => topologyNode(bus.id, bus.strip));
  for (const group of groupTracks) {
    const trackId = typeof group === 'number' ? group : group.id;
    const strip = typeof group === 'number' ? undefined : group.mixer;
    nodes.push(topologyNode(groupBusTopologyId(trackId), strip));
  }
  return nodes;
}

/** Throws when a bus route names a missing node or itself. */
export function assertKnownBusDestination(
  destinationBusId: string,
  knownBusIds: ReadonlySet<string>,
  sourceBusId?: string,
): void {
  if (!knownBusIds.has(destinationBusId)) {
    throw new RangeError(`Unknown mixer bus id: ${destinationBusId}`);
  }
  if (sourceBusId !== undefined && sourceBusId === destinationBusId) {
    throw new RangeError(`Mixer bus ${sourceBusId} cannot route to itself`);
  }
}

function adjacency(nodes: ReadonlyArray<MixerBusTopologyNode>): Map<string, Set<string>> {
  const known = new Set(nodes.map((node) => node.id));
  const graph = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));
  for (const node of nodes) {
    const destinations = graph.get(node.id);
    if (!destinations) continue;
    if (node.outputBusId !== undefined && known.has(node.outputBusId)) {
      destinations.add(node.outputBusId);
    }
    for (const send of node.sends ?? []) {
      if (known.has(send.busId)) destinations.add(send.busId);
    }
    for (const source of node.sidechainSources ?? []) {
      if (known.has(source)) graph.get(source)?.add(node.id);
    }
  }
  return graph;
}

function hasPath(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  to: string,
): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === to) return true;
    visited.add(current);
    for (const next of graph.get(current) ?? []) pending.push(next);
  }
  return false;
}

/**
 * Throws when adding `sourceBusId -> destinationBusId` would create a cycle.
 * Existing malformed edges are ignored here; callers validate the new edge's
 * endpoint before invoking this helper and the engine remains the final guard.
 */
export function assertNoBusRoutingCycle(
  nodes: ReadonlyArray<MixerBusTopologyNode>,
  sourceBusId: string,
  destinationBusId: string,
): void {
  const graph = adjacency(nodes);
  const replaced = new Set(graph.get(sourceBusId) ?? []);
  replaced.add(destinationBusId);
  graph.set(sourceBusId, replaced);
  if (hasPath(graph, destinationBusId, sourceBusId)) {
    throw new RangeError(
      `Mixer bus routing cycle: ${sourceBusId} cannot route to ${destinationBusId}`,
    );
  }
}

/**
 * Validates every declared output, send and bus/group sidechain edge in one
 * mixer topology. This is useful at document/scene boundaries where several
 * routes arrive at once.
 */
export function assertValidMixerBusTopology(nodes: ReadonlyArray<MixerBusTopologyNode>): void {
  const known = new Set(nodes.map((node) => node.id));
  const graph: MixerBusTopologyNode[] = nodes.map((node) => ({
    ...node,
    sends: [...(node.sends ?? [])],
  }));
  for (const node of graph) {
    if (node.outputBusId !== undefined) {
      assertKnownBusDestination(node.outputBusId, known, node.id);
      assertNoBusRoutingCycle(graph, node.id, node.outputBusId);
    }
    for (const send of node.sends ?? []) {
      assertKnownBusDestination(send.busId, known, node.id);
      assertNoBusRoutingCycle(graph, node.id, send.busId);
    }
    for (const source of node.sidechainSources ?? []) {
      assertKnownBusDestination(source, known, node.id);
      assertNoBusRoutingCycle(graph, source, node.id);
    }
  }
}
