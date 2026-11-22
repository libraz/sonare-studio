import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Stem separation: Split stems turns a short clip into harmonic, percussive and
 * residual tracks that sum back to the source and carry its content. Runs in
 * its own browser context so the new tracks do not reach later scenarios.
 */
export const name = 'stem-separation';

const SAMPLE_RATE = 44100;
const SECONDS = 3;
const TONE_HZ = 440;
const TONE_AMPLITUDE = 0.4;
const CLICK_EVERY_SECONDS = 0.5;
const CLICK_SECONDS = 0.008;
const SOURCE_NAME = 'stem-source';

/** Largest error RMS, relative to the source RMS, the three stems may sum to. */
const MAX_SUM_ERROR_RATIO = 0.001;

/** A held tone with a short noise burst every half second. */
function sourceWavBytes() {
  const frames = SECONDS * SAMPLE_RATE;
  const data = Buffer.alloc(frames * 2);
  let seed = 12345;
  for (let i = 0; i < frames; i++) {
    let sample = Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * TONE_AMPLITUDE;
    const phase = (i / SAMPLE_RATE) % CLICK_EVERY_SECONDS;
    if (i / SAMPLE_RATE >= CLICK_EVERY_SECONDS && phase < CLICK_SECONDS) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sample += (seed / 0xffffffff - 0.5) * 1.2;
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2);
  }
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

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);

    await page.locator('[id="editor-dock-tab-media"]').click();
    await page.locator('.media-browser .file-input').waitFor({ state: 'attached' });
    await page.setInputFiles('.media-browser .file-input', {
      name: `${SOURCE_NAME}.wav`,
      mimeType: 'audio/wav',
      buffer: sourceWavBytes(),
    });
    const asset = page.locator('.media-browser .asset-row', { hasText: SOURCE_NAME }).first();
    await asset.waitFor({ state: 'visible', timeout: 30000 });
    await asset.locator('.add-button').click();
    await page.waitForFunction(() => window.__sonareDebug.audioClipCount() === 1, null, {
      timeout: 30000,
    });
    const sourceClipId = await page.evaluate(
      () => window.__sonareDebug.clipRanges().find((clip) => clip.kind === 'audio').id,
    );
    await page.evaluate((id) => window.__sonareDebug.selectClip(id), sourceClipId);

    const startedAt = Date.now();
    await page.locator('button.section-detect', { hasText: /^\s*Split stems\s*$/ }).click();
    // The separation runs on the page's own thread, so the click itself can outlast the default wait.
    await page
      .locator('.context-menu-item[data-menu-item-id="split-stems-hpss"]')
      .click({ timeout: 180000 });
    await page.waitForFunction(() => window.__sonareDebug.audioClipCount() === 4, null, {
      timeout: 120000,
    });
    console.info(`stems separated in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);

    const stemClipIds = await page.evaluate(
      (sourceId) =>
        window.__sonareDebug
          .clipRanges()
          .filter((clip) => clip.kind === 'audio' && clip.id !== sourceId)
          .map((clip) => clip.id),
      sourceClipId,
    );
    const stats = await page.evaluate(
      ([source, stems]) => window.__sonareDebug.stemSumStats(source, stems),
      [sourceClipId, stemClipIds],
    );
    const ratio = stats.errorRms / stats.sourceRms;
    console.info(
      `stems: source rms ${stats.sourceRms.toFixed(4)}, stem rms ` +
        `${stats.stemRms.map((value) => value.toFixed(4)).join('/')}, ` +
        `sum error ${(ratio * 100).toFixed(3)}% of source`,
    );
    if (stemClipIds.length !== 3) fail(`expected three stem clips, got ${stemClipIds.length}`);
    if (stats.stemFrames.some((frames) => frames !== stats.frames)) {
      fail(`stem lengths ${stats.stemFrames} differ from the source's ${stats.frames} frames`);
    }
    if (stats.stemRms.some((value) => !(value > 1e-4))) {
      fail(`a stem is silent: rms ${stats.stemRms}`);
    }
    if (!(ratio < MAX_SUM_ERROR_RATIO)) {
      fail(
        `stems sum ${(ratio * 100).toFixed(2)}% away from the source, ` +
          `promised under ${MAX_SUM_ERROR_RATIO * 100}%`,
      );
    }

    // The stems are audible through the engine's own render, not just stored.
    const rendered = await page.evaluate(() =>
      window.__sonareDebug.exportProbe(false, { startPpq: 0, endPpq: 4 }, true),
    );
    const quiet = (rendered.stems ?? []).filter((stem) => !(stem.peakDb > -60));
    if ((rendered.stems ?? []).length < 4 || quiet.length > 0) {
      fail(`rendered stems are missing or silent: ${JSON.stringify(rendered.stems)}`);
    }
  } finally {
    await context.close();
  }
}
