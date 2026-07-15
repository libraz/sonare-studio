/**
 * Printing and PDF export for rendered notation pages.
 *
 * Both entry points take pre-rendered SVG page strings (one per physical
 * page). Verovio embeds every glyph as SVG path data, so the pages are fully
 * self-contained: no font embedding or external resources are needed for
 * either the print pipeline or the generated PDF.
 */

import { DEFAULT_SCORE_EXPORT_MEMORY_BUDGET_BYTES } from '@/export/memory-budget';
import { PayloadMemoryMeter, type PayloadMemorySample, utf8ByteLength } from '@/lib/payload-memory';

/** Physical page size in millimetres. */
export interface PageLayout {
  pageWidthMm: number;
  pageHeightMm: number;
}

/** Optional PDF document metadata. */
export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  /** Optional title drawn at the top of every exported PDF page. */
  headerTitle?: string;
  /** Whether to draw "Page X / N" at the bottom of each PDF page. Defaults to true. */
  pageNumbers?: boolean;
  /** Cancels lazy PDF conversion between page imports/renders. */
  signal?: AbortSignal;
  /** Source-equivalent retained page budget for the PDF consumer. */
  memoryBudgetBytes?: number;
  /** Receives deterministic payload and optional browser-heap samples. */
  onMemorySample?: (sample: PayloadMemorySample) => void;
}

/** Points per millimetre (72 pt per inch / 25.4 mm per inch). */
const PT_PER_MM = 72 / 25.4;

/** Conservative margin used for PDF-only headers and footers. */
const PDF_OVERLAY_MARGIN_MM = 7;
export const MAX_SCORE_PAGE_SVG_BYTES = 32 * 1024 * 1024;

export interface PdfPageWriter {
  /** Consumes one rendered SVG page; the caller may release the string after await. */
  addPage(svg: string, page: number): Promise<void>;
  /** Atomically materializes the finished PDF after every page was consumed. */
  close(): Blob;
}

export interface PrintPageWriter {
  /** Parses and consumes one rendered SVG page in order. */
  addPage(svg: string, page: number): void;
  /** Opens the browser print dialog after every declared page was consumed. */
  print(): void;
}

/**
 * Converts millimetres to PostScript points.
 *
 * @param mm Length in millimetres.
 * @returns Length in points (1 pt = 1/72 inch).
 */
export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

/**
 * Converts PostScript points to millimetres.
 *
 * @param pt Length in points (1 pt = 1/72 inch).
 * @returns Length in millimetres.
 */
export function ptToMm(pt: number): number {
  return pt / PT_PER_MM;
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
  if (utf8ByteLength(svg) > MAX_SCORE_PAGE_SVG_BYTES) {
    throw new Error(`SVG page exceeds the ${MAX_SCORE_PAGE_SVG_BYTES}-byte limit`);
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

/**
 * Prints rendered notation pages via the browser print dialog.
 *
 * A hidden container (one wrapper div per SVG page) and a print stylesheet
 * are injected into the document; `@media print` rules hide the rest of the
 * app and show the container one page per sheet. The DOM is restored after
 * `window.print()` returns.
 *
 * @param svgPages Self-contained SVG markup, one string per page.
 * @param layout Physical page size matching the rendered pages.
 */
export function printScore(svgPages: string[], layout: PageLayout): void {
  const writer = createPrintPageWriter(svgPages.length, layout);
  for (let index = 0; index < svgPages.length; index++) {
    writer.addPage(svgPages[index], index + 1);
  }
  writer.print();
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
  if (pageCount > 500) throw new RangeError('Score print page count exceeds limit 500');
  const style = document.createElement('style');
  style.textContent = buildPrintPageCss(layout);

  const root = document.createElement('div');
  root.className = PRINT_ROOT_CLASS;
  // Hidden on screen; the print stylesheet overrides this with !important.
  root.style.display = 'none';
  const meter = new PayloadMemoryMeter({
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

/**
 * Renders notation pages to a PDF document.
 *
 * jspdf and svg2pdf.js are imported lazily so the PDF stack stays out of the
 * main bundle; importing svg2pdf.js registers `jsPDF.prototype.svg`. Each SVG
 * page is vector-rendered to fill one PDF page of the given size.
 *
 * @param svgPages Self-contained SVG markup, one string per page.
 * @param layout Physical page size in millimetres.
 * @returns The finished PDF as a Blob (hand to {@link downloadBlob}).
 * @throws TypeError when svgPages is empty.
 */
export async function exportPdf(
  svgPages: string[],
  layout: PageLayout,
  metadata: PdfMetadata = {},
): Promise<Blob> {
  if (svgPages.length === 0) throw new TypeError('exportPdf requires at least one SVG page');
  const writer = await createPdfPageWriter(svgPages.length, layout, metadata);
  for (let i = 0; i < svgPages.length; i++) {
    await writer.addPage(svgPages[i], i + 1);
  }
  return writer.close();
}

/** Creates a PDF sink that renders and releases one SVG string at a time. */
export async function createPdfPageWriter(
  pageCount: number,
  layout: PageLayout,
  metadata: PdfMetadata = {},
): Promise<PdfPageWriter> {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new TypeError('PDF page writer requires at least one page');
  }
  if (pageCount > 500) throw new RangeError('Score PDF page count exceeds limit 500');
  metadata.signal?.throwIfAborted();
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  metadata.signal?.throwIfAborted();
  const format: [number, number] = [layout.pageWidthMm, layout.pageHeightMm];
  const orientation = layout.pageWidthMm > layout.pageHeightMm ? 'landscape' : 'portrait';
  const doc = new jsPDF({ unit: 'mm', format, orientation });
  doc.setProperties?.({
    title: metadata.title?.trim() || 'score',
    author: metadata.author?.trim() || 'sonare studio',
    subject: metadata.subject?.trim() || 'Engraved score',
    creator: 'sonare studio',
  });
  const headerTitle = metadata.headerTitle?.trim() || metadata.title?.trim() || '';
  const pageNumbers = metadata.pageNumbers !== false;
  const meter = new PayloadMemoryMeter({
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
        await doc.svg(parseSvgPage(svg), {
          x: 0,
          y: 0,
          width: layout.pageWidthMm,
          height: layout.pageHeightMm,
        });
        metadata.signal?.throwIfAborted();
        appendPdfPageOverlay(doc, layout, page, pageCount, headerTitle, pageNumbers);
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
  };
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
  page: number,
  pageCount: number,
  headerTitle: string,
  pageNumbers: boolean,
): void {
  if (headerTitle === '' && !pageNumbers) return;
  doc.setFontSize?.(8);
  doc.setTextColor?.(80);
  if (headerTitle !== '') {
    doc.text?.(headerTitle, PDF_OVERLAY_MARGIN_MM, PDF_OVERLAY_MARGIN_MM, { align: 'left' });
  }
  if (pageNumbers) {
    doc.text?.(
      `Page ${page} / ${pageCount}`,
      layout.pageWidthMm / 2,
      layout.pageHeightMm - PDF_OVERLAY_MARGIN_MM,
      { align: 'center' },
    );
  }
}

/**
 * Triggers a browser download of a Blob via a transient anchor element.
 *
 * @param blob Data to download.
 * @param filename Suggested file name (including extension).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
