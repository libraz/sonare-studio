export interface XmlLimits {
  maxBytes: number;
  maxElements: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxElements: 250_000,
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
