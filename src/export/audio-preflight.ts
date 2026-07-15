/** Audio-export preflight for omissions that would otherwise become silence. */

import { type LoadedAudioAsset, loadAsset } from '@/persistence/assets';
import { audioClipSegments } from '@/project/comping';
import { effectiveTrackInstrument } from '@/project/instrument';
import type { InsertSlot } from '@/project/mixer';
import type { ProjectDocument } from '@/project/serialization';

export interface AudioExportPreflightResult {
  /** Conditions that must be fixed before starting the expensive render. */
  blockers: string[];
  /** Known fidelity limitations the user may explicitly accept. */
  warnings: string[];
}

export interface AudioExportPreflightOptions {
  /** Release tail selected for a project-range export. */
  releaseTailSeconds: number;
  /** Explicit loop ranges do not append a release tail. */
  range: 'project' | 'loop';
  /** Injectable full asset validation seam; defaults to the cached OPFS loader. */
  loadAudioAsset?: (assetId: string) => Promise<LoadedAudioAsset>;
  signal?: AbortSignal;
}

interface AssetUse {
  id: string;
  labels: Set<string>;
}

function isMidiClip(clip: ProjectDocument['tracks'][number]['clips'][number]): boolean {
  return (clip.kind ?? 'midi') === 'midi';
}

function activeTimeEffectSlots(doc: ProjectDocument): InsertSlot[] {
  const slots: InsertSlot[] = [];
  for (const track of doc.tracks) slots.push(...(track.mixer?.inserts ?? []));
  slots.push(...(doc.mixer?.master.inserts ?? []));
  for (const bus of doc.mixer?.buses ?? []) slots.push(...(bus.strip?.inserts ?? []));
  slots.push(...(doc.mixer?.masteringChain?.processors ?? []));
  return slots.filter((slot) => slot.enabled && /(?:reverb|delay|echo)/i.test(slot.processor));
}

function suggestedTailSeconds(slots: ReadonlyArray<InsertSlot>): number {
  let suggested = slots.length > 0 ? 5 : 0;
  for (const slot of slots) {
    for (const [name, value] of Object.entries(slot.params)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      if (/(?:decay|release|tail)(?:Seconds|Sec)$/i.test(name))
        suggested = Math.max(suggested, value);
      if (/(?:decay|release|tail)(?:Milliseconds|Ms)$/i.test(name)) {
        suggested = Math.max(suggested, value / 1000);
      }
    }
  }
  return suggested;
}

/**
 * Validates media referenced by audible audio/frozen content and reports
 * offline-only losses before rendering. Asset loading is cached by the normal
 * persistence layer, so successful validation is reused by the renderer.
 */
export async function audioExportPreflight(
  doc: ProjectDocument,
  options: AudioExportPreflightOptions,
): Promise<AudioExportPreflightResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const uses = new Map<string, AssetUse>();
  const addUse = (id: string, label: string): void => {
    const use = uses.get(id) ?? { id, labels: new Set<string>() };
    use.labels.add(label);
    uses.set(id, use);
  };

  for (const track of doc.tracks) {
    options.signal?.throwIfAborted();
    if (track.frozen !== undefined) {
      addUse(track.frozen.assetId, `frozen track "${track.name}"`);
      continue;
    }

    const instrument = effectiveTrackInstrument(track, doc.externalMidiDefault);
    if (
      track.kind === 'midi' &&
      instrument.kind === 'external-midi' &&
      track.clips.some((clip) => isMidiClip(clip) && clip.lengthPpq > 0)
    ) {
      warnings.push(`external MIDI track "${track.name}" is silent in audio export`);
    }

    for (const clip of track.clips) {
      if ((clip.kind ?? 'midi') !== 'audio' || clip.gain <= 0 || clip.lengthPpq <= 0) continue;
      const segments = audioClipSegments(clip);
      if (segments.length === 0) {
        blockers.push(`audio clip "${clip.name}" on "${track.name}" has no media reference`);
        continue;
      }
      for (const segment of segments) addUse(segment.assetId, `audio clip "${clip.name}"`);
    }
  }

  const loadAudio = options.loadAudioAsset ?? loadAsset;
  for (const use of uses.values()) {
    options.signal?.throwIfAborted();
    try {
      await loadAudio(use.id);
    } catch (error) {
      options.signal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      blockers.push(
        `${[...use.labels].join(', ')} references missing or unreadable media "${use.id}": ${reason}`,
      );
    }
  }

  if (options.range === 'project') {
    const tail = suggestedTailSeconds(activeTimeEffectSlots(doc));
    if (tail > options.releaseTailSeconds) {
      warnings.push(
        `release tail is ${options.releaseTailSeconds}s, but active reverb/delay settings suggest at least ${tail}s`,
      );
    }
  }

  return { blockers, warnings };
}
