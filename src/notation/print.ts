/**
 * Printing and PDF export for rendered notation pages.
 *
 * Both entry points take pre-rendered SVG page strings (one per physical
 * page). Verovio embeds every glyph as SVG path data, so the pages are fully
 * self-contained: no font embedding or external resources are needed for
 * either the print pipeline or the generated PDF.
 */

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
}

/** Points per millimetre (72 pt per inch / 25.4 mm per inch). */
const PT_PER_MM = 72 / 25.4;

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
  const style = document.createElement('style');
  style.textContent = buildPrintPageCss(layout);

  const root = document.createElement('div');
  root.className = PRINT_ROOT_CLASS;
  // Hidden on screen; the print stylesheet overrides this with !important.
  root.style.display = 'none';
  for (const svg of svgPages) {
    const page = document.createElement('div');
    page.className = PRINT_PAGE_CLASS;
    page.append(document.importNode(parseSvgPage(svg), true));
    root.append(page);
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
  };
  try {
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    cleanupTimer = setTimeout(cleanup, PRINT_CLEANUP_FALLBACK_MS);
  } finally {
    if (cleanupTimer === null) cleanup();
  }
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
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const format: [number, number] = [layout.pageWidthMm, layout.pageHeightMm];
  const orientation = layout.pageWidthMm > layout.pageHeightMm ? 'landscape' : 'portrait';
  const doc = new jsPDF({ unit: 'mm', format, orientation });
  doc.setProperties?.({
    title: metadata.title?.trim() || 'score',
    author: metadata.author?.trim() || 'sonare studio',
    subject: metadata.subject?.trim() || 'Engraved score',
    creator: 'sonare studio',
  });
  for (let i = 0; i < svgPages.length; i++) {
    if (i > 0) doc.addPage(format, orientation);
    await doc.svg(parseSvgPage(svgPages[i]), {
      x: 0,
      y: 0,
      width: layout.pageWidthMm,
      height: layout.pageHeightMm,
    });
  }
  return doc.output('blob');
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
