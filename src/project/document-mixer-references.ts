/**
 * Translation between positional document references and session ids for
 * mixer state: insert sidechain sources, group sidechain keys and mixer
 * snapshot slots.
 */

import { cloneAutomationLane } from './automation';
import {
  assertValidMixerBusId,
  assertValidMixerBusTopology,
  mixerBusTopology,
} from './bus-topology';
import {
  MIXER_SNAPSHOT_SLOTS,
  type MixerSnapshot,
  type MixerSnapshotSlot,
  type MixerSnapshotSlotState,
} from './command/mixer-snapshots';
import type {
  DocumentMixerSnapshot,
  DocumentMixerSnapshotSlots,
  DocumentMixerState,
  DocumentTrack,
} from './document-schema';
import {
  cloneMixerState,
  cloneStrip,
  type MixerStrip,
  type ProjectMixerState,
  renameRetiredMixerProcessors,
  renameRetiredProcessors,
} from './mixer';
import type { TrackKind } from './types';

/** Converts track-scoped insert sidechain ids to document track indices. */
export function stripWithSidechainSourceIndices(
  strip: MixerStrip,
  tracks: ReadonlyArray<{ id: number }>,
  allowSidechain = true,
): MixerStrip {
  const out = cloneStrip(strip);
  for (const slot of out.inserts) {
    if (slot.sidechainSourceTrackId !== undefined) {
      const sourceIndex = tracks.findIndex((entry) => entry.id === slot.sidechainSourceTrackId);
      delete slot.sidechainSourceTrackId;
      if (allowSidechain && sourceIndex >= 0) {
        (slot as { sidechainSourceIndex?: number }).sidechainSourceIndex = sourceIndex;
      }
    }
    if (slot.sidechainSourceGroupTrackId !== undefined) {
      const sourceIndex = tracks.findIndex(
        (entry) => entry.id === slot.sidechainSourceGroupTrackId,
      );
      delete slot.sidechainSourceGroupTrackId;
      if (allowSidechain && sourceIndex >= 0) {
        (slot as { sidechainSourceGroupTrackIndex?: number }).sidechainSourceGroupTrackIndex =
          sourceIndex;
      }
    }
  }
  return out;
}

