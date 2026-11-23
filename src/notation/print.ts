/**
 * Printing and PDF export for rendered notation pages.
 *
 * Both page writers consume pre-rendered SVG page strings (one per physical
 * page). Verovio draws music symbols as SVG paths but sets words, names and
 * numbers as SVG text, and writes the SMuFL glyphs inside text (metronome
 * notes, chord-symbol accidentals) in its Leipzig text font. Print hands the
 * pages to the browser, which renders all of it. The PDF draws the SMuFL text
 * glyphs as outline paths, sets the remaining text in the PDF core fonts, and
 * embeds one TrueType font for every text item of a document when any text
 * falls outside what the core fonts can represent.
 */

import { DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import { PayloadMemoryMeter, type PayloadMemorySample, utf8ByteLength } from '@/lib/payload-memory';
import { MAX_XML_DOCUMENT_BYTES } from '@/lib/xml-preflight';
import { loadPdfTextFont, type PdfTextFont } from '@/notation/pdf-font';
import { drawSmuflTextAsPaths, SMUFL_TEXT_FAMILY, smuflTextRuns } from '@/notation/pdf-smufl-text';
import { formatMessage } from '@/ui/i18n/format';

/** Physical page size in millimetres. */
export interface PageLayout {
  pageWidthMm: number;
  pageHeightMm: number;
}

/** PDF document metadata; the caller supplies the reader-facing title and subject. */
export interface PdfMetadata {
  title: string;
  author?: string;
  subject: string;
  /** Optional title drawn at the top of every exported PDF page. */
  headerTitle?: string;
  /** Page label drawn at the bottom of each PDF page, with `{page}` and `{count}`; omitted draws none. */
  pageLabel?: string;
  /** The text plan {@link planPdfText} made for this document. */
  text: PdfTextPlan;
  /** Cancels lazy PDF conversion between page imports/renders. */
  signal?: AbortSignal;
  /** Source-equivalent retained page budget for the PDF consumer. */
  memoryBudgetBytes?: number;
  /** Receives deterministic payload and optional browser-heap samples. */
  onMemorySample?: (sample: PayloadMemorySample) => void;
}

/** Conservative margin used for PDF-only headers and footers. */
const PDF_OVERLAY_MARGIN_MM = 7;

/** Most pages a score print or PDF export accepts. */
const MAX_SCORE_PAGES = 500;

/**
 * Unicode code points that jsPDF maps to glyphs in its built-in WinAnsi core
 * fonts in addition to the single-byte WinAnsi ranges. Keep this local and
 * deterministic: the overlay deliberately does not load or embed a Unicode
 * font just for optional metadata text.
 */
const CORE_FONT_WIN_ANSI_UNICODE = new Set([
  0x0192, // Latin small letter f with hook
  0x2013, // en dash
  0x2014, // em dash
  0x2018, // left single quotation mark
  0x2019, // right single quotation mark
  0x201a, // single low-9 quotation mark
  0x201c, // left double quotation mark
  0x201d, // right double quotation mark
  0x201e, // double low-9 quotation mark
  0x2020, // dagger
  0x2021, // double dagger
  0x2022, // bullet
  0x2026, // horizontal ellipsis
  0x2030, // per mille sign
  0x2039, // single left-pointing angle quotation mark
  0x203a, // single right-pointing angle quotation mark
  0x0152, // Latin capital ligature OE
  0x0153, // Latin small ligature oe
  0x0160, // Latin capital letter S with caron
  0x0161, // Latin small letter s with caron
  0x0178, // Latin capital letter Y with diaeresis
  0x017d, // Latin capital letter Z with caron
  0x017e, // Latin small letter z with caron
  0x02c6, // modifier letter circumflex accent
  0x02dc, // small tilde
  0x2122, // trade mark sign
  0x20ac, // euro sign
]);

/** WinAnsi bytes whose code points are not printable ASCII/Latin-1. */
const CORE_FONT_WIN_ANSI_BYTES = new Set([
  0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93,
  0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f,
]);

/** True when every character can be emitted by jsPDF's default core font. */
export function isCoreFontRepresentable(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xff) ||
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      CORE_FONT_WIN_ANSI_BYTES.has(codePoint) ||
      CORE_FONT_WIN_ANSI_UNICODE.has(codePoint)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * A document-information string as jsPDF writes it: ASCII stays as is, anything
 * else becomes the UTF-16BE text string (byte-order mark first) the PDF format
 * reads as Unicode.
 */
function pdfTextString(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;
  let bytes = '\xfe\xff';
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    bytes += String.fromCharCode(unit >> 8, unit & 0xff);
  }
  return bytes;
}

