/**
 * Minimal pure XML document builder/serializer for the DAWproject exporter.
 *
 * No DOM dependency: the same code runs on the main thread, inside module
 * workers and under jsdom tests. Output is a UTF-8 XML 1.0 document with a
 * standard declaration and two-space indentation; attribute and text content
 * is escaped, element/attribute names are validated.
 */

/** Attribute value: strings pass through escaped, numbers must be finite. */
export type XmlAttributeValue = string | number | boolean;

/** One XML element: attributes plus either child elements or a text body. */
export interface XmlElement {
  /** Element name (validated against a conservative name pattern). */
  name: string;
  /** Attributes in insertion order; undefined values are omitted. */
  attributes?: Record<string, XmlAttributeValue | undefined>;
  /** Child elements (mutually exclusive with a text body). */
  children?: XmlElement[];
  /** Text body (mutually exclusive with child elements). */
  text?: string;
}

/**
 * Conservative element/attribute name pattern (ASCII subset of the XML Name
 * production, no namespace colons). All names in this exporter are literals,
 * so the restriction never bites in practice; it guards against bugs.
 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function isXml10Control(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31);
}

/** Escapes a string for use as XML text content. */
export function escapeXmlText(value: string): string {
  // XML 1.0 forbids C0 controls other than TAB, LF and CR. Drop them rather
  // than emitting an archive that downstream XML parsers cannot open.
  return [...value]
    .filter((char) => !isXml10Control(char))
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes a string for use inside a double-quoted XML attribute. */
export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Validates an element or attribute name. */
function checkName(name: string, kind: 'element' | 'attribute'): void {
  if (!NAME_PATTERN.test(name)) {
    throw new RangeError(`Invalid XML ${kind} name: ${JSON.stringify(name)}`);
  }
}

/** Formats one attribute value, rejecting non-finite numbers. */
function formatAttributeValue(name: string, value: XmlAttributeValue): string {
  if (typeof value === 'string') return escapeXmlAttribute(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!Number.isFinite(value)) {
    throw new RangeError(`XML attribute "${name}" must be finite, got ${value}`);
  }
  return String(value);
}

/** Serializes one element (recursively) into the output line list. */
function serializeElement(element: XmlElement, indent: string, out: string[]): void {
  checkName(element.name, 'element');
  const parts: string[] = [element.name];
  for (const [name, value] of Object.entries(element.attributes ?? {})) {
    if (value === undefined) continue;
    checkName(name, 'attribute');
    parts.push(`${name}="${formatAttributeValue(name, value)}"`);
  }
  const open = parts.join(' ');
  const children = element.children ?? [];
  if (children.length > 0 && element.text !== undefined) {
    throw new RangeError(`XML element <${element.name}> cannot carry both children and text`);
  }
  if (children.length > 0) {
    out.push(`${indent}<${open}>`);
    for (const child of children) {
      serializeElement(child, `${indent}  `, out);
    }
    out.push(`${indent}</${element.name}>`);
  } else if (element.text !== undefined && element.text.length > 0) {
    out.push(`${indent}<${open}>${escapeXmlText(element.text)}</${element.name}>`);
  } else {
    out.push(`${indent}<${open}/>`);
  }
}

/**
 * Serializes a root element into a complete XML document string.
 *
 * @param root Document root element.
 * @returns XML text including the declaration, terminated by a newline.
 * @throws RangeError on invalid names, non-finite numeric attribute values,
 *   or an element carrying both children and text.
 */
export function serializeXml(root: XmlElement): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serializeElement(root, '', out);
  return `${out.join('\n')}\n`;
}
