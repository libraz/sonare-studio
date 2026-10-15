import { describe, expect, it } from 'vitest';
import { describeError } from '@/lib/errors';
import { PayloadMemoryLimitError, type PayloadMemoryOperation } from '@/lib/payload-memory';
import { MESSAGES } from '@/ui/i18n';

const MEBIBYTE = 1024 * 1024;
const OPERATIONS: PayloadMemoryOperation[] = [
  'audio-export',
  'audio-encoding',
  'live-schedule',
  'transcription',
  'score-export',
];

describe('describeError', () => {
  it('has english and japanese memory-limit copy for every operation', () => {
    for (const locale of ['en', 'ja'] as const) {
      const copy = MESSAGES[locale].notices.errors;
      expect(Object.keys(copy.memoryLimit).sort()).toEqual([...OPERATIONS].sort());
      for (const operation of OPERATIONS) {
        expect(copy.memoryLimit[operation]).toContain('{required}');
        expect(copy.memoryLimit[operation]).toContain('{budget}');
      }
    }
  });

  it('localizes payload memory limits with MiB figures per catalog', () => {
    const err = new PayloadMemoryLimitError('live-schedule', 300 * MEBIBYTE + 1, 256 * MEBIBYTE);
    const en = describeError(err, MESSAGES.en.notices.errors);
    const ja = describeError(err, MESSAGES.ja.notices.errors);

    expect(en).toBe(
      'Playback needs about 301 MiB of working memory, exceeding the 256 MiB browser budget. Shorten or remove some audio clips so playback fits in memory.',
    );
    expect(ja).toContain('301 MiB');
    expect(ja).toContain('256 MiB');
    expect(ja).toMatch(/[ぁ-ん]/);
    expect(ja).not.toContain('{');
  });

  it('describes a numeric engine code in each catalog', () => {
    expect(describeError(42, MESSAGES.en.notices.errors)).toBe(
      'The audio engine library rejected the operation (code 42).',
    );
    const ja = describeError(42, MESSAGES.ja.notices.errors);
    expect(ja).toContain('42');
    expect(ja).toMatch(/[ぁ-ん]/);
  });

  it('passes other errors and values through', () => {
    const copy = MESSAGES.ja.notices.errors;
    expect(describeError(new Error('already localized'), copy)).toBe('already localized');
    expect(describeError('plain', copy)).toBe('plain');
  });
});
