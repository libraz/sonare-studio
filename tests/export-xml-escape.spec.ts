import { describe, expect, it } from 'vitest';
import { serializeXml } from '@/export/dawproject/xml';
import { escapeXml } from '@/notation/musicxml-xml';

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

describe('XML escaping shared by DAWproject and MusicXML', () => {
  it('replaces characters XML 1.0 forbids with U+FFFD in both writers', () => {
    const dirty = 'a\u0000b\u0008c\ud800d\uffffe\t\n\u{1f600}';
    const clean = 'a\ufffdb\ufffdc\ufffdd\ufffde\t\n\u{1f600}';
    const dawproject = serializeXml({ name: 'A', text: dirty });
    expect(parse(dawproject).documentElement.textContent).toBe(clean);
    expect(escapeXml(dirty)).toBe(clean);
  });

  it('round-trips tab and line breaks inside a DAWproject attribute', () => {
    const value = 'one\ttwo\nthree\rfour "q" & <x>';
    const xml = serializeXml({ name: 'A', attributes: { name: value } });
    expect(parse(xml).documentElement.getAttribute('name')).toBe(value);
  });
});
