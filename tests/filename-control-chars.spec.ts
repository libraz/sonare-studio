import { describe, expect, it } from 'vitest';
import { projectFilename, sanitizeFilenameBase, UNSAFE_FILENAME_CHARS } from '@/lib/filename';
import { sanitizeProjectName } from '@/persistence/opfs';

describe('filename character policy', () => {
  it('replaces control characters in download filenames', () => {
    expect(projectFilename('Line one\nline two', '.pdf')).toBe('Line one_line two.pdf');
    expect(sanitizeFilenameBase('a\u0000b\tc')).toBe('a_b_c');
  });

  it('trims surrounding control whitespace instead of turning it into underscores', () => {
    expect(sanitizeFilenameBase('\nSong\n')).toBe('Song');
  });

  it('falls back when the base is only dots', () => {
    expect(sanitizeFilenameBase('..')).toBe('project');
    expect(sanitizeFilenameBase('.', 'score')).toBe('score');
    expect(projectFilename('..', '.pdf')).toBe('project.pdf');
  });

  it('keeps a dot inside a normal name', () => {
    expect(sanitizeFilenameBase('v1.2 mix')).toBe('v1.2 mix');
  });

  it('applies the same character policy as the stored project name', () => {
    const sample = 'a\u0001b/c:d*e?f"g<h>i|j\\k\nl';
    expect(sanitizeProjectName(sample)).toBe(sample.replace(UNSAFE_FILENAME_CHARS, '_'));
  });
});
