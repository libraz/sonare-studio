export interface XmlLimits {
  maxBytes: number;
  maxElements: number;
  maxDepth: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxElements: 250_000,
  maxDepth: 128,
});

export class XmlPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlPreflightError';
  }
}

/** Rejects oversized XML before DOMParser allocates a full document tree. */
export function preflightXmlBytes(
  byteLength: number,
  label: string,
  limits: Partial<XmlLimits> = {},
): void {
  const resolved = { ...DEFAULT_XML_LIMITS, ...limits };
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > resolved.maxBytes) {
    throw new XmlPreflightError(`${label} exceeds the ${resolved.maxBytes}-byte XML limit`);
  }
}

/** Finds the closing `>` of an XML tag without being confused by quoted attributes. */
function markupEnd(xml: string, start: number, declaration: boolean): number {
  let quote = '';
  let subsetDepth = 0;
  for (let index = start + 1; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (declaration && char === '[') subsetDepth += 1;
    if (declaration && char === ']' && subsetDepth > 0) subsetDepth -= 1;
    if (char === '>' && subsetDepth === 0) return index;
  }
  return xml.length;
}

/**
 * Rejects deeply nested XML markup before DOMParser allocates a document tree.
 * Comments, CDATA, processing instructions and declarations are skipped rather
 * than treated as elements; malformed XML is still left to the XML parser.
 */
export function preflightXmlMarkupDepth(
  xml: string,
  label: string,
  limits: Partial<XmlLimits> = {},
): void {
  const resolved = { ...DEFAULT_XML_LIMITS, ...limits };
  let depth = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) return;
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      cursor = end < 0 ? xml.length : end + 2;
      continue;
    }

    const declaration = xml.startsWith('<!', start);
    const end = markupEnd(xml, start, declaration);
    if (declaration) {
      cursor = end + 1;
      continue;
    }
    const tag = xml.slice(start + 1, end).trim();
    cursor = end + 1;
    if (!tag) continue;
    if (tag.startsWith('/')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (tag.endsWith('/')) continue;
    depth += 1;
    if (depth > resolved.maxDepth) {
      throw new XmlPreflightError(`${label} exceeds the ${resolved.maxDepth}-depth XML limit`);
    }
  }
}

/** Rejects pathologically large parsed trees before semantic traversal. */
export function preflightXmlDocument(
  document: Document,
  label: string,
  limits: Partial<XmlLimits> = {},
): void {
  const resolved = { ...DEFAULT_XML_LIMITS, ...limits };
  const elements = document.getElementsByTagName('*').length;
  if (elements > resolved.maxElements) {
    throw new XmlPreflightError(`${label} exceeds the ${resolved.maxElements}-element XML limit`);
  }
}
