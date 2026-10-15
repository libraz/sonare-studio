import {
  assertNoBusRoutingCycle,
  type MixerGroupBusInput,
  mixerBusTopology,
} from '@/project/bus-topology';
import type { ProjectMixerState } from '@/project/mixer';

/** One entry of an output-bus select. */
export interface OutputBusOption {
  value: string;
  label: string;
  disabled?: boolean;
  detail?: string;
}

/**
 * Builds the routing graph once and returns a predicate telling whether the
 * strip whose bus node is `sourceBusId` may route into a destination bus
 * without a self-route or cycle. A source-less strip (a plain track) may route
 * anywhere.
 */
export function createOutputBusGuard(
  mixer: Pick<ProjectMixerState, 'buses'>,
  groupTracks: ReadonlyArray<MixerGroupBusInput>,
  sourceBusId: string | undefined,
): (busId: string) => boolean {
  if (sourceBusId === undefined) return () => true;
  const topology = mixerBusTopology(mixer, groupTracks);
  return (busId) => {
    if (busId === sourceBusId) return false;
    try {
      assertNoBusRoutingCycle(topology, sourceBusId, busId);
      return true;
    } catch {
      return false;
    }
  };
}

/** Output-bus options: the master mix plus every bus, loop-forming ones disabled. */
export function buildOutputBusOptions(
  buses: ReadonlyArray<{ id: string; name: string }>,
  isAllowed: (busId: string) => boolean,
  labels: { master: string; busLoop: string },
): OutputBusOption[] {
  return [
    { value: '', label: labels.master },
    ...buses.map((bus) =>
      isAllowed(bus.id)
        ? { value: bus.id, label: bus.name }
        : { value: bus.id, label: bus.name, disabled: true, detail: labels.busLoop },
    ),
  ];
}
