/** MIDI clip gain and fades shape the instrument audio in a real export. */
export const name = 'midi-clip-envelope';

export async function run({ page, fail }) {
  // The demo and any earlier scenario may extend beyond its original length.
  // Keep the probe on its own four-beat window so other tracks cannot mask it.
  const start = await page.evaluate(() => {
    const clips = window.__sonareDebug.projectDocument().tracks.flatMap((track) => track.clips);
    const lastEnd = Math.max(0, ...clips.map((clip) => clip.startPpq + clip.lengthPpq));
    return Math.ceil(lastEnd / 4) * 4 + 4;
  });
  const originalClipId = await page.evaluate(() => window.__sonareDebug.activeClipId());
  const { trackId, clipId } = await page.evaluate(
    (startPpq) => window.__sonareDebug.addMidiTestClip('MIDI envelope E2E', startPpq),
    start,
  );
  const probe = (from, to) =>
    page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
      startPpq: from,
      endPpq: to,
    });
  try {
    const unity = await probe(start + 1, start + 3);
    const envelope = () =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range, false, 16), {
        startPpq: start,
        endPpq: start + 4,
      });
    const beforeFade = await envelope();
    await page.evaluate((id) => window.__sonareDebug.setClipGain(id, 0.25), clipId);
    const reduced = await probe(start + 1, start + 3);
    if (!(unity.peakDb > -60 && unity.peakDb - reduced.peakDb > 9)) {
      fail(`MIDI clip gain did not reduce rendered audio: ${unity.peakDb} vs ${reduced.peakDb}`);
    }
    await page.evaluate((id) => {
      window.__sonareDebug.setClipGain(id, 1);
      window.__sonareDebug.setClipFades(id, 1, 1);
    }, clipId);
    const afterFade = await envelope();
    const early = beforeFade.windowPeaksDb?.[0];
    const late = beforeFade.windowPeaksDb?.[15];
    const fadedEarly = afterFade.windowPeaksDb?.[0];
    const fadedLate = afterFade.windowPeaksDb?.[15];
    if (!(early - fadedEarly > 5 && late - fadedLate > 5)) {
      fail(
        `MIDI clip fades did not shape rendered audio: ` +
          `early ${early}/${fadedEarly}, late ${late}/${fadedLate}`,
      );
    } else {
      console.info(
        `PASS MIDI clip gain/fades: unity ${unity.peakDb.toFixed(1)} dB, ` +
          `quarter ${reduced.peakDb.toFixed(1)} dB`,
      );
    }
  } finally {
    await page.evaluate(
      ({ trackId, originalClipId }) => {
        window.__sonareDebug.removeTrack(trackId);
        window.__sonareDebug.selectClip(originalClipId);
      },
      { trackId, originalClipId },
    );
  }
}
