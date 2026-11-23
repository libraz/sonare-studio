/**
 * Formats the structured audio-export issues — preflight blockers/warnings and
 * offline-render limitations — into localized strings.
 *
 * The preflight and renderer emit machine-typed records (`{ kind, ...params }`)
 * so their user-facing wording lives in the i18n bundles rather than hardcoded
 * English in the export pipeline. This mirrors the DAWproject loss-list and the
 * progress-stage formatter (see {@link ./export-stage}).
 */

import { formatMessage } from '@/ui/i18n/format';
import type { AudioAssetLabel, AudioExportBlocker, AudioExportWarning } from './audio-preflight';
import type { ClippingSummary, ExportLimitation } from './mixdown';

/** Localized templates for the structured export issues. */
export interface ExportIssueStrings {
  blocker: {
    audioClipNoMedia: string;
    mediaMissing: string;
    soundFontMissing: string;
  };
  warning: {
    externalMidiSilent: string;
    releaseTailShort: string;
    soloActive: string;
    returnSoloActive: string;
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
    streamingMeteringUnavailable: string;
    masteringLoudnessTargetLimited: string;
    warpVoicesExceeded: string;
  };
}

/** Formats one asset-reference label (e.g. `frozen track "Keys"`). */
function formatAudioAssetLabel(label: AudioAssetLabel, strings: ExportIssueStrings): string {
  switch (label.kind) {
    case 'frozen-track':
      return formatMessage(strings.label.frozenTrack, { name: label.name });
    case 'audio-clip':
      return formatMessage(strings.label.audioClip, { name: label.name });
  }
}

/** Formats a preflight blocker (a condition that must be fixed before rendering). */
export function formatPreflightBlocker(
  blocker: AudioExportBlocker,
  strings: ExportIssueStrings,
): string {
  switch (blocker.kind) {
    case 'audio-clip-no-media':
      return formatMessage(strings.blocker.audioClipNoMedia, {
        clip: blocker.clip,
        track: blocker.track,
      });
    case 'media-missing':
      return formatMessage(strings.blocker.mediaMissing, {
        labels: blocker.labels.map((label) => formatAudioAssetLabel(label, strings)).join(', '),
        id: blocker.assetId,
        reason: blocker.reason,
      });
    case 'soundfont-missing':
      return formatMessage(strings.blocker.soundFontMissing, {
        id: blocker.fontId,
        reason: blocker.reason,
      });
  }
}

/** Formats a preflight warning (a fidelity limitation the user may accept). */
export function formatPreflightWarning(
  warning: AudioExportWarning,
  strings: ExportIssueStrings,
): string {
  switch (warning.kind) {
    case 'external-midi-silent':
      return formatMessage(strings.warning.externalMidiSilent, { track: warning.track });
    case 'release-tail-short':
      return formatMessage(strings.warning.releaseTailShort, {
        current: warning.currentSeconds,
        suggested: warning.suggestedSeconds,
      });
    case 'solo-active':
      return formatMessage(strings.warning.soloActive, { tracks: warning.tracks.join(', ') });
    case 'return-solo-active':
      return formatMessage(strings.warning.returnSoloActive, { buses: warning.buses.join(', ') });
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
        ? formatMessage(named, { params: params.join(', ') })
        : strings.limitation.masteringAutomationAtStart;
    }
    case 'mastering-loudness-target-limited':
      return formatMessage(strings.limitation.masteringLoudnessTargetLimited, {
        lufs: limitation.outputLufs.toFixed(1),
      });
    case 'warp-voices-exceeded':
      return strings.limitation.warpVoicesExceeded;
    case 'streaming-metering-unavailable':
      return formatMessage(strings.limitation.streamingMeteringUnavailable, {
        measurements: limitation.measurements.join(', '),
      });
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
  return formatMessage(template, {
    samples: clipping.clippedSamples.toLocaleString('en-US'),
    // Rounding a handful of clipped samples in a long render to "0.00%" would
    // read as "nothing happened" next to a non-zero sample count.
    percent: percent > 0 && percent < 0.01 ? '<0.01' : percent.toFixed(2),
    regions: clipping.regionCount,
    time:
      sampleRate > 0
        ? `${(clipping.firstRegionStartSample / sampleRate).toFixed(2)} s`
        : `${clipping.firstRegionStartSample}`,
  });
}
