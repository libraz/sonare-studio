#!/usr/bin/env node
/**
 * Generates small manual-verification artifacts.
 *
 * Output:
 * - triplet.musicxml: 3:2 eighth-note tuplet for notation-application import checks.
 * - comp-hardcut.wav: +1 -> -1 edit with an intentional hard discontinuity.
 * - comp-crossfade.wav: same edit smoothed by a short linear crossfade.
 * - manifest.json: machine-readable metrics and intended checks.
 *
 * Run with: node scripts/manual-check-artifacts.mjs [output-dir]
 * The output directory defaults to sonare-manual-check under the OS temp directory.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outDir = process.argv[2] ? resolve(process.argv[2]) : join(tmpdir(), 'sonare-manual-check');
mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 48_000;
const SECONDS = 1;
const FRAMES = SAMPLE_RATE * SECONDS;
const BOUNDARY = Math.floor(FRAMES / 2);
const CROSSFADE_FRAMES = 960; // 20 ms at 48 kHz.

function encodeWav16Mono(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.min(1, Math.max(-1, samples[i]));
    data.writeInt16LE(Math.round(clipped * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function maxAdjacentStep(samples) {
  let max = 0;
  for (let i = 1; i < samples.length; i += 1) {
    max = Math.max(max, Math.abs(samples[i] - samples[i - 1]));
  }
  return max;
}

function hardCutSamples() {
  const samples = new Float32Array(FRAMES);
  samples.fill(0.8, 0, BOUNDARY);
  samples.fill(-0.8, BOUNDARY);
  return samples;
}

function crossfadeSamples() {
  const samples = hardCutSamples();
  const start = BOUNDARY - Math.floor(CROSSFADE_FRAMES / 2);
  for (let i = 0; i < CROSSFADE_FRAMES; i += 1) {
    const t = i / (CROSSFADE_FRAMES - 1);
    samples[start + i] = 0.8 * (1 - t) + -0.8 * t;
  }
  return samples;
}

const tripletMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Triplet example</part-name></score-part>
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
        <duration>320</duration><voice>1</voice><type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">begin</beam><notations><tuplet type="start"/></notations>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>320</duration><voice>1</voice><type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">continue</beam>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>320</duration><voice>1</voice><type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <beam number="1">end</beam><notations><tuplet type="stop"/></notations>
      </note>
    </measure>
  </part>
</score-partwise>
`;

const hard = hardCutSamples();
const smooth = crossfadeSamples();
const hardStep = maxAdjacentStep(hard);
const smoothStep = maxAdjacentStep(smooth);
if (!(hardStep > 1.5)) throw new Error(`Unexpected hard-cut step: ${hardStep}`);
if (!(smoothStep < 0.01)) throw new Error(`Unexpected crossfade step: ${smoothStep}`);

writeFileSync(join(outDir, 'triplet.musicxml'), tripletMusicXml);
writeFileSync(join(outDir, 'comp-hardcut.wav'), encodeWav16Mono(hard, SAMPLE_RATE));
writeFileSync(join(outDir, 'comp-crossfade.wav'), encodeWav16Mono(smooth, SAMPLE_RATE));
writeFileSync(
  join(outDir, 'manifest.json'),
  `${JSON.stringify(
    {
      generatedBy: 'scripts/manual-check-artifacts.mjs',
      sampleRate: SAMPLE_RATE,
      artifacts: {
        'triplet.musicxml': {
          purpose:
            'Open in a notation application and verify a 3:2 eighth-note tuplet renders as a triplet bracket.',
          expectedTimeModificationCount: 3,
          expectedTupletBrackets: ['start', 'stop'],
        },
        'comp-hardcut.wav': {
          purpose: 'Reference discontinuity for the comp-boundary click case.',
          maxAdjacentStep: hardStep,
        },
        'comp-crossfade.wav': {
          purpose: 'Expected smoothed edit for listening comparison against the hard cut.',
          crossfadeFrames: CROSSFADE_FRAMES,
          maxAdjacentStep: smoothStep,
        },
      },
    },
    null,
    2,
  )}\n`,
);

console.info(`Wrote manual-check artifacts to ${outDir}`);
console.info(`hard max adjacent step: ${hardStep.toFixed(6)}`);
console.info(`crossfade max adjacent step: ${smoothStep.toFixed(6)}`);
