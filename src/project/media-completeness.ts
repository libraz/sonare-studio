import { formatMessage } from '@/ui/i18n/format';
import type { ProjectDocument } from './serialization';

export type ProjectMediaKind = 'audio-asset' | 'soundfont' | 'stored-project';
export type ProjectMediaRole = 'clip' | 'take' | 'frozen' | 'instrument' | 'library';
export type ProjectMediaFailure = 'missing' | 'unreadable' | 'encode-failed';

/** One concrete project/library reference whose media payload is unavailable. */
export interface MediaCompletenessIssue {
  kind: ProjectMediaKind;
  mediaId: string;
  role: ProjectMediaRole;
  reason: ProjectMediaFailure;
  projectName?: string;
  trackId?: number;
  clipId?: number;
  message?: string;
}

export interface MediaCompletenessReport {
  complete: boolean;
  issues: MediaCompletenessIssue[];
}

export function createMediaCompletenessReport(
  issues: readonly MediaCompletenessIssue[] = [],
): MediaCompletenessReport {
  const unique = new Map<string, MediaCompletenessIssue>();
  for (const issue of issues) {
    const key = [
      issue.kind,
      issue.mediaId,
      issue.role,
      issue.projectName ?? '',
      issue.trackId ?? '',
      issue.clipId ?? '',
      issue.reason,
    ].join('|');
    if (!unique.has(key)) unique.set(key, { ...issue });
  }
  const normalized = [...unique.values()];
  return { complete: normalized.length === 0, issues: normalized };
}

/** Every track/clip-level reference to one stored media id. */
export function projectMediaReferences(
  doc: ProjectDocument,
  kind: ProjectMediaKind,
  mediaId: string,
): Omit<MediaCompletenessIssue, 'reason' | 'message'>[] {
  const refs: Omit<MediaCompletenessIssue, 'reason' | 'message'>[] = [];
  doc.tracks.forEach((track, trackIndex) => {
    const trackId = trackIndex + 1;
    if (kind === 'soundfont') {
      if (track.instrument?.kind === 'sf2' && track.instrument.fontId === mediaId) {
        refs.push({ kind, mediaId, role: 'instrument', projectName: doc.name, trackId });
      }
      return;
    }
    if (track.frozen?.assetId === mediaId) {
      refs.push({ kind, mediaId, role: 'frozen', projectName: doc.name, trackId });
    }
    track.clips.forEach((clip, clipIndex) => {
      const clipId = clipIndex + 1;
      if ((clip.kind ?? track.kind) === 'audio' && clip.assetId === mediaId) {
        refs.push({ kind, mediaId, role: 'clip', projectName: doc.name, trackId, clipId });
      }
      if (clip.takes?.some((take) => take.assetId === mediaId)) {
        refs.push({ kind, mediaId, role: 'take', projectName: doc.name, trackId, clipId });
      }
    });
  });
  return refs;
}

export function mediaFailureIssues(
  doc: ProjectDocument,
  kind: ProjectMediaKind,
  mediaId: string,
  reason: ProjectMediaFailure,
  error?: unknown,
): MediaCompletenessIssue[] {
  const message =
    error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  const refs = projectMediaReferences(doc, kind, mediaId);
  const targets =
    refs.length > 0 ? refs : [{ kind, mediaId, role: 'library' as const, projectName: doc.name }];
  return targets.map((target) => ({ ...target, reason, ...(message ? { message } : {}) }));
}

/** Localized templates {@link formatMediaCompletenessReport} fills in. */
export interface MediaReportStrings {
  kind: Readonly<Record<ProjectMediaKind, string>>;
  role: Readonly<Record<ProjectMediaRole, string>>;
  reason: Readonly<Record<ProjectMediaFailure, string>>;
  /** Template with `{name}`. */
  project: string;
  /** Template with `{id}`. */
  track: string;
  /** Template with `{id}`. */
  clip: string;
  /** Joins the location parts. */
  separator: string;
  /** Template with `{kind}`, `{id}`, `{location}` and `{reason}`. */
  line: string;
}

/**
 * Compact persistent/UI text that retains the actionable ids and locations.
 *
 * @param report The completeness report to describe.
 * @param strings Localized templates.
 */
export function formatMediaCompletenessReport(
  report: MediaCompletenessReport,
  strings: MediaReportStrings,
): string {
  return report.issues
    .map((issue) => {
      const location = [
        issue.projectName === undefined
          ? ''
          : formatMessage(strings.project, { name: issue.projectName }),
        issue.trackId === undefined ? '' : formatMessage(strings.track, { id: issue.trackId }),
        issue.clipId === undefined ? '' : formatMessage(strings.clip, { id: issue.clipId }),
        strings.role[issue.role],
      ]
        .filter(Boolean)
        .join(strings.separator);
      return formatMessage(strings.line, {
        kind: strings.kind[issue.kind],
        id: issue.mediaId,
        location,
        reason: strings.reason[issue.reason],
      });
    })
    .join('\n');
}
