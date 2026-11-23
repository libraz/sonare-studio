import { describe, expect, it } from 'vitest';
import {
  createMediaCompletenessReport,
  formatMediaCompletenessReport,
} from '@/project/media-completeness';
import { MESSAGES } from '@/ui/i18n';

const report = createMediaCompletenessReport([
  {
    kind: 'audio-asset',
    mediaId: 'clip-audio',
    role: 'clip',
    reason: 'unreadable',
    projectName: 'Demo',
    trackId: 1,
    clipId: 2,
  },
  { kind: 'soundfont', mediaId: 'gm', role: 'library', reason: 'missing' },
]);

describe('media completeness report by language', () => {
  it('formats the report with Japanese wording', () => {
    expect(
      formatMediaCompletenessReport(report, MESSAGES.ja.shell.project.mediaCompleteness.report),
    ).toBe(
      [
        'オーディオアセット「clip-audio」（プロジェクト「Demo」、トラック 1、クリップ 2、クリップ）: 読み込めません',
        'SoundFont「gm」（ライブラリ）: 見つかりません',
      ].join('\n'),
    );
  });

  it('formats the report with English wording', () => {
    expect(
      formatMediaCompletenessReport(report, MESSAGES.en.shell.project.mediaCompleteness.report),
    ).toBe(
      [
        'audio-asset “clip-audio” (project “Demo”, track 1, clip 2, clip): unreadable',
        'soundfont “gm” (library): missing',
      ].join('\n'),
    );
  });
});
