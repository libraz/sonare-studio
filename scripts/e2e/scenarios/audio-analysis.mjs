import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Audio analysis of clips with known answers, read back from the UI: the tempo
 * list's Detect from clip on a 100 BPM click track, the chord list's Detect
 * from clip on four two-second block chords, and the arrangement's section
 * Detect on two ten-second parts of clearly different material.
 */
export const name = 'audio-analysis';

const SAMPLE_RATE = 48000;
/** The empty template's tempo: one second is two PPQ. */
const PROJECT_BPM = 120;
const PPQ_PER_SECOND = PROJECT_BPM / 60;

const CLICK_BPM = 100;
const CLICK_BEATS = 32;
/**
 * Beats come off a 512-sample hop grid, so each sits up to half a hop off its
 * true time; the least-squares period of n beats is then off by at most
 * (hop / 2) * sum|i - mean| / sum (i - mean)^2.
 */
const BEAT_HOP_SAMPLES = 512;

/** C, F, G, Am as root-position four-note voicings. */
const CHORDS = [
  { name: 'C', notes: [48, 60, 64, 67] },
  { name: 'F', notes: [53, 60, 65, 69] },
  { name: 'G', notes: [55, 59, 62, 67] },
  { name: 'Am', notes: [45, 60, 64, 69] },
];
const CHORD_SECONDS = 2;
/** Chord boundaries sit on the detector's chroma frames, four 512-sample hops apart. */
const CHORD_FRAME_SAMPLES = 4 * 512;

const PART_SECONDS = 10;
/** The ±0.5 s boundary hit window of the MIREX section-boundary metric (HR.5F). */
const SECTION_BOUNDARY_TOLERANCE_SECONDS = 0.5;

const midiHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Mono 16-bit PCM WAV bytes. */
function wavBytes(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Each chord held for CHORD_SECONDS, three harmonics per note, 5 ms edges. */
function chordSamples() {
  const per = CHORD_SECONDS * SAMPLE_RATE;
  const edge = 0.005 * SAMPLE_RATE;
  const out = new Float32Array(per * CHORDS.length);
  CHORDS.forEach((chord, k) => {
    for (let i = 0; i < per; i++) {
      let value = 0;
      for (const note of chord.notes) {
        for (let h = 1; h <= 3; h++) {
          value += Math.sin((2 * Math.PI * midiHz(note) * h * i) / SAMPLE_RATE) / h;
        }
      }
      out[k * per + i] = value * Math.min(1, i / edge, (per - i) / edge) * 0.12;
    }
  });
  return out;
}

/** A held C major triad, then a low A with noise bursts on every half second. */
function sectionSamples() {
  const out = new Float32Array(2 * PART_SECONDS * SAMPLE_RATE);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    if (t < PART_SECONDS) {
      for (const note of [60, 64, 67]) value += Math.sin(2 * Math.PI * midiHz(note) * t) * 0.15;
    } else {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      value += (seed / 0xffffffff - 0.5) * 0.6 * Math.exp(-((t - PART_SECONDS) % 0.5) * 30);
      for (const note of [45, 57]) value += Math.sin(2 * Math.PI * midiHz(note) * t) * 0.2;
    }
    out[i] = value;
  }
  return out;
}

/** "bar.beat[.fraction]" in 4/4 as PPQ. */
function barBeatToPpq(text) {
  const [bar, beat, fraction] = text.trim().split('.');
  return (Number(bar) - 1) * 4 + Number(`${beat ?? 1}.${fraction ?? 0}`) - 1;
}

