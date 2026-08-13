import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFileExtension, exportMusicXml } from '@/notation/io';
import {
  buildPrintPageCss,
  downloadBlob,
  exportPdf,
  mmToPt,
  PRINT_CLEANUP_FALLBACK_MS,
  PRINT_PAGE_CLASS,
  PRINT_ROOT_CLASS,
  printScore,
  ptToMm,
} from '@/notation/print';

/** Captures every jsPDF instance the mocked module creates. */
const pdfState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: unknown;
    addPageCalls: unknown[][];
    propertiesCalls: unknown[];
    svgCalls: Array<{ tag: string; options: unknown }>;
    fontSizeCalls: number[];
    textColorCalls: number[];
    textCalls: Array<{ text: string; x: number; y: number; options: unknown }>;
    outputCalls: string[];
  }>,
}));

vi.mock('jspdf', () => {
  class FakeJsPdf {
    record: (typeof pdfState.instances)[number];

    constructor(options: unknown) {
      this.record = {
        options,
        addPageCalls: [],
        propertiesCalls: [],
        svgCalls: [],
        fontSizeCalls: [],
        textColorCalls: [],
        textCalls: [],
        outputCalls: [],
      };
      pdfState.instances.push(this.record);
    }

    addPage(...args: unknown[]): this {
      this.record.addPageCalls.push(args);
      return this;
    }

    svg(element: Element, options: unknown): Promise<this> {
      this.record.svgCalls.push({ tag: element.tagName.toLowerCase(), options });
      return Promise.resolve(this);
    }

    setProperties(properties: unknown): this {
      this.record.propertiesCalls.push(properties);
      return this;
    }

    setFontSize(size: number): this {
      this.record.fontSizeCalls.push(size);
      return this;
    }

    setTextColor(gray: number): this {
      this.record.textColorCalls.push(gray);
      return this;
    }

    text(text: string, x: number, y: number, options?: unknown): this {
      this.record.textCalls.push({ text, x, y, options });
      return this;
    }

    output(type: string): Blob {
      this.record.outputCalls.push(type);
      return new Blob(['%PDF-fake'], { type: 'application/pdf' });
    }
  }
  return { jsPDF: FakeJsPdf };
});

// svg2pdf.js is imported for its jsPDF.prototype.svg registration side effect
// only; the fake jsPDF above already provides svg().
vi.mock('svg2pdf.js', () => ({}));

const A4 = { pageWidthMm: 210, pageHeightMm: 297 };
const SVG_PAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0h10"/></svg>';

describe('mm/pt conversion', () => {
  it('converts one inch worth of millimetres to 72 points', () => {
    expect(mmToPt(25.4)).toBeCloseTo(72, 10);
  });

  it('round-trips through ptToMm', () => {
    expect(ptToMm(mmToPt(210))).toBeCloseTo(210, 10);
    expect(ptToMm(72)).toBeCloseTo(25.4, 10);
  });
});

describe('buildPrintPageCss', () => {
  it('emits the @page size for the layout', () => {
    const css = buildPrintPageCss(A4);
    expect(css).toContain('@page { size: 210mm 297mm; margin: 0; }');
  });

  it('emits print-media isolation and per-page break rules', () => {
    const css = buildPrintPageCss(A4);
    expect(css).toContain('@media print');
    expect(css).toContain(`body > *:not(.${PRINT_ROOT_CLASS}) { display: none !important; }`);
    expect(css).toContain('break-after: page;');
    expect(css).toContain('width: 210mm;');
    expect(css).toContain('height: 297mm;');
    expect(css).toContain('print-color-adjust: exact;');
  });
});

describe('ensureFileExtension', () => {
  it('appends the extension when missing', () => {
    expect(ensureFileExtension('score', '.musicxml')).toBe('score.musicxml');
  });

  it('keeps an existing extension, case-insensitively', () => {
    expect(ensureFileExtension('score.musicxml', '.musicxml')).toBe('score.musicxml');
    expect(ensureFileExtension('SCORE.MUSICXML', '.musicxml')).toBe('SCORE.MUSICXML');
  });

  it('appends when the name ends with a different extension', () => {
    expect(ensureFileExtension('score.xml', '.musicxml')).toBe('score.xml.musicxml');
  });
});

