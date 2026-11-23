import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';
import { untilDoneAcceptingConfirms } from '../harness.mjs';

/**
 * Loudness target: with the Streaming preset and a typed target LUFS, the
 * export dialog's loudness report shows the loudness the mastering chain
 * reported for its preset, and the downloaded WAV, decoded and measured with
 * the same meter, matches it. The programme is a steady tone with headroom,
 * and its exported true peak stays far enough under the preset's ceiling that
 * the true-peak limiter has nothing to reduce.
 */
export const name = 'loudness';

const TRACK = 'Loudness tone';
const TARGET_LUFS = -18;
/** The file and the chain's report are the same samples through the same meter. */
const FILE_TOLERANCE_LU = 0.1;
/** Provisional bound on the chain's output against its target. */
const TARGET_TOLERANCE_LU = 0.5;
/** A true peak this far under the ceiling leaves the true-peak limiter nothing to reduce. */
const LIMITER_HEADROOM_DB = 6;

let sonare = null;
async function libsonare() {
  if (!sonare) {
    sonare = await import('@libraz/libsonare');
    await sonare.init();
  }
  return sonare;
}

/** Planar float channels of a PCM WAV (16, 24 or 32-bit integer). */
function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('the download is not a WAV');
  let format = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('the WAV has no fmt chunk before its data');
      const width = format.bits / 8;
      const frames = Math.floor(length / (width * format.channels));
      const scale = 2 ** (format.bits - 1);
      const planes = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < format.channels; channel += 1) {
          const at = body + (frame * format.channels + channel) * width;
          let value;
          if (width === 2) value = view.getInt16(at, true);
          else if (width === 3) value = (view.getInt8(at + 2) << 16) | view.getUint16(at, true);
          else value = view.getInt32(at, true);
          planes[channel][frame] = value / scale;
        }
      }
      return { channels: planes, sampleRate: format.sampleRate };
    }
    offset = body + length + (length % 2);
  }
  throw new Error('the WAV has no data chunk');
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.evaluate(async (trackName) => {
      const id = window.__sonareDebug.addAudioTrack(trackName);
      await window.__sonareDebug.addToneClip(id, 10, 440, 0.1, 0);
    }, TRACK);
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });

    // Streaming preset with a typed target, from the Mastering tab.
    await page.click('.dock-tabs button:has-text("Mastering")');
    await page.click('.mastering-panel .preset-button');
    await page.waitForSelector('.mastering-panel .preset-menu', { timeout: 10000 });
    await page
      .locator('.mastering-panel .preset-item')
      .filter({ hasText: 'Streaming' })
      .first()
      .click();
    const target = page.locator(
      '.mastering-panel [data-preset-control="loudness.targetLufs"] input',
    );
    await target.fill(String(TARGET_LUFS));
    await target.press('Tab');
    if (Number.parseFloat(await target.inputValue()) !== TARGET_LUFS) {
      fail(`the target LUFS field did not take ${TARGET_LUFS}: ${await target.inputValue()}`);
      return;
    }
    const ceilingDbtp = Number.parseFloat(
      await page
        .locator('.mastering-panel [data-preset-control="loudness.ceilingDbtp"] input')
        .inputValue(),
    );

    // Export through the dialog with its defaults: WAV, master chain on, no normalization.
    await page.click('.app-menubar__trigger:has-text("File")');
    await page
      .locator('.menu-panel [role="menuitem"]')
      .filter({ hasText: /^Export Audio\.\.\.$/ })
      .click();
    await page.waitForSelector('.modal-card .export-button:not([disabled])', { timeout: 10000 });
    if (
      (await page.locator('.modal-card .normalize-loudness').getAttribute('aria-pressed')) !==
      'false'
    ) {
      fail('loudness normalization is on by default; the file would not be the chain output');
      return;
    }
    await page.click('.modal-card .export-button');
    await untilDoneAcceptingConfirms(
      page,
      async () => (await page.locator('.modal-card .export-report').count()) > 0,
      120000,
    );
    const row = page.locator('.modal-card .report-mastering-lufs');
    if ((await row.count()) !== 1) {
      fail('the loudness report has no mastering preset output row');
      return;
    }
    const reported = await row.evaluate((element) => ({
      text: element.textContent?.trim() ?? '',
      outputLufs: Number(element.dataset.lufs),
      targetLimited: element.dataset.targetLimited === 'true',
    }));
    const truePeakDbtp = Number.parseFloat(
      ((await page.locator('.modal-card .report-true-peak').textContent()) ?? '').replace('−', '-'),
    );

    const wav = await page.evaluate(async () => {
      const download = window.__sonareDebug.lastDownload();
      if (!download) return null;
      const bytes = new Uint8Array(await download.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { filename: download.filename, base64: btoa(binary) };
    });
    if (!wav?.filename.endsWith('.wav')) {
      fail(`no WAV download was captured: ${wav?.filename ?? null}`);
      return;
    }
    const decoded = decodeWav(new Uint8Array(Buffer.from(wav.base64, 'base64')));
    const { lufsMultichannel } = await libsonare();
    const fileLufs = lufsMultichannel(decoded).integratedLufs;

    const fileGap = fileLufs - reported.outputLufs;
    const targetGap = reported.outputLufs - TARGET_LUFS;
    if (!Number.isFinite(fileGap) || Math.abs(fileGap) > FILE_TOLERANCE_LU) {
      fail(
        `the exported file measures ${fileLufs.toFixed(2)} LUFS, the chain reported ` +
          `${reported.outputLufs.toFixed(2)} LUFS`,
      );
    }
    if (
      reported.targetLimited ||
      !Number.isFinite(truePeakDbtp) ||
      !(truePeakDbtp <= ceilingDbtp - LIMITER_HEADROOM_DB)
    ) {
      fail(
        `the limiter may have moved the level: target limited ${reported.targetLimited}, ` +
          `true peak ${truePeakDbtp} dBTP against a ${ceilingDbtp} dBTP ceiling`,
      );
    }
    if (!Number.isFinite(targetGap) || Math.abs(targetGap) > TARGET_TOLERANCE_LU) {
      fail(
        `the chain reported ${reported.outputLufs.toFixed(2)} LUFS for a ${TARGET_LUFS} LUFS target`,
      );
    }
    console.info(
      `loudness: target ${TARGET_LUFS}, chain ${reported.outputLufs.toFixed(2)} ` +
        `(shown "${reported.text}"), file ${fileLufs.toFixed(2)} LUFS, ` +
        `true peak ${truePeakDbtp} dBTP under a ${ceilingDbtp} dBTP ceiling`,
    );
  } finally {
    await context.close();
  }
}
