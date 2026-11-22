import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MusicXmlImportError } from '@/notation/musicxml-import';
import { extractMusicXmlFromMxl, packMusicXmlToMxl } from '@/notation/musicxml-mxl';

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

  it('accepts a highly-compressible score within the shared archive safety limit', () => {
    const score = `<score-partwise version="4.0"><part-list/>${' '.repeat(20_000)}</score-partwise>`;
    const archive = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'score.xml': strToU8(score),
    });

    expect(extractMusicXmlFromMxl(archive)).toBe(score);
  });

  it('applies the MusicXML element limit rather than the generic XML one', () => {
    const score = `<score-partwise version="4.0"><part-list/>${'<a/>'.repeat(300_000)}</score-partwise>`;
    const archive = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'score.xml': strToU8(score),
    });

    expect(extractMusicXmlFromMxl(archive)).toBe(score);
  });

  it('reports a too-deep score as a MusicXmlImportError', () => {
    const score = `<score-partwise version="4.0">${'<a>'.repeat(200)}${'</a>'.repeat(200)}</score-partwise>`;
    const archive = zipSync({
      'META-INF/container.xml': strToU8(CONTAINER),
      'score.xml': strToU8(score),
    });

    expect(() => extractMusicXmlFromMxl(archive)).toThrow(MusicXmlImportError);
  });
});

describe('packMusicXmlToMxl', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list/>${'<a/>'.repeat(200)}</score-partwise>`;

  it('round-trips through the reader to the identical XML', () => {
    expect(extractMusicXmlFromMxl(packMusicXmlToMxl(xml))).toBe(xml);
  });

  it('leads with a stored mimetype entry holding the exact media type', () => {
    const bytes = packMusicXmlToMxl(xml);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // compression method: stored
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(strFromU8(bytes.subarray(30, 30 + nameLength))).toBe('mimetype');
    const dataStart = 30 + nameLength + extraLength;
    expect(strFromU8(bytes.subarray(dataStart, dataStart + view.getUint32(22, true)))).toBe(
      'application/vnd.recordare.musicxml',
    );
  });

  it('names an archived score in the container rootfile', () => {
    const entries = unzipSync(packMusicXmlToMxl(xml));
    const container = new DOMParser().parseFromString(
      strFromU8(entries['META-INF/container.xml']),
      'application/xml',
    );
    const rootfile = container.querySelector('rootfile');
    expect(rootfile?.getAttribute('media-type')).toBe('application/vnd.recordare.musicxml+xml');
    expect(entries[rootfile?.getAttribute('full-path') ?? '']).toBeDefined();
  });
});
