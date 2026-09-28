/**
 * Mixing-assistant suggestions: renders each track dry, hands the stems to
 * libsonare's `suggestMixScene`, and returns the suggested scene with the
 * reasoning behind it. Nothing is applied here — the scene reaches the mixer
 * only through the user's explicit Apply (applyMixerSceneJson), one undoable
 * edit, because a mix has no single right answer.
 *
 * The stems come from a copy of the document with mixer settings neutralized.
 * User inserts remain so the assistant hears sound-design choices such as a
 * guitar amp; inserts from earlier suggestions are removed. Strips are named `track-<id>` so
 * the scene maps back onto the tracks it was measured from.
 */

import {
  insertAutomationParam,
  parseInsertAutomationParam,
  parseInstrumentAutomationParam,
} from '@/project/automation';
import { createDefaultStrip } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';
import type { MixAssistantResult, MixAssistantTrack } from '@/wasm/index.js';

/** A track's dry render as the assistant reads it. */
export interface MixAssistantStem {
  trackId: number;
  name: string;
  left: Float32Array;
  right: Float32Array;
}

/**
 * The document with mixer settings neutral, while preserving user inserts.
 * Mutes and source instrument/insert lanes are kept; solos, VCAs, sends,
 * buses, fader automation and the mastering chain are dropped.
 */
export function neutralMixDocument(doc: ProjectDocument): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      const { mixer, groupIndex: _groupIndex, vcaId: _vcaId, automation, ...rest } = track;
      const originalInserts = mixer?.inserts ?? [];
      const keptIndexByOriginal = new Map<number, number>();
      const sourceInserts = (track.kind === 'group' ? [] : originalInserts).filter(
        (slot, index) => {
          const serializedSidechain = slot as typeof slot & {
            sidechainSourceIndex?: number;
            sidechainSourceGroupTrackIndex?: number;
          };
          const keep =
            slot.id?.startsWith('mix-assistant-') !== true &&
            slot.sidechainSourceTrackId === undefined &&
            slot.sidechainSourceBusId === undefined &&
            slot.sidechainSourceGroupTrackId === undefined &&
            serializedSidechain.sidechainSourceIndex === undefined &&
            serializedSidechain.sidechainSourceGroupTrackIndex === undefined;
          if (keep) keptIndexByOriginal.set(index, keptIndexByOriginal.size);
          return keep;
        },
      );
      const keptIds = new Set(
        sourceInserts.map((slot) => slot.id).filter((id) => id !== undefined),
      );
      // Preserve automation that changes the source instrument or a retained
      // insert, remapping legacy positional insert references after filtering.
      const sourceAutomation = (automation ?? []).flatMap((lane) => {
        if (parseInstrumentAutomationParam(lane.param) !== undefined) return [lane];
        const ref = parseInsertAutomationParam(lane.param);
        if (!ref) return [];
        if (ref.processorId !== undefined) return keptIds.has(ref.processorId) ? [lane] : [];
        if (ref.insertIndex === undefined) return [];
        const newIndex = keptIndexByOriginal.get(ref.insertIndex);
        return newIndex === undefined
          ? []
          : [{ ...lane, param: insertAutomationParam(newIndex, ref.paramName) }];
      });
      return {
        ...rest,
        solo: false,
        volume: 1,
        pan: 0,
        ...(sourceInserts.length > 0
          ? { mixer: { ...createDefaultStrip(), inserts: sourceInserts } }
          : {}),
        ...(sourceAutomation.length > 0 ? { automation: sourceAutomation } : {}),
      };
    }),
    mixer: { master: createDefaultStrip(), buses: [] },
    masterAutomation: [],
  };
}

/** The stem id a track is measured under, the same spelling the engine sync writes. */
export function mixAssistantStripId(trackId: number): string {
  return `track-${trackId}`;
}

/**
 * Hands the dry stems to the assistant. Group tracks carry no material of their
 * own and are left out.
 */
export function suggestMixFromStems(
  stems: ReadonlyArray<MixAssistantStem>,
  sampleRate: number,
  tempoBpm: number,
  suggest: (request: {
    tracks: MixAssistantTrack[];
    sampleRate: number;
    options?: { tempoBpm?: number };
  }) => MixAssistantResult,
): MixAssistantResult {
  return suggest({
    tracks: stems.map((stem) => ({
      id: mixAssistantStripId(stem.trackId),
      name: stem.name,
      left: stem.left,
      right: stem.right,
    })),
    sampleRate,
    options: { tempoBpm },
  });
}
