/**
 * Sidechain key-source selection for keyed insert processors: the source
 * options a strip may use, with bus-topology and engine refusals disabled.
 */

import { type ComputedRef, computed, type Ref, ref } from 'vue';
import { describeError } from '@/lib/errors';
import {
  assertNoBusRoutingCycle,
  groupBusTopologyId,
  mixerBusTopology,
} from '@/project/bus-topology';
import type { MixerStripTarget } from '@/project/commands';
import {
  isMixerBusStripTarget,
  mixerBusIdFromTarget,
  setInsertSidechain,
} from '@/project/commands';
import type { InsertSlot, MixerSidechainSource } from '@/project/mixer';
import { useProjectStore } from '@/project/store';
import { useI18n } from '@/ui/i18n';
import { isSidechainKeyedProcessor } from '@/ui/mixer/insert-rack';
import type { SidechainRefusalLookup } from '@/ui/mixer/sidechain-refusal';

/** Configuration for {@link useInsertSidechain}. */
export interface UseInsertSidechainOptions {
  /** Rack props: the strip target and the engine refusal lookup. */
  props: {
    readonly target: MixerStripTarget;
    readonly sidechainRefusal: SidechainRefusalLookup | null;
  };
  /** Expanded slot index whose key source the picker edits. */
  expandedIndex: Ref<number | null>;
  /** The rack's error banner, set when a key-source change is rejected. */
  error: Ref<string>;
}

/** Key-source picker state returned by {@link useInsertSidechain}. */
export interface InsertSidechain {
  /** Options for the expanded slot, with refused sources disabled and explained. */
  sidechainOptions: ComputedRef<
    { value: SidechainSourceValue; label: string; detail?: string; disabled?: boolean }[]
  >;
  /** Re-reads the engine refusals when the picker is about to open. */
  refreshSidechainChecks(): void;
  /** The slot's current key source as a picker value. */
  sidechainValue(slot: InsertSlot): SidechainSourceValue;
  /** True when the slot gets a key-source select. */
  hasSidechainSelect(slot: InsertSlot): boolean;
  /** Applies a picked key source to a slot. */
  onSidechainChange(index: number, value: SidechainSourceValue): void;
}

/** String values keep track, group and return-bus id namespaces unambiguous. */
export type SidechainSourceValue = 'none' | `track:${number}` | `group:${number}` | `bus:${string}`;

/**
 * Creates the sidechain key-source picker state of one insert rack.
 *
 * @param options - The rack props, the expanded slot and the error banner.
 * @returns The picker options and the key-source actions.
 */
