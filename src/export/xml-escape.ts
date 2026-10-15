/**
 * XML 1.0 escaping shared by the DAWproject and MusicXML writers. Characters
 * outside the XML 1.0 `Char` production are replaced with U+FFFD, so the
 * output always parses.
 */

const INVALID_CHAR = '[^\\t\\n\\r\\u{20}-\\u{D7FF}\\u{E000}-\\u{FFFD}\\u{10000}-\\u{10FFFF}]';

const MARKUP_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Attribute-value normalization turns literal TAB/LF/CR into spaces; character references survive it. */
const WHITESPACE_REFERENCES: Readonly<Record<string, string>> = {
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

function escaper(
  specials: string,
  replacements: Readonly<Record<string, string>>,
): (value: string) => string {
  const pattern = new RegExp(`[${specials}]|${INVALID_CHAR}`, 'gu');
  return (value) => value.replace(pattern, (char) => replacements[char] ?? '\ufffd');
}

/** Escapes `&`, `<` and `>` for XML text content. */
export const escapeXmlText = escaper('&<>', MARKUP_ESCAPES);

/** Escapes all five XML-reserved characters; quotes are harmless in text, so it serves both. */
export const escapeXmlMarkup = escaper('&<>"\'', MARKUP_ESCAPES);

/** Escapes a string for a double-quoted attribute, keeping TAB/LF/CR through attribute normalization. */
export const escapeXmlAttribute = escaper('&<>"\'\\t\\n\\r', {
  ...MARKUP_ESCAPES,
  ...WHITESPACE_REFERENCES,
});
