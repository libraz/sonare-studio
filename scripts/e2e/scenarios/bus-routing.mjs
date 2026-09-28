/** Audible bus routing, pre/post sends, and surround fold-down in the browser. */
export const name = 'bus-routing';

export async function run(ctx) {
  const { page, fail } = ctx;
  const fixture = await page.evaluate(async () => {
    const debug = window.__sonareDebug;
    const clips = debug.projectDocument().tracks.flatMap((track) => track.clips);
    const lastEnd = Math.max(0, ...clips.map((clip) => clip.startPpq + clip.lengthPpq));
    const startPpq = Math.ceil(lastEnd / 4) * 4 + 4;
    const trackId = debug.addAudioTrack('Bus routing E2E');
    await debug.addToneClip(trackId, 2, 330, 0.5, startPpq);
    const a = debug.addMixerBus('E2E Aux A');
    const b = debug.addMixerBus('E2E Aux B');
    debug.setTrackOutput(trackId, a);
    return { trackId, a, b, startPpq };
  });
  const probe = () =>
    page.evaluate(
      (startPpq) =>
        window.__sonareDebug.exportProbe(false, { startPpq: startPpq + 1, endPpq: startPpq + 3 }),
      fixture.startPpq,
    );
  const busStrip = (name) =>
    page.locator('.mixer-strips .bus-strip').filter({
      has: page.locator('.bus-name', { hasText: name }),
    });
  try {
    await page.click('.dock-tabs button:has-text("Mixer")');
    await page.waitForSelector('.mixer-strips .bus-strip', { timeout: 10000 });
    const direct = await probe();
    await page.evaluate(({ a, b }) => window.__sonareDebug.setBusOutput(a, b), fixture);
    const bStrip = busStrip('E2E Aux B');
    await bStrip.locator('.bus-toggle.mute').click();
    const muted = await probe();
    await bStrip.locator('.bus-toggle.mute').click();
    if (!(direct.peakDb > -60 && direct.peakDb - muted.peakDb > 25)) {
      fail(
        `bus-to-bus OUT did not pass through the destination mute: ${direct.peakDb}/${muted.peakDb}`,
      );
    }
    const livePeak = async (mute) => {
      if (mute) await bStrip.locator('.bus-toggle.mute').click();
      await page.click('.transport-bar .transport-key.play');
      await page.waitForFunction(() => window.__sonareDebug.engineStarted());
      const seeked = await page.evaluate(
        (startPpq) => window.__sonareDebug.seekPpq(startPpq),
        fixture.startPpq,
      );
      if (!seeked) throw new Error('live bus probe could not seek to its isolated tone');
      let peak = Number.NEGATIVE_INFINITY;
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const state = await page.evaluate(() => ({
          position: window.__sonareDebug.positionPpq(),
          level: window.__sonareDebug.meterPeakDb(),
        }));
        if (
          state.position >= fixture.startPpq + 1 &&
          state.position <= fixture.startPpq + 3 &&
          state.level !== null
        ) {
          peak = Math.max(peak, state.level);
        }
        if (state.position > fixture.startPpq + 3) break;
        await page.waitForTimeout(70);
      }
      await page.click('.transport-bar .transport-key.stop');
      if (mute) await bStrip.locator('.bus-toggle.mute').click();
      return peak;
    };
    const liveDirect = await livePeak(false);
    const liveMuted = await livePeak(true);
    if (!(liveDirect > -60 && liveDirect - liveMuted > 20)) {
      fail(`live bus-to-bus routing ignored return mute: ${liveDirect}/${liveMuted} dB`);
    }

    await page.evaluate(({ a, b }) => {
      const debug = window.__sonareDebug;
      debug.setBusOutput(a, null);
      debug.setBusSend(a, b, { levelDb: 0, enabled: true, timing: 'preFader' });
      debug.setBusGain(a, -96);
    }, fixture);
    const pre = await probe();
    const aStrip = busStrip('E2E Aux A');
    const bSend = aStrip.locator('.send-row').filter({ hasText: 'E2E Aux B' });
    await bSend.locator('.send-timing').click();
    const post = await probe();
    if (!(pre.peakDb > -60 && pre.peakDb - post.peakDb > 25)) {
      fail(`bus send PRE/POST did not move its tap across the fader: ${pre.peakDb}/${post.peakDb}`);
    }

    await page.evaluate(({ b }) => window.__sonareDebug.setBusLayout(b, '5.1'), fixture);
    await bSend.locator('.send-timing').click();
    const folded = await probe();
    if (!(folded.peakDb > -70 && folded.riff === 'RIFF')) {
      fail(`5.1 bus did not fold into an audible stereo WAV: ${JSON.stringify(folded)}`);
    }
    const layout = await page.evaluate(
      (busId) =>
        window.__sonareDebug.projectDocument().mixer.buses.find((bus) => bus.id === busId)
          ?.channelLayout,
      fixture.b,
    );
    if (layout !== '5.1') fail(`5.1 bus format was not persisted: ${layout}`);
    console.info(
      `PASS bus routing: direct ${direct.peakDb.toFixed(1)}, muted ${muted.peakDb.toFixed(1)}, ` +
        `PRE ${pre.peakDb.toFixed(1)}, POST ${post.peakDb.toFixed(1)}, 5.1 fold ${folded.peakDb.toFixed(1)} dB`,
    );
  } finally {
    await page.evaluate(({ trackId, a, b }) => {
      const debug = window.__sonareDebug;
      if (!debug) return;
      if (debug.trackIds().includes(trackId)) debug.removeTrack(trackId);
      if (debug.projectDocument().mixer.buses.some((bus) => bus.id === a)) debug.removeMixerBus(a);
      if (debug.projectDocument().mixer.buses.some((bus) => bus.id === b)) debug.removeMixerBus(b);
    }, fixture);
  }
}
