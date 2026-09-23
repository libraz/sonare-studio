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
import type { ClippingSummary, ExportLimitation } from './mixdown';

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
    returnSoloActive: string;
    pflModeActive: string;
    silentMixdown: string;
  };
  label: {
    frozenTrack: string;
    audioClip: string;
  };
  limitation: {
    masteringAutomationAtStart: string;
    /** Variant naming the parameters; falls back to the whole-rack wording. */
    masteringAutomationAtStartParams?: string;
    streamingMeteringUnavailable?: string;
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
    case 'return-solo-active':
      return strings.warning.returnSoloActive.replace('{buses}', warning.buses.join(', '));
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
    case 'mastering-automation-at-render-start': {
      const params = limitation.params;
      const named = strings.limitation.masteringAutomationAtStartParams;
      // Naming the frozen parameters only helps once the render knows which
      // stages it did drive; a whole-rack limitation keeps the plain wording.
      return params !== undefined && params.length > 0 && named !== undefined
        ? named.replace('{params}', params.join(', '))
        : strings.limitation.masteringAutomationAtStart;
    }
    case 'streaming-metering-unavailable':
      return (
        strings.limitation.streamingMeteringUnavailable ??
        'Streaming export could not measure: {measurements}'
      ).replace('{measurements}', limitation.measurements.join(', '));
  }
}

/**
 * Formats a clipping census into a localized sentence.
 *
 * Shared by the export dialog and the mastering preview because both answer
 * the same question about the same measurement: a peak reading says how far
 * over the render went, this says whether that was one stray sample or a
 * passage. Each surface passes its own template so the wording stays with the
 * screen it appears on.
 *
 * @param clipping Census from the mixdown report, or undefined when clean.
 * @param sampleRate Rate the report was measured at; 0 falls back to frames.
 * @param template Localized template with {samples} {percent} {regions} {time}.
 * @returns The sentence, or an empty string when nothing clipped.
 */
export function formatClippingCensus(
  clipping: ClippingSummary | undefined,
  sampleRate: number,
  template: string,
): string {
  if (!clipping) return '';
  const percent = clipping.clippingRatio * 100;
  return (
    template
      .replace('{samples}', clipping.clippedSamples.toLocaleString('en-US'))
      // Rounding a handful of clipped samples in a long render to "0.00%" would
      // read as "nothing happened" next to a non-zero sample count.
      .replace('{percent}', percent > 0 && percent < 0.01 ? '<0.01' : percent.toFixed(2))
      .replace('{regions}', String(clipping.regionCount))
      .replace(
        '{time}',
        sampleRate > 0
          ? `${(clipping.firstRegionStartSample / sampleRate).toFixed(2)} s`
          : `${clipping.firstRegionStartSample}`,
      )
  );
}
