/**
 * Draws the SMuFL glyphs Verovio writes as text as outline paths, for the PDF
 * path, which has no music text font. Positions come from the browser's own
 * layout of the attached page, so a path lands where the glyph rendered; the
 * text runs of the same <text> element are pinned to their laid-out start
 * positions so that removing the glyphs moves nothing around them.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Font units per em of the outline table. */
const SMUFL_UNITS_PER_EM = 1000;

/** The family Verovio names for its SMuFL text glyphs. */
export const SMUFL_TEXT_FAMILY = 'Leipzig';

/** The laid-out characters of a text content element, in its <text> element's user space. */
export interface TextLayout {
  /** Number of addressable characters the element holds. */
  charCount(element: SVGTextContentElement): number;
  /** Start position of one addressable character of the element. */
  charStart(element: SVGTextContentElement, index: number): { x: number; y: number };
}

const browserTextLayout: TextLayout = {
  charCount: (element) => element.getNumberOfChars(),
  charStart: (element, index) => {
    const point = element.getStartPositionOfChar(index);
    return { x: point.x, y: point.y };
  },
};

/** The <tspan> elements of a page set in the SMuFL text family. */
export function smuflTextRuns(root: Element): Element[] {
  return [...root.querySelectorAll('[font-family]')].filter((element) =>
    (element.getAttribute('font-family') ?? '')
      .split(',')
      .some((family) => family.trim().replace(/^['"]|['"]$/g, '') === SMUFL_TEXT_FAMILY),
  );
}

/**
 * Replaces every SMuFL text glyph of an attached page with its outline.
 *
 * @param root The page, attached to a laid-out document.
 * @param outlines Outline path data by code point, in font units.
 * @param layout Character layout lookup; the browser's by default.
 * @returns The code points that have no outline and were not drawn.
 */
export function drawSmuflTextAsPaths(
  root: Element,
  outlines: ReadonlyMap<number, string>,
  layout: TextLayout = browserTextLayout,
): Set<number> {
  const undrawn = new Set<number>();
  const texts = new Set<SVGTextContentElement>();
  for (const run of smuflTextRuns(root)) {
    const text = run.closest('text');
    if (text) texts.add(text);
  }
  for (const text of texts) replaceInText(text, outlines, layout, undrawn);
  return undrawn;
}

interface TextRun {
  node: Text;
  owner: SVGTextContentElement;
  smufl: boolean;
}

function replaceInText(
  text: SVGTextContentElement,
  outlines: ReadonlyMap<number, string>,
  layout: TextLayout,
  undrawn: Set<number>,
): void {
  const smuflRuns = new Set(smuflTextRuns(text));
  const runs: TextRun[] = [];
  const walker = text.ownerDocument.createTreeWalker(text, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const owner = node.parentElement as SVGTextContentElement | null;
    if (owner && node.data.trim() !== '') {
      const smuflOwner = owner.closest('[font-family]');
      runs.push({ node, owner, smufl: smuflOwner !== null && smuflRuns.has(smuflOwner) });
    }
  }
  // Measure everything before the first mutation changes the layout.
  const paths: SVGPathElement[] = [];
  const pins: Array<{ owner: Element; x: number; y: number }> = [];
  for (const run of runs) {
    if (!run.smufl) {
      if (run.owner !== text && !pins.some((pin) => pin.owner === run.owner)) {
        pins.push({ owner: run.owner, ...layout.charStart(run.owner, 0) });
      }
      continue;
    }
    const scale = fontSizePx(run.owner) / SMUFL_UNITS_PER_EM;
    const indices = addressableIndices(run.node.data, layout.charCount(run.owner));
    let offset = 0;
    for (const character of run.node.data) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (character.trim() !== '') {
        const outline = outlines.get(codePoint);
        if (outline === undefined) {
          undrawn.add(codePoint);
        } else {
          const at = layout.charStart(run.owner, indices[offset]);
          paths.push(outlinePath(text, run.owner, outline, at, scale));
        }
      }
      offset += character.length;
    }
  }
  for (const run of runs) if (run.smufl) run.node.data = '';
  for (const pin of pins) {
    pin.owner.setAttribute('x', String(pin.x));
    pin.owner.setAttribute('y', String(pin.y));
  }
  // Each run now starts where the browser laid it out, so the anchor no longer applies.
  text.setAttribute('text-anchor', 'start');
  for (const anchored of text.querySelectorAll('[text-anchor]')) {
    anchored.removeAttribute('text-anchor');
  }
  text.after(...paths);
}

/**
 * Maps each UTF-16 offset of a run's text onto its addressable character index
 * after SVG whitespace handling: newlines are dropped, tabs become spaces, and
 * a space following a space collapses. A leading space the layout dropped
 * because the preceding text already ended in one shifts every index down by one.
 */
function addressableIndices(data: string, addressable: number): number[] {
  const indices: number[] = [];
  let index = 0;
  let previousSpace = false;
  for (const unit of data) {
    for (let at = 0; at < unit.length; at++) indices.push(index);
    if (unit === '\n' || unit === '\r') continue;
    const space = unit === ' ' || unit === '\t';
    if (space && previousSpace) continue;
    previousSpace = space;
    index += unit.length;
  }
  const leadingSpace = /^[\r\n]*[ \t]/.test(data);
  return leadingSpace && index > addressable
    ? indices.map((value) => Math.max(0, value - 1))
    : indices;
}

function outlinePath(
  text: Element,
  run: Element,
  outline: string,
  at: { x: number; y: number },
  scale: number,
): SVGPathElement {
  const path = text.ownerDocument.createElementNS(SVG_NS, 'path') as SVGPathElement;
  path.setAttribute('d', outline);
  const own = `translate(${at.x} ${at.y}) scale(${scale} ${-scale})`;
  const inherited = text.getAttribute('transform');
  path.setAttribute('transform', inherited ? `${inherited} ${own}` : own);
  const fill = inheritedAttribute(run, text, 'fill');
  if (fill !== null) path.setAttribute('fill', fill);
  return path;
}

/** Nearest `name` attribute from `element` up to and including `stop`. */
function inheritedAttribute(element: Element, stop: Element, name: string): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute(name);
    if (value !== null) return value;
    if (current === stop) break;
  }
  return null;
}

/** The font size in user units an element's text is set at. */
function fontSizePx(element: Element): number {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const size = Number.parseFloat(current.getAttribute('font-size') ?? '');
    if (Number.isFinite(size) && size > 0) return size;
  }
  throw new Error('SMuFL text run has no font size');
}
