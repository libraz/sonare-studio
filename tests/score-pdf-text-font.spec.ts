import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadPdfTextFont,
  type PdfTextFont,
  PdfTextFontUnavailableError,
  pdfTextFontFromBytes,
  trueTypeCoverage,
} from '@/notation/pdf-font';
import { drawSmuflTextAsPaths } from '@/notation/pdf-smufl-text';
import { createPdfPageWriter, type PdfTextPlan, planPdfText } from '@/notation/print';

const pdfState = vi.hoisted(() => ({
  instances: [] as Array<{
    properties: Record<string, string>[];
    vfs: Array<[string, string]>;
    fonts: Array<[string, string, string]>;
    setFontCalls: Array<[string, string]>;
    texts: string[];
    pages: Element[];
  }>,
}));

vi.mock('jspdf', () => {
  class FakeJsPdf {
    record = {
      properties: [] as Record<string, string>[],
      vfs: [] as Array<[string, string]>,
      fonts: [] as Array<[string, string, string]>,
      setFontCalls: [] as Array<[string, string]>,
      texts: [] as string[],
      pages: [] as Element[],
    };
    constructor() {
      pdfState.instances.push(this.record);
    }
    addPage(): this {
      return this;
    }
    setProperties(properties: Record<string, string>): this {
      this.record.properties.push(properties);
      return this;
    }
    addFileToVFS(name: string, content: string): this {
      this.record.vfs.push([name, content]);
      return this;
    }
    addFont(file: string, name: string, style: string): this {
      this.record.fonts.push([file, name, style]);
      return this;
    }
    setFont(name: string, style: string): this {
      this.record.setFontCalls.push([name, style]);
      return this;
    }
    setFontSize(): this {
      return this;
    }
    setTextColor(): this {
      return this;
    }
    text(text: string): this {
      this.record.texts.push(text);
      return this;
    }
    svg(element: Element): Promise<this> {
      this.record.pages.push(element);
      return Promise.resolve(this);
    }
    output(): Blob {
      return new Blob(['%PDF-fake'], { type: 'application/pdf' });
    }
  }
  return { jsPDF: FakeJsPdf };
});
vi.mock('svg2pdf.js', () => ({}));

const A4 = { pageWidthMm: 210, pageHeightMm: 297 };
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A font covering ASCII and kana only. */
function kanaFont(): PdfTextFont {
  return {
    name: 'TestJP',
    fileName: 'TestJP.ttf',
    binary: '\x00\x01\x00\x00',
    covers: (codePoint) => codePoint < 0x80 || (codePoint >= 0x3040 && codePoint <= 0x30ff),
  };
}

const LATIN: PdfTextPlan = { font: null, undrawable: [] };

async function writePdf(pages: string[], text: PdfTextPlan, title = 'Etude') {
  const writer = await createPdfPageWriter(pages.length, A4, {
    title,
    subject: 'Score',
    pageLabel: '{page} / {count} ページ',
    text,
  });
  for (let index = 0; index < pages.length; index++) await writer.addPage(pages[index], index + 1);
  writer.close();
  return { writer, doc: pdfState.instances[pdfState.instances.length - 1] };
}

describe('PDF text plan', () => {
  it('keeps an all-Latin document on the core fonts and loads nothing', async () => {
    const loadFont = vi.fn(async () => kanaFont());
    await expect(planPdfText(['Etude in C', 'Page {page} / {count}'], loadFont)).resolves.toEqual({
      font: null,
      undrawable: [],
    });
    expect(loadFont).not.toHaveBeenCalled();
  });

  it('loads the embedded font for Japanese text and lists what it still cannot draw', async () => {
    const font = kanaFont();
    const plan = await planPdfText(['ピアノ Piano', '한국어 ピアノ'], async () => font);
    expect(plan.font).toBe(font);
    expect(plan.undrawable).toEqual(['한', '국', '어']);
  });
});

