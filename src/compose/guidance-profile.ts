import type { SafetyProfile } from '@libraz/libcantus';

/** Part-writing strictness shared by the tint, cards, placement verdicts and countermelody generation. */
export type GuidanceProfile = 'counterpoint' | 'pop';

/**
 * Default used by the pure guidance API when no profile is supplied.
 *
 * Keep this strict so callers that use the analysis helpers directly retain a
 * conservative result. The application preference has its own beginner-first
 * default below.
 */
export const DEFAULT_GUIDANCE_PROFILE: GuidanceProfile = 'counterpoint';

/** Profile selected for a fresh Sonare Studio settings store. */
export const DEFAULT_APP_GUIDANCE_PROFILE: GuidanceProfile = 'pop';

/** Maps the studio profile onto libcantus' safety profile. */
export function toSafetyProfile(p: GuidanceProfile): SafetyProfile {
  return p === 'counterpoint' ? 'strict' : 'pop';
}
