import { describe, expect, it } from 'vitest';
import { serializeXml, type XmlElement } from '@/export/dawproject/xml';
import { escapeXmlAttribute, escapeXmlText } from '@/export/xml-escape';

describe('escapeXmlText', () => {
  it('escapes markup characters', () => {
    expect(escapeXmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('leaves quotes alone in text content', () => {
    expect(escapeXmlText(`"quoted" and 'single'`)).toBe(`"quoted" and 'single'`);
  });

  it('replaces XML 1.0-invalid controls while preserving tab and line breaks', () => {
    expect(escapeXmlText('a\u0000b\u0008c\t d\ne\rf\u001f')).toBe(
      'a\ufffdb\ufffdc\t d\ne\rf\ufffd',
    );
  });
});

describe('escapeXmlAttribute', () => {
  it('escapes markup characters and both quote styles', () => {
    expect(escapeXmlAttribute(`<a & "b" & 'c'>`)).toBe(
      '&lt;a &amp; &quot;b&quot; &amp; &apos;c&apos;&gt;',
    );
  });
});

describe('serializeXml', () => {
  it('writes a declaration and a self-closing empty root', () => {
    expect(serializeXml({ name: 'Project' })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Project/>\n',
    );
  });

  it('indents nested children by two spaces per level', () => {
    const root: XmlElement = {
      name: 'A',
      children: [{ name: 'B', children: [{ name: 'C' }] }],
    };
    expect(serializeXml(root)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<A>\n  <B>\n    <C/>\n  </B>\n</A>\n',
    );
  });

  it('writes text bodies inline and escapes them', () => {
    const xml = serializeXml({ name: 'Title', text: 'Tom & <Jerry>' });
    expect(xml).toContain('<Title>Tom &amp; &lt;Jerry&gt;</Title>');
  });

  it('self-closes elements with an empty text body', () => {
    expect(serializeXml({ name: 'Title', text: '' })).toContain('<Title/>');
  });

  it('formats numeric and boolean attributes and skips undefined ones', () => {
    const xml = serializeXml({
      name: 'Clip',
      attributes: { time: 1.5, loaded: true, muted: false, color: undefined },
    });
    expect(xml).toContain('<Clip time="1.5" loaded="true" muted="false"/>');
    expect(xml).not.toContain('color');
  });

  it('escapes string attribute values', () => {
    const xml = serializeXml({ name: 'Track', attributes: { name: 'A "<B>" & \'C\'' } });
    expect(xml).toContain('name="A &quot;&lt;B&gt;&quot; &amp; &apos;C&apos;"');
  });

  it('rejects non-finite numeric attribute values', () => {
    expect(() => serializeXml({ name: 'X', attributes: { v: Number.NaN } })).toThrow(RangeError);
    expect(() => serializeXml({ name: 'X', attributes: { v: Number.POSITIVE_INFINITY } })).toThrow(
      RangeError,
    );
  });

  it('rejects invalid element and attribute names', () => {
    expect(() => serializeXml({ name: 'bad name' })).toThrow(RangeError);
    expect(() => serializeXml({ name: '1Leading' })).toThrow(RangeError);
    expect(() => serializeXml({ name: 'X', attributes: { 'bad attr': 1 } })).toThrow(RangeError);
  });

  it('rejects elements carrying both children and text', () => {
    expect(() => serializeXml({ name: 'X', text: 'body', children: [{ name: 'Y' }] })).toThrow(
      RangeError,
    );
  });

  it('round-trips hostile content through a DOM parser', () => {
    const xml = serializeXml({
      name: 'Root',
      attributes: { name: 'a&b<c>"d"\'e\'' },
      children: [{ name: 'Child', text: ']]> & <tag>' }],
    });
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.documentElement.getAttribute('name')).toBe('a&b<c>"d"\'e\'');
    expect(parsed.documentElement.querySelector('Child')?.textContent).toBe(']]> & <tag>');
  });
});
