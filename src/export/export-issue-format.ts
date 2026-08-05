/**
 * Formats the structured audio-export issues — preflight blockers/warnings and
 * offline-render limitations — into localized strings.
 *
 * The preflight and renderer emit machine-typed records (`{ kind, ...params }`)
 * so their user-facing wording lives in the i18n bundles rather than hardcoded
 * English in the export pipeline. This mirrors the DAWproject loss-list and the
 * progress-stage formatter (see {@link ./export-stage}).
 */

import type { AudioAssetLabel, AudioExportBlocker, AudioExportWarning } from './audio-preflight';
import type { ExportLimitation } from './mixdown';

/** Localized templates for the structured export issues. */
export interface ExportIssueStrings {
  blocker: {
    audioClipNoMedia: string;
    mediaMissing: string;
  };
  warning: {
    externalMidiSilent: string;
    releaseTailShort: string;
    soloActive: string;
    pflModeActive: string;
    silentMixdown: string;
  };
  label: {
    frozenTrack: string;
    audioClip: string;
  };
  limitation: {
    masteringAutomationAtStart: string;
    instrumentAutomationAtStart: string;
  };
}

/** Formats one asset-reference label (e.g. `frozen track "Keys"`). */
export function formatAudioAssetLabel(label: AudioAssetLabel, strings: ExportIssueStrings): string {
  switch (label.kind) {
    case 'frozen-track':
      return strings.label.frozenTrack.replace('{name}', label.name);
    case 'audio-clip':
      return strings.label.audioClip.replace('{name}', label.name);
  }
}

/** Formats a preflight blocker (a condition that must be fixed before rendering). */
export function formatPreflightBlocker(
  blocker: AudioExportBlocker,
  strings: ExportIssueStrings,
): string {
  switch (blocker.kind) {
    case 'audio-clip-no-media':
      return strings.blocker.audioClipNoMedia
        .replace('{clip}', blocker.clip)
        .replace('{track}', blocker.track);
    case 'media-missing':
      return strings.blocker.mediaMissing
        .replace(
          '{labels}',
          blocker.labels.map((label) => formatAudioAssetLabel(label, strings)).join(', '),
        )
        .replace('{id}', blocker.assetId)
        .replace('{reason}', blocker.reason);
  }
}

/** Formats a preflight warning (a fidelity limitation the user may accept). */
export function formatPreflightWarning(
  warning: AudioExportWarning,
  strings: ExportIssueStrings,
): string {
  switch (warning.kind) {
    case 'external-midi-silent':
      return strings.warning.externalMidiSilent.replace('{track}', warning.track);
    case 'release-tail-short':
      return strings.warning.releaseTailShort
        .replace('{current}', String(warning.currentSeconds))
        .replace('{suggested}', String(warning.suggestedSeconds));
    case 'solo-active':
      return strings.warning.soloActive.replace('{tracks}', warning.tracks.join(', '));
    case 'pfl-mode-active':
      return strings.warning.pflModeActive;
    case 'silent-mixdown':
      return strings.warning.silentMixdown;
  }
}

/** Formats an offline-render limitation recorded on the mixdown report. */
export function formatExportLimitation(
  limitation: ExportLimitation,
  strings: ExportIssueStrings,
): string {
  switch (limitation.kind) {
    case 'mastering-automation-at-render-start':
      return strings.limitation.masteringAutomationAtStart;
    case 'instrument-automation-at-render-start':
      return strings.limitation.instrumentAutomationAtStart.replace(
        '{tracks}',
        limitation.tracks.join(', '),
      );
  }
}