async function importAndAdd(page, fileName, samples) {
  await page.setInputFiles('.media-browser .file-input', {
    name: `${fileName}.wav`,
    mimeType: 'audio/wav',
    buffer: wavBytes(samples),
  });
  const row = page.locator('.media-browser .asset-row', { hasText: fileName }).first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  const before = await page.evaluate(() => window.__sonareDebug.audioClipCount());
  await row.locator('.add-button').click();
  await page.waitForFunction(
    (count) => window.__sonareDebug.audioClipCount() === count + 1,
    before,
    { timeout: 30000 },
  );
  return page.evaluate(() => {
    const clips = window.__sonareDebug.clipRanges().filter((clip) => clip.kind === 'audio');
    return clips[clips.length - 1];
  });
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);

    const clickClipId = await page.evaluate(
      async ([bpm, beats]) => {
        const trackId = window.__sonareDebug.addAudioTrack('Clicks');
        return window.__sonareDebug.addClickClip(trackId, beats, bpm, 0);
      },
      [CLICK_BPM, CLICK_BEATS],
    );
    await page.locator('[id="editor-dock-tab-media"]').click();
    await page.locator('.media-browser .file-input').waitFor({ state: 'attached' });
    const chordClip = await importAndAdd(page, 'block-chords', chordSamples());
    const sectionClip = await importAndAdd(page, 'two-parts', sectionSamples());

    // Tempo: Lists > Tempo > Detect from clip fills the 1.1 row's BPM.
    await page.evaluate((id) => window.__sonareDebug.selectClip(id), clickClipId);
    await page.locator('[id="editor-dock-tab-lists"]').click();
    await page.locator('.list-tab[data-tab-id="tempo"]').click();
    const tempoEditor = page.locator('.list-editor:visible');
    const bpmCell = tempoEditor.getByRole('spinbutton', { name: 'Tempo entry 1 BPM' });
    const shownBefore = await bpmCell.inputValue();
    await tempoEditor.getByRole('button', { name: 'Detect from clip', exact: true }).click();
    await page.waitForFunction(
      (before) => {
        const cell = document.querySelector('.list-editor input[aria-label="Tempo entry 1 BPM"]');
        return cell instanceof HTMLInputElement && cell.value !== before;
      },
      shownBefore,
      { timeout: 60000 },
    );
    const detectedBpm = Number(await bpmCell.inputValue());
    const n = CLICK_BEATS;
    const mean = (n - 1) / 2;
    let absSum = 0;
    let squareSum = 0;
    for (let i = 0; i < n; i++) {
      absSum += Math.abs(i - mean);
      squareSum += (i - mean) ** 2;
    }
    const periodError = ((BEAT_HOP_SAMPLES / 2 / SAMPLE_RATE) * absSum) / squareSum;
    const bpmTolerance = CLICK_BPM - 60 / (60 / CLICK_BPM + periodError);
    if (!(Math.abs(detectedBpm - CLICK_BPM) <= bpmTolerance)) {
      fail(
        `tempo detection shows ${detectedBpm} BPM for a ${CLICK_BPM} BPM click track ` +
          `(tolerance ±${bpmTolerance.toFixed(3)})`,
      );
    }

    // Chords: Lists > Chords > Detect from clip lists the progression.
    await page.evaluate((id) => window.__sonareDebug.selectClip(id), chordClip.id);
    await page.locator('.list-tab[data-tab-id="chords"]').click();
    const chordEditor = page.locator('.list-editor:visible');
    await chordEditor.getByRole('button', { name: 'Detect from clip', exact: true }).click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('.list-editor tr:not(.group-header-row) .cell-name').length >=
        count,
      CHORDS.length,
      { timeout: 60000 },
    );
    const chordRows = await chordEditor
      .locator('tbody tr:not(.group-header-row)')
      .evaluateAll((rows) =>
        rows.map((row) => ({
          name: row.querySelector('.cell-name')?.textContent?.trim() ?? '',
          position: row.querySelector('input.cell-position')?.value ?? '',
        })),
      );
    const frameTolerancePpq = (CHORD_FRAME_SAMPLES / SAMPLE_RATE) * PPQ_PER_SECOND;
    const chordProblems = [];
    if (chordRows.length !== CHORDS.length) {
      chordProblems.push(`${chordRows.length} rows for ${CHORDS.length} chords`);
    }
    CHORDS.forEach((chord, index) => {
      const row = chordRows[index];
      const expectedPpq = chordClip.startPpq + index * CHORD_SECONDS * PPQ_PER_SECOND;
      if (!row || row.name !== chord.name) {
        chordProblems.push(`row ${index + 1} reads ${row?.name ?? 'nothing'}, not ${chord.name}`);
      } else if (!(Math.abs(barBeatToPpq(row.position) - expectedPpq) <= frameTolerancePpq)) {
        chordProblems.push(
          `${chord.name} starts at ${row.position}, expected ${expectedPpq} ppq ` +
            `±${frameTolerancePpq.toFixed(3)}`,
        );
      }
    });
    if (chordProblems.length > 0) {
      fail(`chord detection: ${chordProblems.join('; ')} (${JSON.stringify(chordRows)})`);
    }

    // Sections: the arrangement's Sections > Detect draws one band per part.
    await page.evaluate((id) => window.__sonareDebug.selectClip(id), sectionClip.id);
    await page.locator('button.section-detect', { hasText: /^\s*Detect\s*$/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.section-lane .section-band').length > 0,
      null,
      { timeout: 60000 },
    );
    const lane = await page.evaluate(() => {
      const wrapper = document.querySelector('.section-lane');
      const range = wrapper?.__vueParentComponent?.props?.range;
      if (!wrapper || !range) return null;
      return {
        visiblePpq: [range.xToPpq(0), range.xToPpq(range.widthPx)],
        bands: [...wrapper.querySelectorAll('.section-band')].map((band) => {
          const left = Number.parseFloat(band.style.left);
          const width = Number.parseFloat(band.style.width);
          return {
            name: band.querySelector('.section-name')?.textContent?.trim() ?? '',
            startPpq: range.xToPpq(left),
            endPpq: range.xToPpq(left + width),
          };
        }),
      };
    });
    const toleranceSectionPpq = SECTION_BOUNDARY_TOLERANCE_SECONDS * PPQ_PER_SECOND;
    const boundaryPpq = sectionClip.startPpq + PART_SECONDS * PPQ_PER_SECOND;
    const bands = lane?.bands ?? [];
    if (
      bands.length !== 2 ||
      !(Math.abs(bands[0].startPpq - sectionClip.startPpq) <= toleranceSectionPpq) ||
      !(Math.abs(bands[0].endPpq - boundaryPpq) <= toleranceSectionPpq) ||
      !(Math.abs(bands[1].startPpq - boundaryPpq) <= toleranceSectionPpq)
    ) {
      fail(
        `section detection: expected two bands meeting at ${boundaryPpq} ppq ` +
          `±${toleranceSectionPpq}, lane shows ${JSON.stringify(lane)}`,
      );
    }

    console.info(
      `audio analysis: tempo ${detectedBpm} BPM (±${bpmTolerance.toFixed(3)}), chords ` +
        `${JSON.stringify(chordRows)} (±${frameTolerancePpq.toFixed(3)} ppq), sections ` +
        `${JSON.stringify(bands)}`,
    );
  } finally {
    await context.close();
  }
}
