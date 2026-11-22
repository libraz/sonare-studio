/**
 * Name lookups backed by the wasm module's GM/GM2/GS catalog. Every accessor
 * degrades to "no name" while the module is not loaded or names nothing.
 */
import { isDrumTrack } from '@/compose/tracks';
import { getWasmModule } from '@/project/store';
import type { EditorNote, EditorTrack } from '@/project/types';

/** The catalog surface of the wasm module. */
export type GmCatalog = Pick<
  typeof import('@libraz/libsonare'),
  | 'gmInstrumentName'
  | 'gm2InstrumentName'
  | 'gm2DrumSetName'
  | 'gmFamilyName'
  | 'gmFamilyFirstProgram'
  | 'synthGsDrumKitName'
  | 'synthGsDrumKitIsVoicedApart'
  | 'synthGsVariationIsVoicedApart'
>;

/** One GM instrument family (eight consecutive programs). */
export interface GmFamily {
  index: number;
  name: string;
  firstProgram: number;
}

/** Number of GM instrument families. */
const GM_FAMILY_COUNT = 16;

/** The wasm catalog surface, or null before the module is ready. */
export function gmCatalog(): GmCatalog | null {
  try {
    return getWasmModule();
  } catch {
    return null;
  }
}

/** Runs a catalog lookup; the core throws for an out-of-range number, which names nothing. */
function lookup(read: (catalog: GmCatalog) => string | undefined): string | null {
  const catalog = gmCatalog();
  if (!catalog) return null;
  try {
    return read(catalog) ?? null;
  } catch {
    return null;
  }
}

/** GM program name, or null when the module does not name it. */
export function gmProgramName(program: number): string | null {
  return lookup((catalog) => catalog.gmInstrumentName(program));
}

/** GM2 variation name for a bank (only its LSB selects the variation), or null. */
export function gm2ProgramName(bank: number, program: number): string | null {
  return lookup((catalog) => catalog.gm2InstrumentName({ bankLsb: bank & 0x7f, program }));
}

/** GM2 drum/SFX kit name for a bank LSB, or null. */
export function gm2DrumSetName(bankLsb: number): string | null {
  return lookup((catalog) => catalog.gm2DrumSetName(bankLsb));
}

/** All GM families; empty before the module is ready. */
export function gmFamilies(): GmFamily[] {
  const catalog = gmCatalog();
  if (!catalog) return [];
  return Array.from({ length: GM_FAMILY_COUNT }, (_, index) => ({
    index,
    name: catalog.gmFamilyName(index),
    firstProgram: catalog.gmFamilyFirstProgram(index),
  }));
}

/**
 * Whether a track is percussion. The track's notes are gathered only when the
 * track-level checks (override, generator, instrument, name) cannot decide.
 */
export function trackIsDrums(
  track: EditorTrack | null | undefined,
  notes: () => ReadonlyArray<EditorNote>,
): boolean {
  if (!track) return false;
  if (track.percussion !== undefined) return track.percussion;
  return isDrumTrack(track) || isDrumTrack(track, notes());
}