/** Which font a PDF sets its text in, decided before any page renders. */
export interface PdfTextPlan {
  /** The embedded font every text item uses, or null when the core fonts suffice. */
  readonly font: PdfTextFont | null;
  /** Characters of the document text the chosen font cannot draw, in first-seen order. */
  readonly undrawable: readonly string[];
}

/**
 * Decides the PDF's text font from every text the document will carry: the
 * engraved score's text, the title and the page label. The embedded font is
 * loaded only when some of it is not core-font representable.
 *
 * @param texts The document's text, e.g. the MusicXML text content and the metadata strings.
 * @param loadFont Loads the embedded font; the lazily fetched asset by default.
 */
export async function planPdfText(
  texts: readonly string[],
  loadFont: () => Promise<PdfTextFont> = loadPdfTextFont,
): Promise<PdfTextPlan> {
  const joined = texts.join('\n');
  if (isCoreFontRepresentable(joined)) return { font: null, undrawable: [] };
  const font = await loadFont();
  return { font, undrawable: undrawableCharacters(joined, font) };
}

/** Characters of `text` the plan's font cannot draw, in first-seen order. */
function undrawableCharacters(text: string, font: PdfTextFont | null): string[] {
  const seen = new Set<string>();
  for (const character of text) {
    if (character.trim() === '' || seen.has(character)) continue;
    const drawable = font
      ? font.covers(character.codePointAt(0) ?? 0)
      : isCoreFontRepresentable(character);
    if (!drawable) seen.add(character);
  }
  return [...seen];
}

export interface PdfPageWriter {
  /** Consumes one rendered SVG page; the caller may release the string after await. */
  addPage(svg: string, page: number): Promise<void>;
  /** Atomically materializes the finished PDF after every page was consumed. */
  close(): Blob;
  /**
   * Characters the pages carried that the PDF could not draw and the text plan
   * had not already reported: text outside the plan's font, and SMuFL glyphs
   * with no outline.
   */
  undrawable(): string[];
}

export interface PrintPageWriter {
  /** Parses and consumes one rendered SVG page in order. */
  addPage(svg: string, page: number): void;
  /** Opens the browser print dialog after every declared page was consumed. */
  print(): void;
}

/** Class name of the transient container injected for printing. */
export const PRINT_ROOT_CLASS = 'sonare-print-root';

/** Class name of each page wrapper inside the print container. */
export const PRINT_PAGE_CLASS = 'sonare-print-page';

/** Fallback cleanup delay when a browser does not fire `afterprint`. */
export const PRINT_CLEANUP_FALLBACK_MS = 60_000;

/**
 * Builds the print stylesheet for a page layout: an `@page` rule fixing the
 * physical paper size and `@media print` rules that show only the injected
 * print container, one page per sheet.
 *
 * @param layout Physical page size.
 * @returns CSS text for a transient `<style>` element.
 */
export function buildPrintPageCss(layout: PageLayout): string {
  const { pageWidthMm, pageHeightMm } = layout;
  return [
    `@page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }`,
    '@media print {',
    `  body > *:not(.${PRINT_ROOT_CLASS}) { display: none !important; }`,
    `  .${PRINT_ROOT_CLASS} { display: block !important; }`,
    `  .${PRINT_PAGE_CLASS} {`,
    '    box-sizing: border-box;',
    `    width: ${pageWidthMm}mm;`,
    `    height: ${pageHeightMm}mm;`,
    '    overflow: hidden;',
    '    break-after: page;',
    '    page-break-after: always;',
    '    print-color-adjust: exact;',
    '    -webkit-print-color-adjust: exact;',
    '  }',
    `  .${PRINT_PAGE_CLASS} > svg { width: 100%; height: 100%; }`,
    '}',
  ].join('\n');
}

/**
 * Parses one SVG page string into a detached SVG element.
 *
 * SVG pages come from the in-process Verovio renderer (never user input);
 * parsing through DOMParser with an XML mime type keeps script execution out
 * of the document regardless.
 *
 * @param svg SVG markup of one page.
 * @returns The parsed root element.
 * @throws Error when the markup is not well-formed SVG.
 */