describe('PDF writer with the text plan', () => {
  beforeEach(() => {
    pdfState.instances.length = 0;
  });

  it('registers no font for an all-Latin document', async () => {
    const { doc } = await writePdf([`<svg xmlns="${SVG_NS}"/>`], LATIN);
    expect(doc.vfs).toEqual([]);
    expect(doc.fonts).toEqual([]);
  });

  it('sets the header, the page label and every SVG text item in the embedded font', async () => {
    const font = kanaFont();
    const page = `<svg xmlns="${SVG_NS}"><g font-family="Times, serif"><text x="1" y="2"><tspan font-weight="bold">ピアノ</tspan></text></g></svg>`;
    const { doc } = await writePdf([page], { font, undrawable: [] }, 'ソナタ');
    expect(doc.vfs).toEqual([['TestJP.ttf', '\x00\x01\x00\x00']]);
    expect(doc.fonts).toEqual([['TestJP.ttf', 'TestJP', 'normal']]);
    expect(doc.setFontCalls).toEqual([['TestJP', 'normal']]);
    expect(doc.texts).toEqual(['ソナタ', '1 / 1 ページ']);
    for (const node of doc.pages[0].querySelectorAll('text, tspan')) {
      const style = (node as SVGElement).style;
      expect(style.getPropertyValue('font-family')).toBe('TestJP');
      expect(style.getPropertyValue('font-weight')).toBe('normal');
      expect(style.getPropertyValue('font-style')).toBe('normal');
    }
  });

  it('writes non-ASCII document information as a UTF-16BE text string', async () => {
    const { doc } = await writePdf(
      [`<svg xmlns="${SVG_NS}"/>`],
      { font: kanaFont(), undrawable: [] },
      '譜',
    );
    expect(doc.properties[0].title).toBe('\xfe\xff\x8b\x5c');
    expect(doc.properties[0].subject).toBe('Score');
  });

  it('reports page text the plan had not seen and its font cannot draw', async () => {
    const page = `<svg xmlns="${SVG_NS}"><text>ピアノ 한</text></svg>`;
    const { writer } = await writePdf([page], { font: kanaFont(), undrawable: [] });
    expect(writer.undrawable()).toEqual(['한']);
  });

  it('does not report again what the plan already listed', async () => {
    const page = `<svg xmlns="${SVG_NS}"><text>한</text></svg>`;
    const { writer } = await writePdf([page], { font: kanaFont(), undrawable: ['한'] });
    expect(writer.undrawable()).toEqual([]);
  });
});

