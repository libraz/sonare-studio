import { formatTimestamp } from './date-format';

/**
 * Build stamp injected by the Vite build.
 *
 * Deployments are untagged, so the build time and the short commit are the only
 * way to tell which build a browser is running. Each constant is read through a
 * `typeof` guard because the define is absent outside a Vite build (unit tests),
 * where referencing the identifier directly would throw.
 */

/** Application version declared in package.json, or an empty string when unknown. */
export const APP_VERSION = typeof __SONARE_APP_VERSION__ === 'string' ? __SONARE_APP_VERSION__ : '';

/** Short commit the running build was produced from, or an empty string when unknown. */
export const BUILD_COMMIT =
  typeof __SONARE_BUILD_COMMIT__ === 'string' ? __SONARE_BUILD_COMMIT__ : '';

/** ISO-8601 build timestamp, or an empty string when unknown. */
export const BUILD_TIME = typeof __SONARE_BUILD_TIME__ === 'string' ? __SONARE_BUILD_TIME__ : '';

/** Public repository holding this app's source, offered to every user under AGPL-3.0 section 13. */
export const SOURCE_REPOSITORY_URL = 'https://github.com/libraz/sonare-studio';

/** SPDX identifier of the app's licence. */
export const LICENSE_SPDX = 'AGPL-3.0-or-later';

/** The source tree the running build was made from, or the default branch when the commit is unknown. */
export function sourceTreeUrl(commit: string): string {
  return `${SOURCE_REPOSITORY_URL}/tree/${commit === '' ? 'main' : commit}`;
}

/** The licence text as of the running build, or as of the default branch when the commit is unknown. */
export function licenseUrl(commit: string): string {
  return `${SOURCE_REPOSITORY_URL}/blob/${commit === '' ? 'main' : commit}/LICENSE`;
}

/**
 * Formats a build timestamp in the viewer's own time zone, so the displayed
 * moment matches the clock the user compares it against. Returns an empty
 * string when the stamp is missing or unparseable.
 */
export function formatBuildTime(iso: string, locale: string): string {
  if (iso === '') return '';
  const built = new Date(iso);
  if (Number.isNaN(built.getTime())) return '';
  return formatTimestamp(built, locale, { dateStyle: 'medium', timeStyle: 'short' });
}