function parseSvgPage(svg: string): Element {
  if (utf8ByteLength(svg) > MAX_XML_DOCUMENT_BYTES) {
    throw new Error(`SVG page exceeds the ${MAX_XML_DOCUMENT_BYTES}-byte limit`);
  }
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid SVG page markup');
  }
  if (parsed.documentElement.tagName.toLowerCase() !== 'svg') {
    throw new Error('Invalid SVG page markup');
  }
  return parsed.documentElement;
}

/** Creates a print sink that releases each SVG string after parsing it into detached DOM. */
export function createPrintPageWriter(
  pageCount: number,
  layout: PageLayout,
  memory: {
    budgetBytes?: number;
    onSample?: (sample: PayloadMemorySample) => void;
  } = {},
): PrintPageWriter {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new TypeError('Print page writer requires at least one page');
  }
  if (pageCount > MAX_SCORE_PAGES) {
    throw new RangeError(`Score print page count exceeds limit ${MAX_SCORE_PAGES}`);
  }
  const style = document.createElement('style');
  style.textContent = buildPrintPageCss(layout);

  const root = document.createElement('div');
  root.className = PRINT_ROOT_CLASS;
  // Hidden on screen; the print stylesheet overrides this with !important.
  root.style.display = 'none';
  const meter = new PayloadMemoryMeter({
    operation: 'score-export',
    label: 'Score print',
    budgetBytes: memory.budgetBytes ?? DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES,
    onSample: memory.onSample,
  });
  const releases: Array<() => void> = [];
  const releaseAll = () => {
    while (releases.length > 0) releases.pop()?.();
  };
  let consumed = 0;
  return {
    addPage(svg, page): void {
      if (page !== consumed + 1 || page > pageCount) {
        throw new RangeError(`Print pages must be consumed in order (received ${page})`);
      }
      const release = meter.retain(utf8ByteLength(svg), `page ${page}/${pageCount}`);
      try {
        const wrapper = document.createElement('div');
        wrapper.className = PRINT_PAGE_CLASS;
        wrapper.append(document.importNode(parseSvgPage(svg), true));
        root.append(wrapper);
        releases.push(release);
        consumed = page;
      } catch (error) {
        release();
        releaseAll();
        root.replaceChildren();
        throw error;
      }
    },
    print(): void {
      if (consumed !== pageCount) {
        throw new Error(`Print page writer opened after ${consumed} of ${pageCount} pages`);
      }
      document.head.append(style);
      document.body.append(root);
      let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (cleanupTimer !== null) {
          clearTimeout(cleanupTimer);
          cleanupTimer = null;
        }
        window.removeEventListener('afterprint', cleanup);
        root.remove();
        style.remove();
        root.replaceChildren();
        releaseAll();
      };
      try {
        window.addEventListener('afterprint', cleanup, { once: true });
        window.print();
        cleanupTimer = setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);
      } finally {
        if (cleanupTimer === null) cleanup();
      }
    },
  };
}

