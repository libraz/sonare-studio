import { arrangementPoint } from '../geometry.mjs';

/**
 * Warp toggle: Follow tempo in the Sample tab keeps a click clip on the beat
 * grid after the transport tempo changes, and falls off the grid once it is
 * switched off again.
 */
export const name = 'warp-toggle';

const RECORDED_BPM = 120;
const PROJECT_BPM = 90;

const probe = (page, startPpq, endPpq) =>
  page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), { startPpq, endPpq });

async function setProjectTempo(page, bpm) {
  const field = page.getByLabel('Tempo in beats per minute');
  await field.fill(String(bpm));
  await field.press('Enter');
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
}

export async function run(ctx) {
  const { page, fail } = ctx;
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());
  // Four clicks recorded at 120 BPM; every other track is silenced so the
  // probes hear only the clicks.
  const setup = await page.evaluate(
    async ([bpm]) => {
      const id = window.__sonareDebug.addAudioTrack('Warp UI');
      const clipId = await window.__sonareDebug.addClickClip(id, 4, bpm, 0);
      const others = window.__sonareDebug.trackIds().filter((other) => other !== id);
      for (const other of others) {
        window.__sonareDebug.setAutomationLanePoints(other, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      return { id, clipId, others };
    },
    [RECORDED_BPM],
  );
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });

  // Select the clip and turn Follow tempo on from the Sample tab.
  const point = await arrangementPoint(page, setup.id, 1);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((id) => window.__sonareDebug.activeClipId() === id, setup.clipId, {
    timeout: 5000,
  });
  await page.click('.dock-tabs button:has-text("Sample")');
  const follow = page.locator('.sample-editor .warp').getByRole('button', { name: 'Follow tempo' });
  await follow.waitFor({ state: 'visible', timeout: 20000 });
  await follow.click();
  await page.waitForFunction(
    (id) => window.__sonareDebug.clipSettings(id)?.warpEnabled,
    setup.clipId,
    {
      timeout: 5000,
    },
  );
  await setProjectTempo(page, PROJECT_BPM);

  // At 90 BPM a beat is about 667 ms; the clicks sit at the start of each beat.
  const onBeat = (await probe(page, 1.98, 2.2)).peakDb;
  const offBeat = (await probe(page, 2.3, 2.9)).peakDb;

  // Follow tempo off: the clip plays at its recorded rate and leaves the grid.
  await follow.click();
  await page.waitForFunction(
    (id) => !window.__sonareDebug.clipSettings(id)?.warpEnabled,
    setup.clipId,
    {
      timeout: 5000,
    },
  );
  const unwarped = (await probe(page, 1.98, 2.2)).peakDb;
  if (!(onBeat > -20) || !(onBeat - offBeat > 30) || !(onBeat - unwarped > 30)) {
    fail(
      `tempo follow not rendered: on-beat ${onBeat.toFixed(1)} dB, off-beat ` +
        `${offBeat.toFixed(1)} dB, unwarped on-beat ${unwarped.toFixed(1)} dB`,
    );
  } else {
    console.info(
      `Follow tempo: on-beat ${onBeat.toFixed(1)} dB, off-beat ${offBeat.toFixed(1)} dB, ` +
        `unwarped on-beat ${unwarped.toFixed(1)} dB`,
    );
  }

  await setProjectTempo(page, RECORDED_BPM);
  await page.evaluate(({ id, others }) => {
    for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
    window.__sonareDebug.removeTrack(id);
  }, setup);
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