/** Converts document track-index sidechain references back to session track ids. */
export function stripWithSidechainSourceIds(
  strip: MixerStrip,
  tracks: ReadonlyArray<{ id: number }>,
  allowSidechain = true,
): MixerStrip {
  const out = cloneStrip(strip);
  for (const slot of out.inserts) {
    const sourceIndex = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
    delete (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
    if (allowSidechain && typeof sourceIndex === 'number' && Number.isInteger(sourceIndex)) {
      const source = tracks[sourceIndex];
      if (source) slot.sidechainSourceTrackId = source.id;
    }
    const groupSourceIndex = (slot as { sidechainSourceGroupTrackIndex?: unknown })
      .sidechainSourceGroupTrackIndex;
    delete (slot as { sidechainSourceGroupTrackIndex?: unknown }).sidechainSourceGroupTrackIndex;
    if (
      allowSidechain &&
      typeof groupSourceIndex === 'number' &&
      Number.isInteger(groupSourceIndex) &&
      groupSourceIndex >= 0 &&
      groupSourceIndex < tracks.length
    ) {
      slot.sidechainSourceGroupTrackId = tracks[groupSourceIndex].id;
    }
  }
  return out;
}

/** Converts mixer-scope sidechain ids to document track indices. */
export function mixerWithSidechainSourceIndices(
  mixer: ProjectMixerState,
  tracks: ReadonlyArray<{ id: number }>,
): ProjectMixerState {
  const out = cloneMixerState(mixer);
  out.master = stripWithSidechainSourceIndices(out.master, tracks);
  for (const bus of out.buses) {
    if (bus.strip !== undefined) bus.strip = stripWithSidechainSourceIndices(bus.strip, tracks);
  }
  return out;
}

/** Rebinds mixer-scope document sidechain indices to session track ids. */
export function resolveMixerSidechainSourceIds(
  mixer: ProjectMixerState,
  tracks: ReadonlyArray<{ id: number }>,
): void {
  const resolveStrip = (strip: MixerStrip): void => {
    for (const slot of strip.inserts) {
      const sourceIndex = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      delete (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
      if (
        typeof sourceIndex === 'number' &&
        Number.isInteger(sourceIndex) &&
        sourceIndex >= 0 &&
        sourceIndex < tracks.length
      ) {
        slot.sidechainSourceTrackId = tracks[sourceIndex].id;
      }
      const groupSourceIndex = (slot as { sidechainSourceGroupTrackIndex?: unknown })
        .sidechainSourceGroupTrackIndex;
      delete (slot as { sidechainSourceGroupTrackIndex?: unknown }).sidechainSourceGroupTrackIndex;
      if (
        typeof groupSourceIndex === 'number' &&
        Number.isInteger(groupSourceIndex) &&
        groupSourceIndex >= 0 &&
        groupSourceIndex < tracks.length
      ) {
        slot.sidechainSourceGroupTrackId = tracks[groupSourceIndex].id;
      }
    }
  };
  resolveStrip(mixer.master);
  for (const bus of mixer.buses) {
    if (bus.strip !== undefined) resolveStrip(bus.strip);
  }
}

/**
 * Migrates a legacy positional track key that points at a group track into
 * the explicit group-bus namespace. Ordinary track strips cannot consume a
 * group lane, so those documents fail before they reach the native project
 * instead of silently producing an unkeyed insert.
 */
function normalizeDocumentGroupSidechainKeys(
  strip: MixerStrip | undefined,
  targetKind: TrackKind | 'bus' | 'master',
  tracks: ReadonlyArray<Pick<DocumentTrack, 'kind'>>,
): void {
  if (!strip) return;
  for (const slot of strip.inserts) {
    const sourceIndex = (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
    if (
      typeof sourceIndex !== 'number' ||
      !Number.isInteger(sourceIndex) ||
      sourceIndex < 0 ||
      sourceIndex >= tracks.length ||
      tracks[sourceIndex].kind !== 'group'
    ) {
      continue;
    }
    if (targetKind !== 'group' && targetKind !== 'bus' && targetKind !== 'master') {
      throw new RangeError(
        `Track sidechain source ${sourceIndex} is a group bus; use a group sidechain key`,
      );
    }
    delete (slot as { sidechainSourceIndex?: unknown }).sidechainSourceIndex;
    (slot as { sidechainSourceGroupTrackIndex?: number }).sidechainSourceGroupTrackIndex =
      sourceIndex;
  }
}

/** Applies the group-key migration to all persisted mixer snapshot scopes. */
export function normalizeDocumentSnapshotGroupSidechainKeys(
  slots: DocumentMixerSnapshotSlots | undefined,
  tracks: ReadonlyArray<DocumentTrack>,
): void {
  if (!slots) return;
  for (const snapshot of Object.values(slots.slots)) {
    if (!snapshot) continue;
    normalizeDocumentGroupSidechainKeys(snapshot.mixer.master, 'master', tracks);
    for (const bus of snapshot.mixer.buses) {
      normalizeDocumentGroupSidechainKeys(bus.strip, 'bus', tracks);
    }
    for (const entry of snapshot.tracks) {
      const target = tracks[entry.trackIndex];
      if (target) normalizeDocumentGroupSidechainKeys(entry.mixer, target.kind, tracks);
    }
  }
}

/**
 * Validates mixer ids and bus/group routing before a document reaches the
 * native project. Documents store group sidechain references positionally, so
 * the topology uses the document track index as the temporary group id.
 */
export function validateDocumentMixerRouting(
  mixer: DocumentMixerState | undefined,
  tracks: ReadonlyArray<DocumentTrack>,
): void {
  if (!mixer) {
    for (const track of tracks) {
      normalizeDocumentGroupSidechainKeys(track.mixer, track.kind, tracks);
    }
    return;
  }
  const busIds = new Set<string>();
  for (const bus of mixer.buses) {
    assertValidMixerBusId(bus.id, busIds);
    busIds.add(bus.id);
  }

  const normalizeStrip = (strip: MixerStrip | undefined): MixerStrip | undefined => {
    if (!strip) return undefined;
    const next = cloneStrip(strip);
    for (const slot of next.inserts) {
      const groupIndex = (slot as { sidechainSourceGroupTrackIndex?: unknown })
        .sidechainSourceGroupTrackIndex;
      if (groupIndex !== undefined) {
        slot.sidechainSourceGroupTrackId =
          typeof groupIndex === 'number' && Number.isInteger(groupIndex) ? groupIndex : -1;
      }
    }
    return next;
  };

  const assertTrackBusReferences = (strip: MixerStrip | undefined): void => {
    if (!strip) return;
    if (strip.outputBusId !== undefined && !busIds.has(strip.outputBusId)) {
      throw new RangeError(`Unknown mixer bus id: ${strip.outputBusId}`);
    }
    for (const send of strip.sends) {
      if (!busIds.has(send.busId)) {
        throw new RangeError(`Unknown mixer bus id: ${send.busId}`);
      }
    }
  };

  for (const track of tracks) assertTrackBusReferences(track.mixer);
  for (const track of tracks) {
    normalizeDocumentGroupSidechainKeys(track.mixer, track.kind, tracks);
  }
  normalizeDocumentGroupSidechainKeys(mixer.master, 'master', tracks);
  for (const bus of mixer.buses) {
    normalizeDocumentGroupSidechainKeys(bus.strip, 'bus', tracks);
  }
  for (const slot of mixer.master.inserts) {
    if (slot.sidechainSourceBusId !== undefined && !busIds.has(slot.sidechainSourceBusId)) {
      throw new RangeError(`Unknown mixer bus id: ${slot.sidechainSourceBusId}`);
    }
  }

  const busNodes = mixerBusTopology(
    {
      buses: mixer.buses.map((bus) => ({
        ...bus,
        ...(bus.strip ? { strip: normalizeStrip(bus.strip) } : {}),
      })),
    },
    tracks
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => track.kind === 'group')
      .map(({ track, index }) => ({ id: index, mixer: normalizeStrip(track.mixer) })),
  );
  assertValidMixerBusTopology(busNodes);
}

/** Converts in-memory mixer snapshot slots to document-portable slots. */
export function toDocumentMixerSnapshotSlots(
  state: MixerSnapshotSlotState,
  tracks: ReadonlyArray<{ id: number }>,
): DocumentMixerSnapshotSlots | undefined {
  const slots: Partial<Record<MixerSnapshotSlot, DocumentMixerSnapshot>> = {};
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = state.snapshots[slot];
    if (!snapshot) continue;
    const entries = snapshot.tracks.flatMap((entry) => {
      const trackIndex = tracks.findIndex((track) => track.id === entry.id);
      if (trackIndex < 0) return [];
      return [
        {
          ...entry,
          trackIndex,
          mixer: stripWithSidechainSourceIndices(entry.mixer, tracks),
          id: undefined,
        },
      ];
    });
    slots[slot] = {
      mixer: mixerWithSidechainSourceIndices(snapshot.mixer, tracks),
      tracks: entries.map(({ id: _id, ...entry }) => entry),
      ...(snapshot.automationLanes !== undefined
        ? {
            automationLanes: snapshot.automationLanes.flatMap((lane) => {
              if (typeof lane.target !== 'number') return [cloneAutomationLane(lane)];
              const trackIndex = tracks.findIndex((track) => track.id === lane.target);
              return trackIndex < 0 ? [] : [{ ...cloneAutomationLane(lane), target: trackIndex }];
            }),
          }
        : {}),
    };
  }
  if (Object.keys(slots).length === 0) return undefined;
  return {
    slots,
    ...(state.active && slots[state.active] ? { active: state.active } : {}),
  };
}

/** Converts document mixer snapshot slots back to session-track-id slots. */
export function fromDocumentMixerSnapshotSlots(
  docSlots: DocumentMixerSnapshotSlots | undefined,
  tracks: ReadonlyArray<{ id: number }>,
): MixerSnapshotSlotState | null {
  if (!docSlots) return null;
  const snapshots: Partial<Record<MixerSnapshotSlot, MixerSnapshot>> = {};
  for (const slot of MIXER_SNAPSHOT_SLOTS) {
    const snapshot = docSlots.slots[slot];
    if (!snapshot) continue;
    const mixer = cloneMixerState(snapshot.mixer);
    renameRetiredMixerProcessors(mixer);
    resolveMixerSidechainSourceIds(mixer, tracks);
    snapshots[slot] = {
      mixer,
      tracks: snapshot.tracks.flatMap((entry) => {
        const track = tracks[entry.trackIndex];
        if (!track) return [];
        const trackMixer = stripWithSidechainSourceIds(entry.mixer, tracks, true);
        renameRetiredProcessors(trackMixer.inserts);
        return [
          {
            id: track.id,
            mixer: trackMixer,
            mute: entry.mute,
            solo: entry.solo,
            ...(entry.volume !== undefined ? { volume: entry.volume } : {}),
            ...(entry.soloSafe !== undefined ? { soloSafe: entry.soloSafe } : {}),
            ...(entry.vcaId !== undefined ? { vcaId: entry.vcaId } : {}),
          },
        ];
      }),
      ...(snapshot.automationLanes !== undefined
        ? {
            automationLanes: snapshot.automationLanes.flatMap((lane) => {
              if (typeof lane.target !== 'number') return [cloneAutomationLane(lane)];
              const track = tracks[lane.target];
              return track ? [{ ...cloneAutomationLane(lane), target: track.id }] : [];
            }),
          }
        : {}),
    };
  }
  return {
    snapshots,
    active: docSlots.active && snapshots[docSlots.active] ? docSlots.active : null,
  };
}
