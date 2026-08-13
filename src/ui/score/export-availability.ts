/**
 * Shared eligibility for MusicXML export entry points.
 *
 * Part mode is intentionally scoped to the active MIDI clip. Full Score mode
 * is project-scoped and only needs one MIDI track; the active clip may be an
 * audio clip while the score window is still used to select the arrangement
 * range.
 */

export type ScoreExportMode = 'part' | 'full-score';

/** Stable reasons shared by the action and menu guards. */
export type ScoreExportAvailabilityReason =
  | 'active-midi-clip-required'
  | 'midi-track-required'
  | 'score-window-required';

export interface ScoreExportAvailability {
  available: boolean;
  mode: ScoreExportMode;
  reason: ScoreExportAvailabilityReason | null;
}

export interface ScoreExportAvailabilityInput {
  /** Full Score preference; `mode` can be used by non-store callers. */
  fullScoreEnabled?: boolean;
  mode?: ScoreExportMode;
  /** Active clip kind, or a minimal active clip object for store adapters. */
  activeClipKind?: string | null;
  activeClip?: { kind?: string } | null;
  /** True when the project contains at least one MIDI track. */
  hasMidiTrack?: boolean;
  midiTrackCount?: number;
  /** Optional clip-window guard used by actions after project initialization. */
  hasScoreWindow?: boolean;
}

function isMidiClip(kind: string | undefined | null): boolean {
  // EditorClip.kind is optional and clipKind() treats an absent kind as MIDI.
  return kind === undefined || kind === 'midi';
}

function normalizedInput(
  inputOrClip: ScoreExportAvailabilityInput | { kind?: string } | null | undefined,
  fullScoreEnabled?: boolean,
  tracks?: ReadonlyArray<{ kind?: string }>,
): ScoreExportAvailabilityInput {
  if (inputOrClip === null || inputOrClip === undefined || 'kind' in inputOrClip) {
    return {
      activeClip: inputOrClip,
      fullScoreEnabled,
      hasMidiTrack: tracks?.some((track) => track.kind === 'midi'),
    };
  }
  return inputOrClip as ScoreExportAvailabilityInput;
}

/**
 * Resolves whether the current MusicXML action can produce a score, together
 * with the single reason a caller should use when it cannot.
 *
 * The positional overload keeps this helper convenient for small menu tests;
 * the object form is the canonical store-independent contract.
 */
export function scoreExportAvailability(
  input: ScoreExportAvailabilityInput,
): ScoreExportAvailability;
export function scoreExportAvailability(
  activeClip: { kind?: string } | null | undefined,
  fullScoreEnabled: boolean,
  tracks: ReadonlyArray<{ kind?: string }>,
): ScoreExportAvailability;
export function scoreExportAvailability(
  inputOrClip: ScoreExportAvailabilityInput | { kind?: string } | null | undefined,
  fullScoreEnabled?: boolean,
  tracks?: ReadonlyArray<{ kind?: string }>,
): ScoreExportAvailability {
  const input = normalizedInput(inputOrClip, fullScoreEnabled, tracks);
  const mode: ScoreExportMode =
    input.mode ?? (input.fullScoreEnabled === true ? 'full-score' : 'part');
  const activeClipKind = input.activeClipKind ?? input.activeClip?.kind;
  const hasActiveClip =
    input.activeClipKind !== undefined
      ? input.activeClipKind !== null
      : input.activeClip !== undefined && input.activeClip !== null;
  const hasMidiTrack =
    input.hasMidiTrack === true || (input.midiTrackCount !== undefined && input.midiTrackCount > 0);
  const hasScoreWindow = input.hasScoreWindow ?? true;

  if (!hasScoreWindow) {
    return { available: false, mode, reason: 'score-window-required' };
  }
  if (mode === 'full-score') {
    return hasMidiTrack
      ? { available: true, mode, reason: null }
      : { available: false, mode, reason: 'midi-track-required' };
  }
  return isMidiClip(activeClipKind)
    ? hasActiveClip
      ? { available: true, mode, reason: null }
      : { available: false, mode, reason: 'active-midi-clip-required' }
    : { available: false, mode, reason: 'active-midi-clip-required' };
}

/** Descriptive aliases for callers that name the format rather than the UI. */
export const musicXmlExportAvailability = scoreExportAvailability;
export const getMusicXmlExportAvailability = scoreExportAvailability;
export const getScoreExportAvailability = scoreExportAvailability;
