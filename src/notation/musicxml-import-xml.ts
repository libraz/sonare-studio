/**
 * The MusicXML importer's element tree: a size- and depth-bounded parse into
 * plain elements, and the typed readers for their child values.
 */

import { SaxesParser } from 'saxes';
import { MAX_XML_DOCUMENT_BYTES, preflightXmlBytes, XmlPreflightError } from '@/lib/xml-preflight';

export interface MusicXmlImportLimits {
  maxBytes: number;
  maxElements: number;
  maxDepth: number;
  maxParts: number;
  maxMeasures: number;
  maxNotes: number;
  maxNumericAbs: number;
}

export const DEFAULT_MUSICXML_IMPORT_LIMITS: Readonly<MusicXmlImportLimits> = Object.freeze({
  maxBytes: MAX_XML_DOCUMENT_BYTES,
  // A normal detailed score uses roughly 9--15 XML elements per note. Keep
  // this comfortably above the documented note limit while the byte limit
  // remains the primary protection against hostile input.
  maxElements: 5_000_000,
  maxDepth: 128,
  maxParts: 1_024,
  maxMeasures: 100_000,
  maxNotes: 1_000_000,
  maxNumericAbs: 1_000_000_000,
});

export interface XmlElement {
  tagName: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** Raised when a MusicXML document cannot be parsed or is not a supported score. */
export class MusicXmlImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicXmlImportError';
  }
}

/** Returns direct child elements of `parent`, optionally filtered by tag name. */
export function childElements(parent: XmlElement, tag?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of parent.children) {
    if (tag === undefined || child.tagName === tag) out.push(child);
  }
  return out;
}

/** Returns the trimmed text of the first `tag` child, or null when absent. */
export function elementText(element: XmlElement): string {
  return element.text + element.children.map(elementText).join('');
}

export function childText(parent: XmlElement, tag: string): string | null {
  const child = childElements(parent, tag)[0];
  const text = child === undefined ? undefined : elementText(child).trim();
  return text === undefined || text === '' ? null : text;
}

/** Parses the first `tag` child as an integer, or null when absent/invalid. */
export function childInt(parent: XmlElement, tag: string, maxNumericAbs: number): number | null {
  const text = childText(parent, tag);
  if (text === null) return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || Math.abs(value) > maxNumericAbs) {
    throw new MusicXmlImportError(`MusicXML numeric value exceeds the safe limit: ${text}`);
  }
  return value;
}

/** Parses the first `tag` child as a bounded finite number. */
export function childNumber(parent: XmlElement, tag: string, maxNumericAbs: number): number | null {
  const text = childText(parent, tag);
  if (text === null) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > maxNumericAbs) return null;
  return value;
}

export function descendants(parent: XmlElement, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  const pending = [...parent.children].reverse();
  while (pending.length > 0) {
    const child = pending.pop();
    if (child === undefined) continue;
    if (child.tagName === tag) out.push(child);
    for (let index = child.children.length - 1; index >= 0; index -= 1) {
      pending.push(child.children[index]);
    }
  }
  return out;
}

/**
 * Parses a MusicXML string into a DOM document.
 *
 * @param xml MusicXML source text.
 * @returns The root `score-partwise` element.
 * @throws MusicXmlImportError When the input is not well-formed XML or is not
 *   a `score-partwise` document.
 */
export function parseScoreRoot(
  xml: string,
  limits: Partial<MusicXmlImportLimits> = {},
): XmlElement {
  const resolved = { ...DEFAULT_MUSICXML_IMPORT_LIMITS, ...limits };
  try {
    preflightXmlBytes(new TextEncoder().encode(xml).byteLength, 'MusicXML', {
      maxBytes: resolved.maxBytes,
    });
  } catch (error) {
    if (error instanceof XmlPreflightError) {
      throw new MusicXmlImportError(error.message);
    }
    throw new MusicXmlImportError('MusicXML could not be parsed as XML');
  }
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];
  let elements = 0;
  let parts = 0;
  let measures = 0;
  let notes = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    elements += 1;
    if (tag.name === 'part') parts += 1;
    if (tag.name === 'measure') measures += 1;
    if (tag.name === 'note') notes += 1;
    if (elements > resolved.maxElements) {
      throw new MusicXmlImportError(
        `MusicXML is too complex to import (more than ${resolved.maxElements.toLocaleString()} structural entries)`,
      );
    }
    if (stack.length + 1 > resolved.maxDepth) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxDepth}-level depth limit`);
    }
    if (parts > resolved.maxParts) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxParts}-part limit`);
    }
    if (measures > resolved.maxMeasures) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxMeasures}-measure limit`);
    }
    if (notes > resolved.maxNotes) {
      throw new MusicXmlImportError(`MusicXML exceeds the ${resolved.maxNotes}-note limit`);
    }
    const attributes: Record<string, string> = {};
    for (const [name, raw] of Object.entries(tag.attributes)) {
      attributes[name] = raw;
    }
    const element: XmlElement = { tagName: tag.name, attributes, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root === null) root = element;
    else throw new MusicXmlImportError('MusicXML contains multiple root elements');
    stack.push(element);
  });
  parser.on('text', (text) => {
    const current = stack[stack.length - 1];
    if (current) current.text += text;
  });
  parser.on('cdata', (text) => {
    const current = stack[stack.length - 1];
    if (current) current.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof MusicXmlImportError) throw error;
    throw new MusicXmlImportError('MusicXML is not well-formed XML');
  }
  const parsedRoot = root as XmlElement | null;
  if (parsedRoot === null) throw new MusicXmlImportError('MusicXML is not well-formed XML');
  if (parsedRoot.tagName === 'score-timewise') {
    throw new MusicXmlImportError('score-timewise MusicXML is not supported; convert to partwise');
  }
  if (parsedRoot.tagName !== 'score-partwise') {
    throw new MusicXmlImportError(`Unexpected MusicXML root element <${parsedRoot.tagName}>`);
  }
  return parsedRoot;
}
