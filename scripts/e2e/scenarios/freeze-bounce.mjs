/** Track freeze & bounce-in-place. */
export const name = 'freeze-bounce';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    // Freeze bakes a track's pre-fader render: the master measurement must
    // match before/after, editing a frozen track must be refused, and unfreeze
    // must bring the live render back. Bounce-in-place adds the rendered range as a new
    // clip while the original keeps playing.
    const fz = await page.evaluate(async () => {
      const id = window.__sonareDebug.addAudioTrack('Freeze');
      const clipId = await window.__sonareDebug.addToneClip(id, 2.0, 440, 0.5, 0);
      const others = window.__sonareDebug.trackIds().filter((other) => other !== id);
      for (const other of others) {
        window.__sonareDebug.setAutomationLanePoints(other, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      return { id, clipId, others };
    });
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const before = (await probe(0, 4)).peakDb;
    await page.evaluate((id) => window.__sonareDebug.freezeTrack(id), fz.id);
    const frozenStates = await page.evaluate(() => window.__sonareDebug.trackFrozenStates());
    const after = (await probe(0, 4)).peakDb;
    // A frozen track is not editable at all: its content is refused rather
    // than accepted-and-ignored, so the bake can never drift from its source.
    const frozenEdit = await page.evaluate((clipId) => {
      try {
        window.__sonareDebug.removeClip(clipId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, fz.clipId);
    if (frozenEdit === null) {
      fail('deleting a clip on a frozen track was accepted');
    } else if (!/frozen/i.test(frozenEdit)) {
      fail(`frozen-track edit refused for the wrong reason: ${frozenEdit}`);
    }
    const editedFrozen = (await probe(0, 4)).peakDb;
    await page.evaluate((id) => window.__sonareDebug.unfreezeTrack(id), fz.id);
    const unfrozen = (await probe(0, 4)).peakDb;
    if (
      !frozenStates.some((state) => state !== null) ||
      Math.abs(before - after) > 1 ||
      Math.abs(before - editedFrozen) > 1 ||
      // The bake stands in for the live render, so unfreezing must land back on
      // the level the track had before it was frozen.
      Math.abs(before - unfrozen) > 1
    ) {
      fail(
        `freeze parity broken: before ${before.toFixed(1)} dB, frozen ${after.toFixed(1)} dB, ` +
          `edited-while-frozen ${editedFrozen.toFixed(1)} dB, unfrozen ${unfrozen.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS freeze: before ${before.toFixed(1)} dB, frozen ${after.toFixed(1)} dB, ` +
          `edited-while-frozen ${editedFrozen.toFixed(1)} dB, unfrozen ${unfrozen.toFixed(1)} dB`,
      );
    }

    // Bounce-in-place: bounce the first half of the track's tone onto a new
    // track and verify the doubled level in the bounced range only. The tone
    // from the freeze scenario is still there — a frozen track refuses edits,
    // so nothing removed it — and a lane holds no second clip over its range.
    const bounce = await page.evaluate(async (id) => {
      const beforeIds = window.__sonareDebug.trackIds();
      const bounced = await window.__sonareDebug.bounceTrackRange(id, 0, 2);
      const newTrack = window.__sonareDebug
        .trackIds()
        .find((candidate) => !beforeIds.includes(candidate));
      return { bounced, newTrack };
    }, fz.id);
    const doubled = (await probe(0, 2)).peakDb;
    const single = (await probe(2, 4)).peakDb;
    if (!(doubled > single + 4 && doubled < single + 8)) {
      fail(
        `bounce-in-place wrong: bounced range ${doubled.toFixed(1)} dB vs original-only ` +
          `${single.toFixed(1)} dB (expected ~+6 dB)`,
      );
    } else {
      console.info(
        `PASS bounce-in-place: bounced range ${doubled.toFixed(1)} dB vs original-only ` +
          `${single.toFixed(1)} dB`,
      );
    }
    await page.evaluate(
      ([id, newTrack, others]) => {
        if (newTrack !== undefined && newTrack !== null) {
          window.__sonareDebug.removeTrack(newTrack);
        }
        for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
        window.__sonareDebug.removeTrack(id);
      },
      [fz.id, bounce.newTrack ?? null, fz.others],
    );
  }
}
