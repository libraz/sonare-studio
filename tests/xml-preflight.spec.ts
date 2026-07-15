import { describe, expect, it } from 'vitest';
import { preflightXmlBytes, preflightXmlDocument, XmlPreflightError } from '@/lib/xml-preflight';

describe('XML preflight', () => {
  it('rejects byte length before DOM allocation', () => {
    expect(() => preflightXmlBytes(11, 'score.xml', { maxBytes: 10 })).toThrow(XmlPreflightError);
  });

  it('rejects parsed node counts before semantic traversal', () => {
    const doc = new DOMParser().parseFromString('<score><part/><part/></score>', 'application/xml');
    expect(() => preflightXmlDocument(doc, 'score.xml', { maxElements: 2 })).toThrow(
      /element XML limit/,
    );
  });
});