/** Creates a PDF sink that renders and releases one SVG string at a time. */
export async function createPdfPageWriter(
  pageCount: number,
  layout: PageLayout,
  metadata: PdfMetadata,
): Promise<PdfPageWriter> {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new TypeError('PDF page writer requires at least one page');
  }
  if (pageCount > MAX_SCORE_PAGES) {
    throw new RangeError(`Score PDF page count exceeds limit ${MAX_SCORE_PAGES}`);
  }
  metadata.signal?.throwIfAborted();
  const [{ jsPDF }, , { SMUFL_TEXT_GLYPHS }] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    import('@/notation/smufl-text-glyphs'),
  ]);
  metadata.signal?.throwIfAborted();
  const font = metadata.text.font;
  const format: [number, number] = [layout.pageWidthMm, layout.pageHeightMm];
  const orientation = layout.pageWidthMm > layout.pageHeightMm ? 'landscape' : 'portrait';
  const doc = new jsPDF({ unit: 'mm', format, orientation });
  doc.setProperties?.({
    title: pdfTextString(metadata.title.trim()),
    author: pdfTextString(metadata.author?.trim() || 'sonare studio'),
    subject: pdfTextString(metadata.subject.trim()),
    creator: 'sonare studio',
  });
  if (font) {
    doc.addFileToVFS(font.fileName, font.binary);
    doc.addFont(font.fileName, font.name, 'normal');
  }
  const headerTitle = metadata.headerTitle?.trim() || metadata.title.trim();
  const reported = new Set(metadata.text.undrawable);
  const undrawable = new Set<string>();
  const meter = new PayloadMemoryMeter({
    operation: 'score-export',
    label: 'Score PDF',
    budgetBytes: metadata.memoryBudgetBytes ?? DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES,
    onSample: metadata.onMemorySample,
  });
  const releases: Array<() => void> = [];
  const releaseAll = () => {
    while (releases.length > 0) releases.pop()?.();
  };
  let consumed = 0;
  return {
    async addPage(svg, page): Promise<void> {
      metadata.signal?.throwIfAborted();
      if (page !== consumed + 1 || page > pageCount) {
        throw new RangeError(`PDF pages must be consumed in order (received ${page})`);
      }
      const release = meter.retain(utf8ByteLength(svg), `page ${page}/${pageCount}`);
      try {
        if (page > 1) doc.addPage(format, orientation);
        const root = await preparePdfPage(parseSvgPage(svg), SMUFL_TEXT_GLYPHS, font);
        for (const character of root.undrawable) {
          if (!reported.has(character)) undrawable.add(character);
        }
        await doc.svg(root.element, {
          x: 0,
          y: 0,
          width: layout.pageWidthMm,
          height: layout.pageHeightMm,
        });
        metadata.signal?.throwIfAborted();
        if (font) doc.setFont(font.name, 'normal');
        const label =
          metadata.pageLabel === undefined
            ? ''
            : formatMessage(metadata.pageLabel, { page, count: pageCount });
        appendPdfPageOverlay(doc, layout, headerTitle, label);
        releases.push(release);
        consumed = page;
      } catch (error) {
        release();
        releaseAll();
        throw error;
      }
    },
    close(): Blob {
      metadata.signal?.throwIfAborted();
      if (consumed !== pageCount) {
        throw new Error(`PDF page writer closed after ${consumed} of ${pageCount} pages`);
      }
      const blob = doc.output('blob');
      releaseAll();
      return blob;
    },
    undrawable(): string[] {
      return [...undrawable];
    },
  };
}

/**
 * Readies one parsed page for svg2pdf: SMuFL text glyphs become outline paths,
 * and with an embedded font every text item is set in it. A page with SMuFL
 * text is laid out in a hidden host first so the paths take the rendered
 * positions.
 */
async function preparePdfPage(
  parsed: Element,
  outlines: ReadonlyMap<number, string>,
  font: PdfTextFont | null,
): Promise<{ element: Element; undrawable: string[] }> {
  const undrawn: string[] = [];
  let element = parsed;
  const runs = smuflTextRuns(parsed);
  if (runs.length > 0) {
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
    element = document.importNode(parsed, true);
    host.append(element);
    document.body.append(host);
    try {
      const sample = runs.map((run) => run.textContent ?? '').join('');
      await document.fonts.load(`1000px ${SMUFL_TEXT_FAMILY}`, sample);
      for (const codePoint of drawSmuflTextAsPaths(element, outlines)) {
        undrawn.push(String.fromCodePoint(codePoint));
      }
    } finally {
      host.remove();
    }
  }
  const text = [...element.querySelectorAll('text')].map((node) => node.textContent ?? '');
  undrawn.push(...undrawableCharacters(text.join('\n'), font));
  if (font) {
    for (const node of element.querySelectorAll('text, tspan')) {
      const style = (node as SVGElement).style;
      style.setProperty('font-family', font.name);
      style.setProperty('font-weight', 'normal');
      style.setProperty('font-style', 'normal');
    }
  }
  return { element, undrawable: undrawn };
}

function appendPdfPageOverlay(
  doc: {
    setFontSize?: (size: number) => unknown;
    setTextColor?: (gray: number) => unknown;
    text?: (
      text: string,
      x: number,
      y: number,
      options?: { align?: 'left' | 'center' | 'right' },
    ) => unknown;
  },
  layout: PageLayout,
  headerTitle: string,
  pageLabel: string,
): void {
  if (headerTitle === '' && pageLabel === '') return;
  doc.setFontSize?.(8);
  doc.setTextColor?.(80);
  if (headerTitle !== '') {
    doc.text?.(headerTitle, PDF_OVERLAY_MARGIN_MM, PDF_OVERLAY_MARGIN_MM, { align: 'left' });
  }
  if (pageLabel !== '') {
    doc.text?.(pageLabel, layout.pageWidthMm / 2, layout.pageHeightMm - PDF_OVERLAY_MARGIN_MM, {
      align: 'center',
    });
  }
}
