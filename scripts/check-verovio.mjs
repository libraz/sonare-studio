#!/usr/bin/env node
/**
 * Manual sanity check for the Verovio toolkit (Node, no vitest).
 *
 * Loads the same package entry points the worker uses, renders a minimal
 * MusicXML document, and asserts the SVG and timemap are non-empty.
 *
 * Run with: node scripts/check-verovio.mjs
 */

import assert from 'node:assert/strict';
import { VerovioToolkit } from 'verovio/esm';
import createVerovioModule from 'verovio/wasm';

const musicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Check</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>
`;

const module = await createVerovioModule();
const toolkit = new VerovioToolkit(module);
console.info(`verovio version: ${toolkit.getVersion()}`);

toolkit.setOptions({
  inputFrom: 'xml',
  adjustPageHeight: true,
  svgViewBox: true,
  header: 'none',
  footer: 'none',
});

assert.equal(toolkit.loadData(musicXml), 1, `loadData failed: ${toolkit.getLog()}`);

const pageCount = toolkit.getPageCount();
assert.ok(pageCount >= 1, `expected >= 1 page, got ${pageCount}`);

const svg = toolkit.renderToSVG(1);
assert.ok(svg.includes('<svg'), 'renderToSVG returned no <svg> root');
assert.ok(svg.includes('class="note"'), 'rendered SVG contains no note element');

const timemap = toolkit.renderToTimemap({ includeMeasures: true });
assert.ok(Array.isArray(timemap) && timemap.length > 0, 'timemap is empty');
assert.ok(
  timemap.some((entry) => Array.isArray(entry.on) && entry.on.length > 0),
  'timemap has no note onsets',
);

// The note id in the timemap must appear as an SVG element id (same load).
const noteId = timemap.find((entry) => entry.on?.length > 0).on[0];
assert.ok(svg.includes(`id="${noteId}"`), `timemap note id ${noteId} not found in SVG`);

toolkit.destroy();
console.info(
  `OK: ${pageCount} page(s), svg ${svg.length} chars, timemap ${timemap.length} entries, note id ${noteId} present in SVG`,
);
