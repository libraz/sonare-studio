/**
 * Name lookups backed by the wasm module's GM/GM2/GS catalog. Every accessor
 * degrades to "no name" while the module is not loaded or lacks a helper.
 */
import { isDrumTrack } from '@/compose/tracks';
import { getWasmModule } from '@/project/store';
import type { EditorNote, EditorTrack } from '@/project/types';

/** The optional catalog surface of the wasm module. */
export interface GmCatalog {
  Project?: {
    gmInstrumentName?: (program: number) => string | null;
    gm2InstrumentName?: (bankLsb: number, program: number) => string | null;
    gm2DrumSetName?: (bankLsb: number) => string | null;
    gmFamilyName?: (family: number) => string | null;
    gmFamilyFirstProgram?: (family: number) => number;
  };
  synthGsDrumKitName?: (program: number) => string | null;
  synthGsDrumKitIsVoicedApart?: (program: number) => boolean | null;
  synthGsVariationIsVoicedApart?: (bank: number, program: number) => boolean | null;
}

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
    return getWasmModule() as unknown as GmCatalog;
  } catch {
    return null;
  }
}

/** GM program name, or null when the module does not name it. */
export function gmProgramName(program: number): string | null {
  return gmCatalog()?.Project?.gmInstrumentName?.(program) ?? null;
}

/** GM2 variation name for a bank (only its LSB selects the variation), or null. */
export function gm2ProgramName(bank: number, program: number): string | null {
  return gmCatalog()?.Project?.gm2InstrumentName?.(bank & 0x7f, program) ?? null;
}

/** GM2 drum/SFX kit name for a bank LSB, or null. */
export function gm2DrumSetName(bankLsb: number): string | null {
  return gmCatalog()?.Project?.gm2DrumSetName?.(bankLsb) ?? null;
}

/** All GM families; empty when the module lacks the family helpers. */
export function gmFamilies(): GmFamily[] {
  const project = gmCatalog()?.Project;
  if (!project?.gmFamilyName || !project.gmFamilyFirstProgram) return [];
  return Array.from({ length: GM_FAMILY_COUNT }, (_, index) => ({
    index,
    name: project.gmFamilyName?.(index) ?? `Family ${index + 1}`,
    firstProgram: project.gmFamilyFirstProgram?.(index) ?? index * 8,
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
