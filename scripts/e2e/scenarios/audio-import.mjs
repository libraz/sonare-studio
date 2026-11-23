import { makeWavBytes } from '../harness.mjs';

/** Audio: import a generated WAV through the media browser. */
export const name = 'audio-import';

export async function run(ctx) {
  const { page, fail } = ctx;

  const wav = {
    name: 'sonare-e2e-tone.wav',
    mimeType: 'audio/wav',
    buffer: makeWavBytes(0.5, 440),
  };

  await page.click('.dock-tabs button:has-text("Media")');
  await page.setInputFiles('.media-browser .file-input', wav);
  const assetRow = page.locator('.media-browser .asset-row', { hasText: 'sonare-e2e-tone' });
  await assetRow.first().waitFor({ state: 'visible', timeout: 20000 });
  console.info('audio asset imported: media browser row visible');

  // "Add" places the asset at the playhead, creating an audio track.
  const tracksBeforeAdd = await page.evaluate(() => window.__sonareDebug.trackCount());
  const clipsBeforeAdd = await page.evaluate(() => window.__sonareDebug.clipCount());
  await assetRow.first().locator('.add-button').click();
  await page.waitForFunction(
    (before) => window.__sonareDebug.clipCount() === before + 1,
    clipsBeforeAdd,
    { timeout: 10000 },
  );
  const audioClips = await page.evaluate(() => window.__sonareDebug.audioClipCount());
  const clipKinds = await page.evaluate(() => window.__sonareDebug.clipKinds());
  const placedClip = (await page.evaluate(() => window.__sonareDebug.clipRanges())).at(-1);
  if (audioClips !== 1 || clipKinds[clipKinds.length - 1] !== 'audio') {
    fail(`expected one audio clip, got audioClipCount=${audioClips} kinds=${clipKinds}`);
  } else {
    console.info(`audio clip added: ${clipsBeforeAdd} -> ${clipsBeforeAdd + 1} (kind audio)`);
  }
  const tracksAfterAdd = await page.evaluate(() => window.__sonareDebug.trackCount());
  if (tracksAfterAdd !== tracksBeforeAdd + 1) {
    fail(`expected an audio track to be created (${tracksBeforeAdd} -> ${tracksAfterAdd})`);
  } else {
    console.info('audio track auto-created for the asset');
  }

  // The new track may be scrolled into view and the clip starts at the current
  // playhead. Sample its actual row and timeline position, then compare the
  // waveform body with an empty part of that row.
  const deadline = Date.now() + 20000;
  let waveformStats = { novelColors: 0, litPixels: 0 };
  while (Date.now() < deadline) {
    waveformStats = await page.evaluate((clip) => {
      const wrapper = document.querySelector('.arrangement-canvas');
      const canvas = wrapper?.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return { novelColors: 0, litPixels: 0 };
      const props = wrapper?.__vueParentComponent?.props;
      const lane = props?.tracks?.findIndex((track) => track.id === clip?.trackId) ?? -1;
      if (!props?.range || !props?.rowLayout || lane < 0) {
        return { novelColors: 0, litPixels: 0 };
      }
      const ctx = canvas.getContext('2d');
      const scaleX = canvas.width / canvas.clientWidth;
      const scaleY = canvas.height / canvas.clientHeight;
      const laneTop = 28 + props.rowLayout.rowTop(lane) - props.scrollY;
      const clipX = props.range.ppqToX(clip.startPpq) + 2;
      if (
        laneTop < 28 ||
        laneTop + 48 > canvas.clientHeight ||
        clipX < 0 ||
        clipX > canvas.clientWidth - 8
      ) {
        return { novelColors: 0, litPixels: 0 };
      }
      const read = (cssX) =>
        ctx.getImageData(
          Math.round(cssX * scaleX),
          Math.round((laneTop + 4) * scaleY),
          Math.max(1, Math.round(8 * scaleX)),
          Math.max(1, Math.round(48 * scaleY)),
        );
      const colorCounts = (img) => {
        const counts = new Map();
        for (let i = 0; i < img.data.length; i += 4) {
          const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return counts;
      };
      const clipColors = colorCounts(read(clipX));
      const emptyColors = colorCounts(read(canvas.clientWidth * 0.8));
      let novelColors = 0;
      let litPixels = 0;
      for (const [color, count] of clipColors) {
        if (emptyColors.has(color)) continue;
        novelColors += 1;
        litPixels += count;
      }
      return { novelColors, litPixels };
    }, placedClip);
    // At least the clip fill plus waveform columns, covering most of the body.
    if (waveformStats.novelColors >= 2 && waveformStats.litPixels >= 100) break;
    await page.waitForTimeout(250);
  }
  if (waveformStats.novelColors < 2 || waveformStats.litPixels < 100) {
    fail(`audio clip waveform not drawn: ${JSON.stringify(waveformStats)}`);
  } else {
    console.info(
      `audio waveform drawn: ${waveformStats.novelColors} clip color(s), ${waveformStats.litPixels} px`,
    );
  }
}
