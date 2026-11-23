import { decodeFlac } from '../flac-decode.mjs';
import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';
import { untilDoneAcceptingConfirms } from '../harness.mjs';
import { inspectWav } from '../wav-inspection.mjs';

/**
 * FLAC and MP3 export: the same short project exported through File > Export
 * Audio as WAV, FLAC and MP3 with the dialog's defaults (24-bit, no dither,
 * 320 kbps), each file decoded in node and compared with the WAV for duration,
 * sample peak and integrated loudness.
 */
export const name = 'export-formats';

const TRACK = 'Format tone';

/** FLAC is lossless: the same 24-bit integers as the WAV, so peak and loudness agree exactly. */
const FLAC_LEVEL_TOLERANCE_DB = 0;
/**
 * MP3 timing: the decoder may leave LAME's 576-sample encoder delay, the
 * 529-sample decoder delay and up to one 1152-sample frame of end padding in
 * place, so the decoded length may differ from the WAV by at most their sum.
 */
const MP3_MAX_LENGTH_DIFF_FRAMES = 576 + 529 + 1152;
/**
 * MP3 level at 320 kbps CBR on a steady tone: the codec's quantization noise
 * and band-limiting move the sample peak by well under 0.5 dB and the
 * integrated loudness by well under 0.2 LU.
 */
const MP3_PEAK_TOLERANCE_DB = 0.5;
const MP3_LUFS_TOLERANCE_LU = 0.2;

let sonare = null;
async function libsonare() {
  if (!sonare) {
    sonare = await import('@libraz/libsonare');
    await sonare.init();
  }
  return sonare;
}

function peakDb(channels) {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  }
  return 20 * Math.log10(peak);
}

function planarFromWav(wav) {
  const planes = Array.from({ length: wav.channels }, () => new Float32Array(wav.frames));
  for (let i = 0; i < wav.samples.length; i++) {
    planes[i % wav.channels][Math.floor(i / wav.channels)] = wav.samples[i];
  }
  return planes;
}

async function exportAs(page, encoderId) {
  await page.click('.app-menubar__trigger:has-text("File")');
  await page
    .locator('.menu-panel [role="menuitem"]')
    .filter({ hasText: /^Export Audio\.\.\.$/ })
    .click();
  await page.waitForSelector('.modal-card .export-button:not([disabled])', { timeout: 10000 });
  await page.locator('.modal-card .format-select .select-trigger').click();
  await page.locator(`.select-list .select-option[data-value="${encoderId}"]`).click();
  await page.click('.modal-card .export-button');
  await untilDoneAcceptingConfirms(
    page,
    async () => (await page.locator('.modal-card .export-report').count()) > 0,
    120000,
  );
  const download = await page.evaluate(async () => {
    const file = window.__sonareDebug.lastDownload();
    if (!file) return null;
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { filename: file.filename, base64: btoa(binary) };
  });
  await page.click('.modal-card .close-button');
  if (!download) throw new Error(`no ${encoderId} download was captured`);
  return {
    filename: download.filename,
    bytes: new Uint8Array(Buffer.from(download.base64, 'base64')),
  };
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);
    await page.evaluate(async (trackName) => {
      const id = window.__sonareDebug.addAudioTrack(trackName);
      await window.__sonareDebug.addToneClip(id, 3, 440, 0.3, 0);
    }, TRACK);
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });

    const wavFile = await exportAs(page, 'wav');
    const flacFile = await exportAs(page, 'flac');
    const mp3File = await exportAs(page, 'mp3');
    for (const [file, extension] of [
      [wavFile, '.wav'],
      [flacFile, '.flac'],
      [mp3File, '.mp3'],
    ]) {
      if (!file.filename.endsWith(extension))
        fail(`expected a ${extension} file, got ${file.filename}`);
    }

    const { decodeChannels, lufsMultichannel } = await libsonare();
    const measure = (channels, sampleRate) => ({
      frames: channels[0]?.length ?? 0,
      sampleRate,
      peakDb: peakDb(channels),
      lufs: lufsMultichannel({ channels, sampleRate }).integratedLufs,
    });

    const wavParsed = inspectWav(wavFile.bytes);
    const wavChannels = planarFromWav(wavParsed);
    const wav = measure(wavChannels, wavParsed.sampleRate);
    if (!(wav.peakDb > -30) || !Number.isFinite(wav.lufs)) {
      fail(`the WAV reference is silent: ${JSON.stringify(wav)}`);
    }

    const flacDecoded = decodeFlac(flacFile.bytes);
    const flac = measure(flacDecoded.channels, flacDecoded.sampleRate);
    let flacMaxDiff = 0;
    for (let channel = 0; channel < wavChannels.length; channel++) {
      const a = wavChannels[channel];
      const b = flacDecoded.channels[channel];
      if (!b) {
        flacMaxDiff = Number.POSITIVE_INFINITY;
        break;
      }
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        flacMaxDiff = Math.max(flacMaxDiff, Math.abs(a[i] - b[i]));
      }
    }
    if (
      flac.frames !== wav.frames ||
      flacDecoded.totalSamples !== wav.frames ||
      flac.sampleRate !== wav.sampleRate ||
      flacDecoded.channels.length !== wavChannels.length ||
      flacMaxDiff !== 0 ||
      Math.abs(flac.peakDb - wav.peakDb) > FLAC_LEVEL_TOLERANCE_DB ||
      Math.abs(flac.lufs - wav.lufs) > FLAC_LEVEL_TOLERANCE_DB
    ) {
      const streamInfoSamples = flacDecoded.totalSamples;
      fail(
        `FLAC is not the WAV's samples: ` +
          JSON.stringify({ wav, flac, flacMaxDiff, streamInfoSamples }),
      );
    }

    const mp3Decoded = decodeChannels(mp3File.bytes);
    const mp3 = measure(mp3Decoded.channels, mp3Decoded.sampleRate);
    if (
      mp3.sampleRate !== wav.sampleRate ||
      !(Math.abs(mp3.frames - wav.frames) <= MP3_MAX_LENGTH_DIFF_FRAMES) ||
      !(Math.abs(mp3.peakDb - wav.peakDb) <= MP3_PEAK_TOLERANCE_DB) ||
      !(Math.abs(mp3.lufs - wav.lufs) <= MP3_LUFS_TOLERANCE_LU)
    ) {
      fail(`MP3 does not match the WAV: ${JSON.stringify({ wav, mp3 })}`);
    }

    console.info(
      `export formats: wav ${JSON.stringify(wav)}, flac ${JSON.stringify(flac)} ` +
        `(max diff ${flacMaxDiff}), mp3 ${JSON.stringify(mp3)}`,
    );
  } finally {
    await context.close();
  }
}
