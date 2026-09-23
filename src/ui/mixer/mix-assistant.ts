/**
 * Mixing-assistant suggestions: renders each track dry, hands the stems to
 * libsonare's `suggestMixScene`, and returns the suggested scene with the
 * reasoning behind it. Nothing is applied here — the scene reaches the mixer
 * only through the user's explicit Apply (applyMixerSceneJson), one undoable
 * edit, because a mix has no single right answer.
 *
 * The stems come from a copy of the document with every strip neutral (no
 * inserts, sends, fader, pan, buses or mastering), so the assistant measures
 * the material rather than the current mix. Strips are named `track-<id>` so
 * the scene maps back onto the tracks it was measured from.
 */

import { parseInstrumentAutomationParam } from '@/project/automation';
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
 * The document with every strip neutral, so a render measures the material
 * and not the current mix. Mutes and instrument lanes are kept; solos, VCAs,
 * sends, buses, mix automation and the mastering chain are dropped.
 */
export function neutralMixDocument(doc: ProjectDocument): ProjectDocument {
  return {
    ...doc,
    tracks: doc.tracks.map((track) => {
      const { mixer: _mixer, vcaId: _vcaId, automation, ...rest } = track;
      // Instrument lanes shape the material itself; every other lane is the mix.
      const instrumentLanes = (automation ?? []).filter(
        (lane) => parseInstrumentAutomationParam(lane.param) !== undefined,
      );
      return {
        ...rest,
        solo: false,
        volume: 1,
        pan: 0,
        ...(instrumentLanes.length > 0 ? { automation: instrumentLanes } : {}),
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