describe('SMuFL text glyphs as paths', () => {
  /** A tempo mark the way Verovio writes it: a SMuFL note, a space, a dot, then Latin text. */
  function tempoText(): SVGSVGElement {
    const svg = new DOMParser().parseFromString(
      [
        `<svg xmlns="${SVG_NS}"><g fill="#111">`,
        '<text x="100" y="200" font-size="0px" text-anchor="middle" transform="translate(5 6)">',
        '  <tspan class="rend">',
        '    <tspan class="text"><tspan font-family="Leipzig" font-size="720px">\uECA5 \uECB7</tspan></tspan>',
        '    <tspan class="text"><tspan font-size="405px"> = 60</tspan></tspan>',
        '  </tspan>',
        '</text></g></svg>',
      ].join('\n'),
      'image/svg+xml',
    ).documentElement as unknown as SVGSVGElement;
    return svg;
  }

  // Each element's characters advance by 10 from where its run starts: the SMuFL
  // run (note, space, dot) at 100, the Latin run at 130.
  const layout = {
    charCount: (element: SVGTextContentElement) => element.textContent?.length ?? 0,
    charStart: (element: SVGTextContentElement, index: number) => {
      // The browser refuses an index past the element's own characters.
      if (index >= (element.textContent?.length ?? 0)) throw new RangeError(`char ${index}`);
      return {
        x: (element.getAttribute('font-family') === 'Leipzig' ? 100 : 130) + index * 10,
        y: 200,
      };
    },
  };

  it('draws each glyph as its outline at the laid-out position and size', () => {
    const svg = tempoText();
    const undrawn = drawSmuflTextAsPaths(
      svg,
      new Map([
        [0xeca5, 'M0 0h1'],
        [0xecb7, 'M0 0h2'],
      ]),
      layout,
    );
    expect(undrawn).toEqual(new Set());
    const paths = [...svg.querySelectorAll('path')].map((path) => ({
      d: path.getAttribute('d'),
      transform: path.getAttribute('transform'),
      parent: path.parentElement?.getAttribute('fill'),
    }));
    // The paths sit beside the text, in the group that gives both their fill.
    expect(paths).toEqual([
      {
        d: 'M0 0h1',
        transform: 'translate(5 6) translate(100 200) scale(0.72 -0.72)',
        parent: '#111',
      },
      {
        d: 'M0 0h2',
        transform: 'translate(5 6) translate(120 200) scale(0.72 -0.72)',
        parent: '#111',
      },
    ]);
  });

  it('pins the following text where it was laid out and clears the glyph text', () => {
    const svg = tempoText();
    drawSmuflTextAsPaths(
      svg,
      new Map([
        [0xeca5, 'M0 0'],
        [0xecb7, 'M0 0'],
      ]),
      layout,
    );
    const text = svg.querySelector('text');
    expect(text?.getAttribute('text-anchor')).toBe('start');
    expect(svg.querySelector('[font-family="Leipzig"]')?.textContent).toBe('');
    const latin = svg.querySelector('[font-size="405px"]');
    expect([latin?.getAttribute('x'), latin?.getAttribute('y')]).toEqual(['130', '200']);
    expect(text?.textContent?.trim()).toBe('= 60');
  });

  it('returns a glyph with no outline instead of dropping it silently', () => {
    const svg = tempoText();
    const undrawn = drawSmuflTextAsPaths(svg, new Map([[0xeca5, 'M0 0']]), layout);
    expect(undrawn).toEqual(new Set([0xecb7]));
  });
});

describe('embedded text font coverage', () => {
  it('reads the bundled font cmap: kana, kanji and Latin, but not Hangul or SMuFL', () => {
    const bytes = readFileSync(
      'node_modules/@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf',
    );
    const coverage = trueTypeCoverage(new Uint8Array(bytes));
    for (const character of 'ピアノ右手 Piano é') {
      expect(coverage.has(character.codePointAt(0) ?? 0), character).toBe(true);
    }
    for (const codePoint of [0xd55c, 0xeca5]) expect(coverage.has(codePoint)).toBe(false);
  });
});

describe('embedded text font loading', () => {
  it('reports a font the network cannot deliver as unavailable', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(loadPdfTextFont(offline)).rejects.toBeInstanceOf(PdfTextFontUnavailableError);
    const refused = vi.fn(async () => new Response('', { status: 404 }));
    await expect(loadPdfTextFont(refused)).rejects.toBeInstanceOf(PdfTextFontUnavailableError);
  });
});

describe('embedded text font coverage through the plan and the writer', () => {
  const font = pdfTextFontFromBytes(
    new Uint8Array(
      readFileSync(
        'node_modules/@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf',
      ),
    ),
  );

  beforeEach(() => {
    pdfState.instances.length = 0;
  });

  it('lists Hangul, a Chinese-only ideograph and Cyrillic outside JIS per code point', async () => {
    const plan = await planPdfText(['한국 ピアノ', '们 Ђ Д', 'Piano é 右手'], async () => font);
    expect(plan.font).toBe(font);
    expect(plan.undrawable).toEqual(['한', '국', '们', 'Ђ']);
    const page = `<svg xmlns="${SVG_NS}"><text>Ә ピアノ 한</text></svg>`;
    const { writer } = await writePdf([page], plan);
    expect(writer.undrawable()).toEqual(['Ә']);
  });
});
