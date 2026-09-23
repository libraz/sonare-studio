import type { SafetyProfile } from '@libraz/libcantus';

/** Part-writing strictness shared by the tint, cards, placement verdicts and countermelody generation. */
export type GuidanceProfile = 'counterpoint' | 'pop';

export const DEFAULT_GUIDANCE_PROFILE: GuidanceProfile = 'counterpoint';

/** Maps the studio profile onto libcantus' safety profile. */
export function toSafetyProfile(p: GuidanceProfile): SafetyProfile {
  return p === 'counterpoint' ? 'strict' : 'pop';
}
