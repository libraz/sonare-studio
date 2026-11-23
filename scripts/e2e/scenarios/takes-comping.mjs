import { openEmptyProject, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Takes and comping through the take sub-rows: a clip carries three takes of
 * one tone at different levels; the T toggle opens its take rows, a click on a
 * row plays that take for the whole clip, and a drag over part of another row
 * comps that take in for the dragged range. The engine's export render must
 * follow each choice.
 */
export const name = 'takes-comping';

const TRACK = 'Comp takes';
const TONE_HZ = 330;
const TAKE_SECONDS = 2;
/** Linear amplitudes of takes A, B and C, 6 dB apart. */
const TAKE_AMPLITUDES = [0.8, 0.2, 0.4];
/** Must match TAKE_LANE_HEIGHT_PX and RULER_HEIGHT_PX in the arrangement. */
const TAKE_LANE_HEIGHT_PX = 40;
const RULER_HEIGHT_PX = 28;
/**
 * The sample peak of a 330 Hz sine at 48 kHz sits within 0.01 dB of its
 * amplitude, and with the master chain off the path after the clip is linear,
 * so every take shows the same peak-minus-amplitude offset.
 */
const LEVEL_TOLERANCE_DB = 0.1;
/** A comp boundary carries a 10 ms crossfade (0.01 ppq either side at 120 BPM). */
const COMP_FADE_GUARD_PPQ = 0.05;

const amplitudeDb = (amplitude) => 20 * Math.log10(amplitude);

/** Viewport point at a timeline position in a track's take sub-row. */
async function takeRowPoint(page, trackId, takeIndex, ppq) {
  return page.evaluate(
    ({ trackId, takeIndex, ppq, laneHeight, rulerHeight }) => {
      const canvas = document.querySelector('.arrangement-canvas');
      const props = canvas?.__vueParentComponent?.props;
      if (!canvas || !props?.range || !props.tracks || !props.rowLayout) return null;
      const index = props.tracks.findIndex((track) => track.id === trackId);
      if (index < 0) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + props.range.ppqToX(ppq),
        y:
          rect.top +
          rulerHeight +
          props.rowLayout.takeTop(index, takeIndex) -
          props.scrollY +
          laneHeight / 2,
      };
    },
    { trackId, takeIndex, ppq, laneHeight: TAKE_LANE_HEIGHT_PX, rulerHeight: RULER_HEIGHT_PX },
  );
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage);
  try {
    await openEmptyProject(page, baseUrl);
    await skipTour(page);

    const setup = await page.evaluate(
      async ({ trackName, hz, seconds, amplitudes }) => {
        const debug = window.__sonareDebug;
        const trackId = debug.addAudioTrack(trackName);
        const clipId = await debug.addToneClip(trackId, seconds, hz, amplitudes[0], 0);
        const takes = [];
        for (const [index, amplitude] of amplitudes.entries()) {
          const assetId = await debug.ingestToneAsset(seconds, hz, amplitude);
          takes.push({ assetId, name: `Take ${String.fromCharCode(65 + index)}` });
        }
        debug.setClipTakes(clipId, takes, 0);
        const range = debug.clipRanges().find((clip) => clip.id === clipId);
        return { trackId, clipId, startPpq: range.startPpq, lengthPpq: range.lengthPpq };
      },
      { trackName: TRACK, hz: TONE_HZ, seconds: TAKE_SECONDS, amplitudes: TAKE_AMPLITUDES },
    );
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const { trackId, clipId, startPpq, lengthPpq } = setup;
    const midPpq = startPpq + lengthPpq / 2;
    const endPpq = startPpq + lengthPpq;
    const peakOver = async (from, to) =>
      (
        await page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
          startPpq: from,
          endPpq: to,
        })
      ).peakDb;

    // The take rows open from the T toggle in the track header's overflow panel.
    await page.getByRole('button', { name: `More actions for ${TRACK}` }).click();
    const toggle = page.getByRole('button', { name: `Take lanes of ${TRACK}` });
    await toggle.click();
    await page.waitForFunction(
      (label) =>
        document.querySelector(`button[aria-label="${label}"]`)?.getAttribute('aria-pressed') ===
        'true',
      `Take lanes of ${TRACK}`,
      { timeout: 5000 },
    );
    await page.keyboard.press('Escape');

    const offsetA = (await peakOver(startPpq, endPpq)) - amplitudeDb(TAKE_AMPLITUDES[0]);

    // A plain click on take B's row plays take B over the whole clip.
    const clickAt = await takeRowPoint(page, trackId, 1, midPpq);
    if (!clickAt) throw new Error('take row geometry is unavailable');
    await page.mouse.click(clickAt.x, clickAt.y);
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const offsetB = (await peakOver(startPpq, endPpq)) - amplitudeDb(TAKE_AMPLITUDES[1]);
    if (!(Math.abs(offsetB - offsetA) <= LEVEL_TOLERANCE_DB)) {
      fail(
        `clicking take B did not switch the render to it: offset ${offsetB.toFixed(2)} dB ` +
          `against take A's ${offsetA.toFixed(2)} dB`,
      );
    }

    // Dragging over the second half of take C's row comps C in there; B stays before it.
    const dragFrom = await takeRowPoint(page, trackId, 2, midPpq);
    // Past the clip end: the range clamps to the clip window.
    const dragTo = await takeRowPoint(page, trackId, 2, endPpq + 0.5);
    await page.mouse.move(dragFrom.x, dragFrom.y);
    await page.mouse.down();
    await page.mouse.move(dragTo.x, dragTo.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
      timeout: 20000,
    });
    const segments = (
      await page.evaluate((id) => window.__sonareDebug.clipTakesInfo(id), trackId)
    ).find((clip) => clip.clipId === clipId)?.segments;
    const head =
      (await peakOver(startPpq, midPpq - COMP_FADE_GUARD_PPQ)) - amplitudeDb(TAKE_AMPLITUDES[1]);
    const tail =
      (await peakOver(midPpq + COMP_FADE_GUARD_PPQ, endPpq)) - amplitudeDb(TAKE_AMPLITUDES[2]);
    if (
      !(Math.abs(head - offsetA) <= LEVEL_TOLERANCE_DB) ||
      !(Math.abs(tail - offsetA) <= LEVEL_TOLERANCE_DB)
    ) {
      fail(
        `the comp drag did not render take B then take C: head offset ${head.toFixed(2)} dB, ` +
          `tail offset ${tail.toFixed(2)} dB, take A ${offsetA.toFixed(2)} dB, ` +
          `segments ${JSON.stringify(segments)}`,
      );
    }
    console.info(
      `takes comping: offsets A ${offsetA.toFixed(2)}, B ${offsetB.toFixed(2)}, ` +
        `comp B ${head.toFixed(2)} / C ${tail.toFixed(2)} dB, segments ${JSON.stringify(segments)}`,
    );
  } finally {
    await context.close();
  }
}
