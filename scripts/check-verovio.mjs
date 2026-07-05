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

const wholeNoteMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
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

const tripletMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Triplet Check</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>960</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>1</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">begin</beam>
        <notations><tuplet type="start"/></notations>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">continue</beam>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">end</beam>
        <notations><tuplet type="stop"/></notations>
      </note>
    </measure>
  </part>
</score-partwise>
`;

const tripletRestMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Triplet Rest Check</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>960</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>1</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <rest/>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">begin</beam>
        <notations><tuplet type="start"/></notations>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">continue</beam>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">end</beam>
        <notations><tuplet type="stop"/></notations>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">begin</beam>
        <notations><tuplet type="start"/></notations>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">continue</beam>
      </note>
      <note>
        <rest/>
        <duration>320</duration>
        <voice>1</voice>
        <type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">end</beam>
        <notations><tuplet type="stop"/></notations>
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

function assertRenderable(label, musicXml, expectedOnsets) {
  assert.equal(toolkit.loadData(musicXml), 1, `${label}: loadData failed: ${toolkit.getLog()}`);

  const pageCount = toolkit.getPageCount();
  assert.ok(pageCount >= 1, `${label}: expected >= 1 page, got ${pageCount}`);

  const svg = toolkit.renderToSVG(1);
  assert.ok(svg.includes('<svg'), `${label}: renderToSVG returned no <svg> root`);
  assert.ok(svg.includes('class="note"'), `${label}: rendered SVG contains no note element`);

  const timemap = toolkit.renderToTimemap({ includeMeasures: true });
  assert.ok(Array.isArray(timemap) && timemap.length > 0, `${label}: timemap is empty`);
  const noteOnsets = timemap.filter((entry) => Array.isArray(entry.on) && entry.on.length > 0);
  assert.ok(noteOnsets.length > 0, `${label}: timemap has no note onsets`);
  if (expectedOnsets !== undefined) {
    assert.equal(noteOnsets.length, expectedOnsets, `${label}: unexpected note onset count`);
  }

  // The note id in the timemap must appear as an SVG element id (same load).
  const noteId = noteOnsets[0].on[0];
  assert.ok(svg.includes(`id="${noteId}"`), `${label}: timemap note id ${noteId} not found in SVG`);
  console.info(
    `OK ${label}: ${pageCount} page(s), svg ${svg.length} chars, timemap ${timemap.length} entries, note id ${noteId} present in SVG`,
  );
}

assertRenderable('whole-note', wholeNoteMusicXml, 1);
assertRenderable('triplet', tripletMusicXml, 3);
assertRenderable('triplet-rest', tripletRestMusicXml, 4);

toolkit.destroy();
