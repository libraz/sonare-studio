/** Group routing & sidechain ducking. */
export const name = 'sidechain';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    // Pad spans ppq 0..8, kick ppq 0..4: with the kick keying a ducking
    // insert on the pad, the pad's exported level in the kick window must sit
    // far below its level after the kick ends — and the kick can stay silent
    // in the mix (the key taps pre-fader audio).
    const ids = await page.evaluate(async () => {
      const pad = window.__sonareDebug.addAudioTrack('Pad');
      const kick = window.__sonareDebug.addAudioTrack('Kick');
      await window.__sonareDebug.addToneClip(pad, 4.0, 220, 0.5, 0);
      await window.__sonareDebug.addToneClip(kick, 2.0, 80, 0.9, 0);
      const others = window.__sonareDebug.trackIds().filter((id) => id !== pad);
      for (const id of others) {
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      window.__sonareDebug.addTrackInsert(pad, 'dynamics.duckingProcessor', {
        thresholdDb: -30,
        ratio: 20,
        attackMs: 1,
        releaseMs: 50,
        rangeDb: 24,
      });
      window.__sonareDebug.setInsertSidechain(pad, 0, kick);
      return { pad, kick, others };
    });
    const probe = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const ducked = (await probe(1, 3)).peakDb;
    const open = (await probe(5, 7)).peakDb;
    if (!(open - ducked > 12)) {
      fail(
        `sidechain ducking not rendered: kick window ${ducked.toFixed(1)} dB vs ` +
          `open window ${open.toFixed(1)} dB`,
      );
    }

    // Group routing: moving the pad into a group is transparent at unity and
    // the group strip gain then attenuates it by the set amount.
    const groupId = await page.evaluate((pad) => {
      const group = window.__sonareDebug.addGroupTrack('Pads');
      window.__sonareDebug.setTrackGroup(pad, group);
      return group;
    }, ids.pad);
    const grouped = (await probe(5, 7)).peakDb;
    await page.evaluate((group) => window.__sonareDebug.setStripGainDb(group, -12), groupId);
    const groupAttenuated = (await probe(5, 7)).peakDb;
    if (Math.abs(grouped - open) > 1 || Math.abs(grouped - 12 - groupAttenuated) > 1.5) {
      fail(
        `group routing wrong: ungrouped ${open.toFixed(1)} dB, grouped ${grouped.toFixed(1)} dB, ` +
          `group -12 dB -> ${groupAttenuated.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS group/sidechain: ducked ${ducked.toFixed(1)} dB vs open ${open.toFixed(1)} dB, ` +
          `grouped ${grouped.toFixed(1)} dB, group -12 dB -> ${groupAttenuated.toFixed(1)} dB`,
      );
    }

    // Live parity: the pad lane meter while the kick window plays must sit
    // well below its level in the open window.
    await page.evaluate(() => window.__sonareDebug.setLoopRange(0, 8, true));
    await page.evaluate(() => window.__sonareDebug.seekPpq(0));
    await page.click('.transport-bar .transport-key.play');
    const sampleTrackWindow = async (fromPpq, toPpq) => {
      let peak = Number.NEGATIVE_INFINITY;
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        const pos = await page.evaluate(() => window.__sonareDebug.positionPpq());
        if (pos >= fromPpq && pos <= toPpq) {
          const level = await page.evaluate((id) => window.__sonareDebug.trackMeterDb(id), ids.pad);
          if (level !== null && level > peak) peak = level;
        }
        if (pos > toPpq) break;
        await page.waitForTimeout(80);
      }
      return peak;
    };
    const liveDucked = await sampleTrackWindow(1, 3);
    const liveOpen = await sampleTrackWindow(5, 7);
    await page.click('.transport-bar .transport-key.stop');
    if (!Number.isFinite(liveDucked) || !Number.isFinite(liveOpen) || liveOpen - liveDucked < 10) {
      fail(
        `live sidechain ducking diverges: kick window ${liveDucked.toFixed(1)} dB, ` +
          `open window ${liveOpen.toFixed(1)} dB`,
      );
    } else {
      console.info(
        `PASS live ducking: kick window ${liveDucked.toFixed(1)} dB vs open ` +
          `${liveOpen.toFixed(1)} dB`,
      );
    }

    await page.evaluate(
      ([pad, kick, group, others]) => {
        window.__sonareDebug.setLoopRange(0, 8, false);
        for (const id of others) window.__sonareDebug.removeAutomationLane(id, 'faderDb');
        window.__sonareDebug.removeTrack(group);
        window.__sonareDebug.removeTrack(kick);
        window.__sonareDebug.removeTrack(pad);
      },
      [ids.pad, ids.kick, groupId, ids.others],
    );
  }
}
