import { describe, expect, it } from 'vitest';
import {
  preflightXmlBytes,
  preflightXmlDocument,
  preflightXmlMarkupDepth,
  XmlPreflightError,
} from '@/lib/xml-preflight';

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

  it('rejects deep markup before DOM allocation while ignoring comments and CDATA', () => {
    const deep = `${'<node>'.repeat(4)}${'</node>'.repeat(4)}`;
    expect(() => preflightXmlMarkupDepth(deep, 'score.xml', { maxDepth: 3 })).toThrow(
      /depth XML limit/,
    );
    expect(() =>
      preflightXmlMarkupDepth(
        '<root><!-- <not-a-node> --><![CDATA[<still-not-a-node>]]></root>',
        'x',
      ),
    ).not.toThrow();
  });
});
