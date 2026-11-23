/**
 * The TrueType font the PDF path embeds when a document carries text the PDF
 * core fonts cannot represent. The font file is a lazily fetched asset, kept out
 * of the precache, so an all-Latin export never downloads it.
 */

/** A TrueType font ready for jsPDF, with the code points its cmap maps. */
export interface PdfTextFont {
  /** Family name the font is registered under in jsPDF and referenced by in SVG. */
  readonly name: string;
  /** VFS file name jsPDF stores the font under. */
  readonly fileName: string;
  /** The font file as a binary string, the form jsPDF's VFS accepts. */
  readonly binary: string;
  /** True when the font maps the code point to a glyph. */
  covers(codePoint: number): boolean;
}

const PDF_TEXT_FONT_NAME = 'NotoSansJP';

/** Fetches the embedded text font and reads its character coverage. */
export async function loadPdfTextFont(): Promise<PdfTextFont> {
  const { default: url } = await import(
    '@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf?url'
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF text font failed to load (${response.status})`);
  return pdfTextFontFromBytes(new Uint8Array(await response.arrayBuffer()));
}

/** Builds the font record from TrueType bytes. */
export function pdfTextFontFromBytes(bytes: Uint8Array): PdfTextFont {
  const coverage = trueTypeCoverage(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return {
    name: PDF_TEXT_FONT_NAME,
    fileName: `${PDF_TEXT_FONT_NAME}-Regular.ttf`,
    binary,
    covers: (codePoint) => coverage.has(codePoint),
  };
}

/**
 * Code points a TrueType font's Unicode cmap maps to a non-zero glyph, read
 * from a format 12 subtable when present and format 4 otherwise.
 */
export function trueTypeCoverage(bytes: Uint8Array): Set<number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cmap = tableOffset(view, 'cmap');
  const subtableCount = view.getUint16(cmap + 2);
  let format4 = -1;
  let format12 = -1;
  for (let index = 0; index < subtableCount; index++) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    else if (format === 4) format4 = offset;
  }
  const covered = new Set<number>();
  if (format12 >= 0) {
    const groups = view.getUint32(format12 + 12);
    for (let group = 0; group < groups; group++) {
      const at = format12 + 16 + group * 12;
      const start = view.getUint32(at);
      const end = view.getUint32(at + 4);
      const glyph = view.getUint32(at + 8);
      for (let codePoint = start; codePoint <= end; codePoint++) {
        if (glyph + (codePoint - start) !== 0) covered.add(codePoint);
      }
    }
    return covered;
  }
  if (format4 < 0) throw new Error('TrueType font has no Unicode cmap');
  const segments = view.getUint16(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment++) {
    const end = view.getUint16(ends + segment * 2);
    const start = view.getUint16(starts + segment * 2);
    const delta = view.getInt16(deltas + segment * 2);
    const rangeAt = rangeOffsets + segment * 2;
    const rangeOffset = view.getUint16(rangeAt);
    for (let codePoint = start; codePoint <= end && codePoint !== 0xffff; codePoint++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (codePoint + delta) & 0xffff;
      } else {
        const glyphAt = rangeAt + rangeOffset + (codePoint - start) * 2;
        const raw = view.getUint16(glyphAt);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) covered.add(codePoint);
    }
  }
  return covered;
}

function tableOffset(view: DataView, tag: string): number {
  const tables = view.getUint16(4);
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    const name = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    if (name === tag) return view.getUint32(record + 8);
  }
  throw new Error(`TrueType font has no ${tag} table`);
}
