import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MusicXmlImportError } from '@/notation/musicxml-import';
import { extractMusicXmlFromMxl } from '@/notation/musicxml-mxl';
import { preflightAndUnzip } from '@/persistence/archive-preflight';

describe('preflighted archive entries', () => {
  it('resolve only names the archive holds', () => {
    const { entries } = preflightAndUnzip(zipSync({ 'a.txt': strToU8('a') }));
    expect(entries.constructor).toBeUndefined();
    expect(entries.toString).toBeUndefined();
    expect(Object.keys(entries)).toEqual(['a.txt']);
  });

  it('let an MXL container naming a prototype key fail as an import error', () => {
    const archive = zipSync({
      'META-INF/container.xml': strToU8(
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="constructor"/></rootfiles></container>',
      ),
    });
    expect(() => extractMusicXmlFromMxl(archive)).toThrow(MusicXmlImportError);
  });
});
