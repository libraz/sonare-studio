/** Tempo-following clips (warp). */
export const name = 'warp';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    // A 4-beat click track recorded at 120 bpm: with warp enabled the clicks
    // must land on the beat grid after the project tempo changes to 90, and
    // fall off it once warp is disabled (the audio then plays at its
    // recorded rate).
    const warp = await page.evaluate(async () => {
      const id = window.__sonareDebug.addAudioTrack('Warp');
      const clipId = await window.__sonareDebug.addClickClip(id, 4, 120, 0);
      const others = window.__sonareDebug.trackIds().filter((other) => other !== id);
      for (const other of others) {
        window.__sonareDebug.setAutomationLanePoints(other, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      window.__sonareDebug.setClipWarp(clipId, { enabled: true, sourceBpm: 120 });
      window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 90 }]);
      return { id, clipId, others };
    });
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    // At 90 bpm a beat is ~667 ms; the 10 ms clicks sit at the very start of
    // each beat. Probe a window over beat 2's click and the gap after it.
    const onBeat = (await probe(1.98, 2.2)).peakDb;
    const offBeat = (await probe(2.3, 2.9)).peakDb;
    await page.evaluate((clipId) => window.__sonareDebug.setClipWarp(clipId, null), warp.clipId);
    const unwarped = (await probe(1.98, 2.2)).peakDb;
    // Unwarped at 90 bpm, the clicks land at source seconds 0/0.5/1/1.5 =
    // ppq 0/0.75/1.5/2.25 — outside the probed on-beat window.
    if (!(onBeat > -20) || !(offBeat < -50) || !(unwarped < -50)) {
      fail(
        `tempo follow not rendered: on-beat ${onBeat.toFixed(1)} dB, off-beat ` +
          `${offBeat.toFixed(1)} dB, unwarped on-beat ${unwarped.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS tempo follow: on-beat ${onBeat.toFixed(1)} dB, off-beat ${offBeat.toFixed(1)} dB, ` +
          `unwarped on-beat ${unwarped.toFixed(1)} dB`,
      );
    }
    await page.evaluate(
      ([id, others]) => {
        window.__sonareDebug.setTempoSegments([{ startPpq: 0, bpm: 120 }]);
        for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
        window.__sonareDebug.removeTrack(id);
      },
      [warp.id, warp.others],
    );
  }
}
