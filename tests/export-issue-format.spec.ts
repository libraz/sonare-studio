import { describe, expect, it } from 'vitest';
import type { AudioExportBlocker, AudioExportWarning } from '@/export/audio-preflight';
import {
  type ExportIssueStrings,
  formatExportLimitation,
  formatPreflightBlocker,
  formatPreflightWarning,
} from '@/export/export-issue-format';
import type { ExportLimitation } from '@/export/mixdown';

const STRINGS: ExportIssueStrings = {
  blocker: {
    audioClipNoMedia: 'Audio clip "{clip}" on "{track}" has no media reference',
    mediaMissing: '{labels} references missing or unreadable media "{id}": {reason}',
  },
  warning: {
    externalMidiSilent: 'External MIDI track "{track}" is silent in audio export',
    releaseTailShort:
      'Release tail is {current}s, but active reverb/delay settings suggest at least {suggested}s',
    soloActive: 'Solo is active for: {tracks}. The export omits other tracks.',
    returnSoloActive: 'A return bus is soloed: {buses}. The export contains only that return.',
    pflModeActive: 'PFL solo mode is active.',
    silentMixdown: 'The export will be silent.',
  },
  label: {
    frozenTrack: 'frozen track "{name}"',
    audioClip: 'audio clip "{name}"',
  },
  limitation: {
    masteringAutomationAtStart: 'Mastering automation was evaluated at render start',
    masteringLoudnessTargetLimited: 'Preset stopped short: {lufs} LUFS',
  },
};

describe('export issue formatter', () => {
  it('formats preflight blockers with their parameters', () => {
    const noMedia: AudioExportBlocker = {
      kind: 'audio-clip-no-media',
      clip: 'Loop',
      track: 'Keys',
    };
    expect(formatPreflightBlocker(noMedia, STRINGS)).toBe(
      'Audio clip "Loop" on "Keys" has no media reference',
    );

    const missing: AudioExportBlocker = {
      kind: 'media-missing',
      labels: [
        { kind: 'frozen-track', name: 'Bass' },
        { kind: 'audio-clip', name: 'Take 2' },
      ],
      assetId: 'gone',
      reason: 'not found',
    };
    expect(formatPreflightBlocker(missing, STRINGS)).toBe(
      'frozen track "Bass", audio clip "Take 2" references missing or unreadable media "gone": not found',
    );
  });

  it('formats preflight warnings with their parameters', () => {
    const midi: AudioExportWarning = { kind: 'external-midi-silent', track: 'Hardware' };
    expect(formatPreflightWarning(midi, STRINGS)).toBe(
      'External MIDI track "Hardware" is silent in audio export',
    );

    const tail: AudioExportWarning = {
      kind: 'release-tail-short',
      currentSeconds: 2,
      suggestedSeconds: 8,
    };
    expect(formatPreflightWarning(tail, STRINGS)).toBe(
      'Release tail is 2s, but active reverb/delay settings suggest at least 8s',
    );

    expect(
      formatPreflightWarning({ kind: 'solo-active', tracks: ['Kick', 'Snare'] }, STRINGS),
    ).toBe('Solo is active for: Kick, Snare. The export omits other tracks.');

    expect(formatPreflightWarning({ kind: 'return-solo-active', buses: ['Reverb'] }, STRINGS)).toBe(
      'A return bus is soloed: Reverb. The export contains only that return.',
    );
  });

  it('formats render limitations', () => {
    const mastering: ExportLimitation = { kind: 'mastering-automation-at-render-start' };
    expect(formatExportLimitation(mastering, STRINGS)).toBe(
      'Mastering automation was evaluated at render start',
    );
    expect(
      formatExportLimitation(
        { kind: 'mastering-loudness-target-limited', outputLufs: -10.26 },
        STRINGS,
      ),
    ).toBe('Preset stopped short: -10.3 LUFS');
  });
});
