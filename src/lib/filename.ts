/** Control characters and the characters unsafe in filenames across common platforms. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are unsafe in filenames
export const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\\/:*?"<>|]/g;

/** Replaces filesystem-hostile characters and supplies a non-empty, non-dot-only base name. */
export function sanitizeFilenameBase(name: string, fallback = 'project'): string {
  const sanitized = name.trim().replace(UNSAFE_FILENAME_CHARS, '_').trim();
  return sanitized.length > 0 && !/^\.+$/.test(sanitized) ? sanitized : fallback;
}

/** Appends an extension only when the filename does not already carry it. */
export function ensureFileExtension(filename: string, extension: string): string {
  return filename.toLowerCase().endsWith(extension.toLowerCase())
    ? filename
    : `${filename}${extension}`;
}

/**
 * Builds a download filename from the project name: filesystem-hostile
 * characters are replaced with underscores and the given extension is
 * appended. Falls back to `fallback` when the name sanitizes to nothing so
 * exports never produce an extension-only filename.
 *
 * @param projectName Current project name.
 * @param extension File extension including the leading dot (e.g. '.pdf').
 * @param fallback Base name to use when the project name is empty.
 * @returns A safe filename such as `My Song.pdf`.
 */
export function projectFilename(
  projectName: string,
  extension: string,
  fallback = 'project',
): string {
  return ensureFileExtension(sanitizeFilenameBase(projectName, fallback), extension);
}
