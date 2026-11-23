/**
 * External separated-stem provenance: the studio's role vocabulary for stems
 * produced by an outside source-separation tool and imported as tracks.
 *
 * The role is stored on the clip that places the stem (`externalStemRole`),
 * not on its audio source, which identical stems share; the accepted values
 * are defined here and nowhere else. This is deliberately separate from the HPSS band vocabulary
 * in src/project/audio-stems.ts, which describes bands the studio separates
 * itself.
 */

/** Role an externally separated stem plays in the mix. */
export type ExternalStemRole = 'vocals' | 'drums' | 'bass' | 'other';

/**
 * Roles in the order stems are laid down as tracks, and the order
 * {@link inferExternalStemRole} matches file names against.
 */
export const EXTERNAL_STEM_ROLES: ReadonlyArray<ExternalStemRole> = [
  'vocals',
  'drums',
  'bass',
  'other',
];

/**
 * Unambiguous file-name markers per role. Matching is a case-insensitive
 * substring test, so a separator's usual "<song> - vocals.wav" or
 * "song_bass_stem.wav" naming lands on the right role.
 */
const ROLE_MARKERS: ReadonlyArray<{ role: ExternalStemRole; markers: ReadonlyArray<string> }> = [
  { role: 'vocals', markers: ['vocals', 'vocal', 'vox'] },
  { role: 'drums', markers: ['drums', 'drum'] },
  { role: 'bass', markers: ['bass'] },
];

/**
 * Infers a stem role from a file name.
 *
 * Names carrying markers for more than one role resolve to the first match in
 * {@link EXTERNAL_STEM_ROLES} order, so the result never depends on how the
 * separator ordered its words.
 *
 * @param fileName File (or asset) name; the extension is irrelevant.
 * @returns The matched role, or 'other' when no marker is present.
 */
export function inferExternalStemRole(fileName: string): ExternalStemRole {
  const needle = fileName.toLowerCase();
  for (const { role, markers } of ROLE_MARKERS) {
    if (markers.some((marker) => needle.includes(marker))) return role;
  }
  return 'other';
}

/** True when `value` is one of the studio's known stem roles. */
export function isExternalStemRole(value: unknown): value is ExternalStemRole {
  return typeof value === 'string' && EXTERNAL_STEM_ROLES.includes(value as ExternalStemRole);
}

/**
 * Track name an imported stem is laid down under. Document content, so it is
 * English like every other generated track name.
 */
export function externalStemTrackName(role: ExternalStemRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
