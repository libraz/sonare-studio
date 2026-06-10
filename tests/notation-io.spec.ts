import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureFileExtension,
  exportMusicXml,
  exportSmfFile,
  exportSmfFromProject,
  importSmfToNotes,
  pairSmfEventsIntoNotes,
} from '@/notation/io';
import {
  buildPrintPageCss,
  downloadBlob,
  exportPdf,
  mmToPt,
  PRINT_PAGE_CLASS,
  PRINT_ROOT_CLASS,
  printScore,
  ptToMm,
} from '@/notation/print';
import type { Project } from '@/wasm/index.js';

/** Captures every jsPDF instance the mocked module creates. */
const pdfState = vi.hoisted(() => ({
  instances: [] as Array<{
    options: unknown;
    addPageCalls: unknown[][];
    svgCalls: Array<{ tag: string; options: unknown }>;
    outputCalls: string[];
  }>,
}));

vi.mock('jspdf', () => {
  class FakeJsPdf {
    record: (typeof pdfState.instances)[number];

    constructor(options: unknown) {
      this.record = { options, addPageCalls: [], svgCalls: [], outputCalls: [] };
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

/** Packs a UMP MIDI 1.0 channel-voice word (matches the binding layout). */
function ump(status: number, channel: number, pitch: number, velocity: number): number {
  return (((0x2 << 28) | (status << 20) | (channel << 16) | (pitch << 8) | velocity) >>> 0) | 0;
}

const NOTE_ON = 0x9;
const NOTE_OFF = 0x8;

/** Events handed to the fake Project below, keyed by fake clip id. */
const wasmState = vi.hoisted(() => ({
  clipId: 7,
  events: [] as Array<{ ppq: number; data0: number; data1: number }>,
  importedBuffers: [] as Uint8Array[],
  deleted: 0,
}));

vi.mock('@/lib/wasm', () => {
  class FakeProject {
    importSmf(data: Uint8Array): number {
      wasmState.importedBuffers.push(data);
      return wasmState.clipId;
    }

    toJson(): string {
      return JSON.stringify({
        midi_content: { [String(wasmState.clipId)]: wasmState.events },
      });
    }

    delete(): void {
      wasmState.deleted += 1;
    }
  }
  return { ensureWasm: () => Promise.resolve({ Project: FakeProject }) };
});

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

  it('exportSmfFile downloads project bytes with a .mid name', () => {
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64]);
    const project = { exportSmf: vi.fn(() => bytes) } as unknown as Project;
    exportSmfFile(project, 'take1');
    expect(downloads).toEqual(['take1.mid']);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('audio/midi');
    expect(blob.size).toBe(4);
  });
});

describe('printScore', () => {
  it('injects pages and a print stylesheet, prints, then restores the DOM', () => {
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
    expect(document.querySelector(`.${PRINT_ROOT_CLASS}`)).toBeNull();
    expect(document.head.querySelector('style')).toBeNull();
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

  it('rejects malformed SVG markup', async () => {
    await expect(exportPdf(['<svg><unclosed'], A4)).rejects.toThrow('Invalid SVG page markup');
  });
});

describe('pairSmfEventsIntoNotes', () => {
  it('pairs note-on/note-off into notes with velocity and channel', () => {
    const notes = pairSmfEventsIntoNotes([
      { ppq: 0, data0: ump(NOTE_ON, 0, 60, 100), data1: 0 },
      { ppq: 1, data0: ump(NOTE_OFF, 0, 60, 64), data1: 0 },
      { ppq: 2, data0: ump(NOTE_ON, 3, 64, 80), data1: 0 },
      { ppq: 2.5, data0: ump(NOTE_OFF, 3, 64, 0), data1: 0 },
    ]);
    expect(notes).toEqual([
      { pitch: 60, velocity: 100, startPpq: 0, durationPpq: 1, channel: 0, offVelocity: 64 },
      { pitch: 64, velocity: 80, startPpq: 2, durationPpq: 0.5, channel: 3 },
    ]);
  });

  it('treats note-on with velocity 0 as note-off and pairs repeats FIFO', () => {
    const notes = pairSmfEventsIntoNotes([
      { ppq: 0, data0: ump(NOTE_ON, 0, 60, 90), data1: 0 },
      { ppq: 1, data0: ump(NOTE_ON, 0, 60, 0), data1: 0 },
      { ppq: 1, data0: ump(NOTE_ON, 0, 60, 70), data1: 0 },
      { ppq: 2, data0: ump(NOTE_ON, 0, 60, 0), data1: 0 },
    ]);
    expect(notes).toEqual([
      { pitch: 60, velocity: 90, startPpq: 0, durationPpq: 1, channel: 0 },
      { pitch: 60, velocity: 70, startPpq: 1, durationPpq: 1, channel: 0 },
    ]);
  });

  it('drops unmatched boundaries and non-note events', () => {
    const notes = pairSmfEventsIntoNotes([
      // Control change (status 0xB): ignored.
      { ppq: 0, data0: (((0x2 << 28) | (0xb << 20) | (7 << 8)) >>> 0) | 0, data1: 0 },
      // Note-off without a matching note-on: ignored.
      { ppq: 1, data0: ump(NOTE_OFF, 0, 62, 0), data1: 0 },
      // Note-on without a note-off: ignored.
      { ppq: 2, data0: ump(NOTE_ON, 0, 65, 90), data1: 0 },
    ]);
    expect(notes).toEqual([]);
  });
});

describe('importSmfToNotes', () => {
  beforeEach(() => {
    wasmState.events = [];
    wasmState.importedBuffers.length = 0;
    wasmState.deleted = 0;
  });

  it('imports the first clip of an SMF buffer and releases the scratch Project', async () => {
    wasmState.events = [
      { ppq: 0, data0: ump(NOTE_ON, 0, 60, 100), data1: 0 },
      { ppq: 4, data0: ump(NOTE_OFF, 0, 60, 0), data1: 0 },
    ];
    const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64]);
    const notes = await importSmfToNotes(bytes);
    expect(wasmState.importedBuffers).toEqual([bytes]);
    expect(notes).toEqual([{ pitch: 60, velocity: 100, startPpq: 0, durationPpq: 4, channel: 0 }]);
    expect(wasmState.deleted).toBe(1);
  });

  it('returns an empty list when the imported clip has no events', async () => {
    const notes = await importSmfToNotes(new Uint8Array());
    expect(notes).toEqual([]);
    expect(wasmState.deleted).toBe(1);
  });
});

describe('exportSmfFromProject', () => {
  it('returns the bytes produced by Project.exportSmf', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const project = { exportSmf: vi.fn(() => bytes) } as unknown as Project;
    expect(exportSmfFromProject(project)).toBe(bytes);
  });
});
