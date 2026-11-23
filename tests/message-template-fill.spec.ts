import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AudioExportBlocker } from '@/export/audio-preflight';
import { type ExportIssueStrings, formatPreflightBlocker } from '@/export/export-issue-format';
import { formatMessage } from '@/ui/i18n/format';
import { readSource } from './helpers/source-text';

const STRINGS = {
  blocker: {
    audioClipNoMedia: 'Audio clip "{clip}" on "{track}" has no media reference',
    mediaMissing: '{labels} references missing or unreadable media "{id}": {reason}',
    soundFontMissing: 'SoundFont "{id}" is missing or unreadable: {reason}',
  },
  label: { frozenTrack: 'frozen track "{name}"', audioClip: 'audio clip "{name}"' },
} as unknown as ExportIssueStrings;

describe('message templates take user text literally', () => {
  it('formatMessage fills every placeholder in one pass, without replacement patterns', () => {
    expect(formatMessage('{a} and {b}', { a: '$& {b}', b: "$'" })).toBe("$& {b} and $'");
  });

  it('keeps $ patterns in a clip name', () => {
    const blocker: AudioExportBlocker = {
      kind: 'audio-clip-no-media',
      clip: 'Riff $&',
      track: 'Keys',
    };
    expect(formatPreflightBlocker(blocker, STRINGS)).toBe(
      'Audio clip "Riff $&" on "Keys" has no media reference',
    );
  });

  it('does not fill a placeholder that appears inside an earlier value', () => {
    const blocker: AudioExportBlocker = {
      kind: 'audio-clip-no-media',
      clip: '{track}',
      track: 'Keys',
    };
    expect(formatPreflightBlocker(blocker, STRINGS)).toBe(
      'Audio clip "{track}" on "Keys" has no media reference',
    );
  });

  it('keeps $ patterns in an asset label name', () => {
    const blocker: AudioExportBlocker = {
      kind: 'media-missing',
      labels: [{ kind: 'frozen-track', name: "Pad $'" }],
      assetId: 'a1',
      reason: 'gone',
    };
    expect(formatPreflightBlocker(blocker, STRINGS)).toBe(
      'frozen track "Pad $\'" references missing or unreadable media "a1": gone',
    );
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(join(import.meta.dirname, '..', dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(`${dir}/${e.name}`)
      : e.name.endsWith('.ts') || e.name.endsWith('.vue')
        ? [`${dir}/${e.name}`]
        : [],
  );
}

describe('message template fill guard', () => {
  it('fills {placeholder} templates only through formatMessage', () => {
    const offenders = sourceFiles('src').filter((f) =>
      /\.replace\(\s*['"`]\{\w+\}['"`]/.test(readSource(f)),
    );
    expect(offenders).toEqual([]);
  });
});