describe('downloads', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let downloads: string[];

  beforeEach(() => {
    downloads = [];
    createObjectURL = vi.fn(() => 'blob:fake');
    revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('downloadBlob clicks an anchor with the given filename and revokes the URL', () => {
    const blob = new Blob(['x']);
    downloadBlob(blob, 'file.bin');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(downloads).toEqual(['file.bin']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    expect(document.querySelector('a')).toBeNull();
  });

  it('exportMusicXml downloads with a .musicxml name and MusicXML MIME type', () => {
    exportMusicXml('<score-partwise/>', 'my song');
    expect(downloads).toEqual(['my song.musicxml']);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/vnd.recordare.musicxml+xml');
  });
});

describe('printScore', () => {
  it('keeps pages through print and restores the DOM after afterprint', () => {
    let pagesAtPrintTime = -1;
    let styleAtPrintTime = '';
    const printSpy = vi.fn(() => {
      pagesAtPrintTime = document.querySelectorAll(`.${PRINT_PAGE_CLASS}`).length;
      styleAtPrintTime = document.head.querySelector('style')?.textContent ?? '';
    });
    vi.stubGlobal('print', printSpy);

    printScore([SVG_PAGE, SVG_PAGE], A4);

    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(pagesAtPrintTime).toBe(2);
    expect(styleAtPrintTime).toContain('@page { size: 210mm 297mm; margin: 0; }');
    expect(document.querySelectorAll(`.${PRINT_PAGE_CLASS}`)).toHaveLength(2);
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector(`.${PRINT_ROOT_CLASS}`)).toBeNull();
    expect(document.head.querySelector('style')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('restores the DOM after a fallback timeout when afterprint is missing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('print', vi.fn());

    printScore([SVG_PAGE], A4);

    expect(document.querySelector(`.${PRINT_ROOT_CLASS}`)).not.toBeNull();
    vi.advanceTimersByTime(PRINT_CLEANUP_FALLBACK_MS);
    expect(document.querySelector(`.${PRINT_ROOT_CLASS}`)).toBeNull();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restores the DOM even when print throws', () => {
    vi.stubGlobal(
      'print',
      vi.fn(() => {
        throw new Error('no printer');
      }),
    );
    expect(() => printScore([SVG_PAGE], A4)).toThrow('no printer');
    expect(document.querySelector(`.${PRINT_ROOT_CLASS}`)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('exportPdf', () => {
  beforeEach(() => {
    pdfState.instances.length = 0;
  });

  it('rejects an empty page list', async () => {
    await expect(exportPdf([], A4)).rejects.toThrow(TypeError);
  });

  it('creates one PDF page per SVG page with the layout size', async () => {
    const blob = await exportPdf([SVG_PAGE, SVG_PAGE, SVG_PAGE], A4);
    expect(blob.type).toBe('application/pdf');
    expect(pdfState.instances).toHaveLength(1);
    const doc = pdfState.instances[0];
    expect(doc.options).toEqual({ unit: 'mm', format: [210, 297], orientation: 'portrait' });
    expect(doc.propertiesCalls).toEqual([
      {
        title: 'score',
        author: 'sonare studio',
        subject: 'Engraved score',
        creator: 'sonare studio',
      },
    ]);
    // First page comes from the constructor; addPage runs between pages only.
    expect(doc.addPageCalls).toEqual([
      [[210, 297], 'portrait'],
      [[210, 297], 'portrait'],
    ]);
    expect(doc.svgCalls).toHaveLength(3);
    for (const call of doc.svgCalls) {
      expect(call.tag).toBe('svg');
      expect(call.options).toEqual({ x: 0, y: 0, width: 210, height: 297 });
    }
    expect(doc.textCalls).toEqual([
      { text: 'Page 1 / 3', x: 105, y: 290, options: { align: 'center' } },
      { text: 'Page 2 / 3', x: 105, y: 290, options: { align: 'center' } },
      { text: 'Page 3 / 3', x: 105, y: 290, options: { align: 'center' } },
    ]);
    expect(doc.outputCalls).toEqual(['blob']);
  });

  it('uses landscape orientation when the page is wider than tall', async () => {
    await exportPdf([SVG_PAGE], { pageWidthMm: 297, pageHeightMm: 210 });
    expect(pdfState.instances[0].options).toEqual({
      unit: 'mm',
      format: [297, 210],
      orientation: 'landscape',
    });
  });

  it('writes supplied PDF metadata', async () => {
    await exportPdf([SVG_PAGE], A4, { title: 'Etude', author: 'Composer', subject: 'Practice' });
    expect(pdfState.instances[0].propertiesCalls[0]).toEqual({
      title: 'Etude',
      author: 'Composer',
      subject: 'Practice',
      creator: 'sonare studio',
    });
  });

  it('draws a PDF header title and can suppress page numbers', async () => {
    await exportPdf([SVG_PAGE], A4, {
      title: 'Etude',
      headerTitle: 'Etude - Violin',
      pageNumbers: false,
    });
    expect(pdfState.instances[0].fontSizeCalls).toEqual([8]);
    expect(pdfState.instances[0].textColorCalls).toEqual([80]);
    expect(pdfState.instances[0].textCalls).toEqual([
      { text: 'Etude - Violin', x: 7, y: 7, options: { align: 'left' } },
    ]);
  });

  it('suppresses an unrepresentable core-font header while retaining ASCII page numbers', async () => {
    await exportPdf(['<svg/>'], A4, { title: '譜面', pageNumbers: true });

    expect(pdfState.instances[0].textCalls).toEqual([
      { text: 'Page 1 / 1', x: 105, y: 290, options: { align: 'center' } },
    ]);
  });

  it('rejects malformed SVG markup', async () => {
    await expect(exportPdf(['<svg><unclosed'], A4)).rejects.toThrow('Invalid SVG page markup');
  });
});
