import { describe, expect, it } from 'vitest';
import { ensureFileExtension, projectFilename, sanitizeFilenameBase } from '@/lib/filename';

describe('projectFilename', () => {
  it('appends the extension to the project name', () => {
    expect(projectFilename('My Song', '.pdf')).toBe('My Song.pdf');
    expect(projectFilename('My Song', '.musicxml')).toBe('My Song.musicxml');
  });

  it('replaces filesystem-hostile characters with underscores', () => {
    expect(projectFilename('A/B: take *2*', '.pdf')).toBe('A_B_ take _2_.pdf');
    expect(projectFilename('a\\b<c>d|e"f?', '.x')).toBe('a_b_c_d_e_f_.x');
  });

  it('trims surrounding whitespace before adding the extension', () => {
    expect(projectFilename('  Song  ', '.pdf')).toBe('Song.pdf');
  });

  it('uses the fallback when the name sanitizes to nothing', () => {
    expect(projectFilename('', '.pdf')).toBe('project.pdf');
    expect(projectFilename('   ', '.musicxml', 'score')).toBe('score.musicxml');
  });

  it('does not duplicate an extension already present on the project name', () => {
    expect(projectFilename('Mix.MP3', '.mp3')).toBe('Mix.MP3');
    expect(ensureFileExtension('score.MUSICXML', '.musicxml')).toBe('score.MUSICXML');
  });

  it('shares the filename sanitation pipeline used by export option models', () => {
    expect(sanitizeFilenameBase('  a/b  ')).toBe('a_b');
    expect(sanitizeFilenameBase('  ', 'mixdown')).toBe('mixdown');
  });
});