export function useInsertSidechain(options: UseInsertSidechainOptions): InsertSidechain {
  const { props, expandedIndex, error } = options;
  const store = useProjectStore();
  const { t } = useI18n();

  // --- Sidechain key source ------------------------------------------------------

  const SIDECHAIN_NONE: SidechainSourceValue = 'none';

  /** Ordinary track strips accept track keys only; bus/group keys target bus nodes. */
  const ordinaryTrackTarget = computed(() => {
    if (typeof props.target !== 'number') return false;
    return store.tracks.find((track) => track.id === props.target)?.kind !== 'group';
  });

  /** The bus node receiving a bus/group sidechain dependency, when one exists. */
  const sidechainTargetBusId = computed<string | null>(() => {
    const target = props.target;
    if (isMixerBusStripTarget(target)) return mixerBusIdFromTarget(target);
    if (typeof target !== 'number') return null;
    const track = store.tracks.find((entry) => entry.id === target);
    return track?.kind === 'group' ? groupBusTopologyId(track.id) : null;
  });

  function isSidechainNodeAllowed(sourceNodeId: string): boolean {
    const targetNodeId = sidechainTargetBusId.value;
    if (targetNodeId === null) return true;
    if (targetNodeId === sourceNodeId) return false;
    try {
      assertNoBusRoutingCycle(
        mixerBusTopology(
          store.mixer,
          store.tracks
            .filter((track) => track.kind === 'group')
            .map((track) => ({ id: track.id, mixer: track.mixer })),
        ),
        sourceNodeId,
        targetNodeId,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** A return-bus key source must not point at itself or close a bus cycle. */
  function isSidechainBusSourceAllowed(busId: string): boolean {
    return isSidechainNodeAllowed(busId);
  }

  /** A group-bus key source follows the same topology rules as a return bus. */
  function isSidechainGroupSourceAllowed(trackId: number): boolean {
    return isSidechainNodeAllowed(groupBusTopologyId(trackId));
  }

  /** Key-source options: no key, tracks, group buses and return buses. */
  const storeSidechainOptions = computed<
    { value: SidechainSourceValue; label: string; disabled?: boolean }[]
  >(() => [
    { value: SIDECHAIN_NONE, label: t.value.shell.inserts.noKey },
    ...store.tracks
      .filter(
        (track) =>
          track.id !== props.target && !(ordinaryTrackTarget.value && track.kind === 'group'),
      )
      .map((track) => {
        const groupSource = track.kind === 'group' && !ordinaryTrackTarget.value;
        return {
          value: (groupSource ? `group:${track.id}` : `track:${track.id}`) as SidechainSourceValue,
          label:
            track.kind === 'group'
              ? `${track.name} · ${t.value.shell.mixer.strip.group}`
              : track.name,
          ...(groupSource ? { disabled: !isSidechainGroupSourceAllowed(track.id) } : {}),
        };
      }),
    ...(ordinaryTrackTarget.value
      ? []
      : store.mixer.buses.map((bus) => ({
          value: `bus:${bus.id}` as SidechainSourceValue,
          label: `${bus.name} · ${t.value.shell.mixer.strip.bus}`,
          disabled: !isSidechainBusSourceAllowed(bus.id),
        }))),
  ]);

  /**
   * Bumped when the key picker is about to open: the engine's answer is not
   * reactive, so it is re-read against the engine state at that moment.
   */
  const sidechainCheckEpoch = ref(0);

  function refreshSidechainChecks(): void {
    sidechainCheckEpoch.value += 1;
  }

  /** Store options for the expanded slot, with engine refusals disabled and explained. */
  const sidechainOptions = computed<
    { value: SidechainSourceValue; label: string; detail?: string; disabled?: boolean }[]
  >(() => {
    void sidechainCheckEpoch.value;
    const lookup = props.sidechainRefusal;
    const index = expandedIndex.value;
    if (!lookup || index === null) return storeSidechainOptions.value;
    return storeSidechainOptions.value.map((option) => {
      if (option.value === 'none' || option.disabled) return option;
      const reason = lookup(props.target, index, sidechainSourceFromValue(option.value));
      if (reason === null) return option;
      return { ...option, disabled: true, detail: t.value.shell.inserts.sidechainRefusal[reason] };
    });
  });

  function sidechainSourceFromValue(
    value: Exclude<SidechainSourceValue, 'none'>,
  ): MixerSidechainSource {
    if (value.startsWith('track:')) {
      return { kind: 'track', trackId: Number(value.slice('track:'.length)) };
    }
    if (value.startsWith('group:')) {
      return { kind: 'group', trackId: Number(value.slice('group:'.length)) };
    }
    return { kind: 'bus', busId: value.slice('bus:'.length) };
  }

  function sidechainValue(slot: InsertSlot): SidechainSourceValue {
    if (slot.sidechainSourceBusId !== undefined) return `bus:${slot.sidechainSourceBusId}`;
    if (slot.sidechainSourceGroupTrackId !== undefined) {
      return ordinaryTrackTarget.value
        ? `track:${slot.sidechainSourceGroupTrackId}`
        : `group:${slot.sidechainSourceGroupTrackId}`;
    }
    if (slot.sidechainSourceTrackId !== undefined) return `track:${slot.sidechainSourceTrackId}`;
    return SIDECHAIN_NONE;
  }

  /** True when the slot gets a key-source select (all engine strip targets). */
  function hasSidechainSelect(slot: InsertSlot): boolean {
    return isSidechainKeyedProcessor(slot.processor);
  }

  function onSidechainChange(index: number, value: SidechainSourceValue): void {
    try {
      const source = value === 'none' ? null : sidechainSourceFromValue(value);
      setInsertSidechain(props.target, index, source);
      error.value = '';
    } catch (err) {
      error.value = describeError(err, t.value.notices.errors);
    }
  }

  return {
    sidechainOptions,
    refreshSidechainChecks,
    sidechainValue,
    hasSidechainSelect,
    onSidechainChange,
  };
}
