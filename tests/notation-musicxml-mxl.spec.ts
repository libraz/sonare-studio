import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MusicXmlImportError } from '@/notation/musicxml-import';
import { extractMusicXmlFromMxl } from '@/notation/musicxml-mxl';

const SCORE = '<score-partwise version="4.0"><part-list/></score-partwise>';
const CONTAINER =
  '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>';

describe('extractMusicXmlFromMxl', () => {
  it('extracts the root score selected by the standard MXL container', () => {
    const archive = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'score.xml': strToU8(SCORE),
    });
    expect(extractMusicXmlFromMxl(archive, 'piece.mxl')).toBe(SCORE);
  });

  it('rejects archives without a container-selected score', () => {
    const archive = zipSync({ 'META-INF/container.xml': strToU8(CONTAINER) });
    expect(() => extractMusicXmlFromMxl(archive)).toThrow(MusicXmlImportError);
  });

  it('rejects unsafe archive paths before selecting an XML payload', () => {
    const archive = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      '../score.xml': strToU8(SCORE),
    });
    expect(() => extractMusicXmlFromMxl(archive)).toThrow(MusicXmlImportError);
  });
});
