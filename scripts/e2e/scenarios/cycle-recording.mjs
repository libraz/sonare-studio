/** Cycle recording: loop takes, comp switching, flatten. */
import { assertInputCaptureRequest } from '../harness.mjs';

export const name = 'cycle-recording';

export async function run(ctx) {
  const { page, fail } = ctx;

  {
    // Record ~2.3 loop passes onto a fresh audio track: the linear capture
    // must split at the loop boundaries into one clip with one take per
    // completed pass.
    // Headless Chromium reports a 2 s output latency, and the record offset
    // built from it outlasts the 2 s loop pass, so nothing would be captured.
    // Hold a device-like latency for this take only. Interim: whether the engine
    // should refuse or capture an offset longer than the loop pass is still open,
    // and this hold goes once that is settled.
    await page.evaluate(() => {
      window.__nativeOutputLatency = Object.getOwnPropertyDescriptor(
        AudioContext.prototype,
        'outputLatency',
      );
      Object.defineProperty(AudioContext.prototype, 'outputLatency', {
        configurable: true,
        get: () => 0.02,
      });
    });
    const recTrackId = await page.evaluate(() => {
      const id = window.__sonareDebug.addAudioTrack('Cycle rec');
      window.__sonareDebug.armTrack(id);
      window.__sonareDebug.setLoopRange(0, 4, true);
      window.__sonareDebug.seekPpq(0);
      return id;
    });
    await page.click('.transport-bar .record-button');
    await page.waitForFunction(() => window.__sonareDebug.isRecording() === true, null, {
      timeout: 10000,
    });
    await assertInputCaptureRequest(page, fail);
    // One loop pass is 2 s (4 PPQ at 120 BPM). Stop after the worklet
    // has actually captured two passes, even when its clock lags wall time.
    await page.evaluate(async () => {
      const deadline = performance.now() + 20000;
      while (performance.now() < deadline) {
        const progress = await window.__sonareDebug.captureProgress();
        if (progress && progress.capturedFrames >= 4 * progress.sampleRate) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('worklet did not capture two complete loop passes');
    });
    await page.click('.transport-bar .record-button');
    await page.waitForFunction(
      (id) => window.__sonareDebug.clipTakesInfo(id).length === 1,
      recTrackId,
      { timeout: 10000 },
    );
    await page.click('.transport-bar .transport-key.stop');
    await page.evaluate(() => {
      Object.defineProperty(AudioContext.prototype, 'outputLatency', window.__nativeOutputLatency);
    });
    const recInfo = (
      await page.evaluate((id) => window.__sonareDebug.clipTakesInfo(id), recTrackId)
    )[0];
    if (recInfo.takeCount < 2 || recInfo.startPpq !== 0 || Math.abs(recInfo.lengthPpq - 4) > 1e-6) {
      fail(
        `cycle recording did not split takes: ${recInfo.takeCount} takes, ` +
          `clip ${recInfo.startPpq}..${recInfo.startPpq + recInfo.lengthPpq} ppq`,
      );
    }

    // Deterministic comp content: replace the takes with two tones 12 dB
    // apart, silence every other track, and verify take switching, partial
    // comp segments and flattening through the real export path.
    const otherIds = await page.evaluate(
      (keep) => window.__sonareDebug.trackIds().filter((id) => id !== keep),
      recTrackId,
    );
    await page.evaluate(
      async ([clipId, others]) => {
        for (const id of others) {
          window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
            { ppq: 0, value: -120, curve: 'hold' },
          ]);
        }
        const loud = await window.__sonareDebug.ingestToneAsset(2.0, 330, 0.8);
        const quiet = await window.__sonareDebug.ingestToneAsset(2.0, 330, 0.2);
        window.__sonareDebug.setClipTakes(
          clipId,
          [
            { assetId: loud, name: 'Take A' },
            { assetId: quiet, name: 'Take B' },
          ],
          0,
        );
      },
      [recInfo.clipId, otherIds],
    );
    const probeWindow = (startPpq, endPpq) =>
      page.evaluate((range) => window.__sonareDebug.exportProbe(false, range), {
        startPpq,
        endPpq,
      });
    const takeA = (await probeWindow(0, 4)).peakDb;
    await page.evaluate(
      (clipId) => window.__sonareDebug.setClipActiveTake(clipId, 1),
      recInfo.clipId,
    );
    const takeB = (await probeWindow(0, 4)).peakDb;
    if (!(takeA - takeB > 10 && takeA - takeB < 14)) {
      fail(
        `take switch not audible in export: take A ${takeA.toFixed(1)} dB, take B ${takeB.toFixed(1)} dB`,
      );
    }

    // A comp boundary carries a 10 ms crossfade centred on it (0.01 ppq either
    // side at 120 bpm), so each window stops short of the fade.
    await page.evaluate(
      (clipId) =>
        window.__sonareDebug.setClipCompSegments(clipId, [
          { startPpq: 0, takeIndex: 0 },
          { startPpq: 2, takeIndex: 1 },
        ]),
      recInfo.clipId,
    );
    const compHead = (await probeWindow(0, 1.95)).peakDb;
    const compTail = (await probeWindow(2.05, 4)).peakDb;
    if (!(compHead - compTail > 10 && compHead - compTail < 14)) {
      fail(
        `comp segments not audible in export: head ${compHead.toFixed(1)} dB, ` +
          `tail ${compTail.toFixed(1)} dB`,
      );
    }

    await page.evaluate((clipId) => window.__sonareDebug.flattenClipComp(clipId), recInfo.clipId);
    const flatInfo = (
      await page.evaluate((id) => window.__sonareDebug.clipTakesInfo(id), recTrackId)
    )[0];
    const flatHead = (await probeWindow(0, 1.95)).peakDb;
    const flatTail = (await probeWindow(2.05, 4)).peakDb;
    if (
      flatInfo.takeCount !== 0 ||
      Math.abs(flatHead - compHead) > 1 ||
      Math.abs(flatTail - compTail) > 1
    ) {
      fail(
        `flatten changed the comp: ${flatInfo.takeCount} takes left, head ` +
          `${flatHead.toFixed(1)} dB (was ${compHead.toFixed(1)}), tail ` +
          `${flatTail.toFixed(1)} dB (was ${compTail.toFixed(1)})`,
      );
    } else {
      console.info(
        `PASS cycle recording: ${recInfo.takeCount} takes, take switch ` +
          `${(takeA - takeB).toFixed(1)} dB, comp head/tail ${compHead.toFixed(1)}/` +
          `${compTail.toFixed(1)} dB, flatten preserved ${flatHead.toFixed(1)}/${flatTail.toFixed(1)} dB`,
      );
    }

    // The realtime engine takes the flattened clip before its track goes, so the
    // cleanup removes a scheduled clip rather than racing the debounced sync.
    await page.evaluate(() => window.__sonareDebug.whenEngineSyncIdle());
    await page.evaluate(
      ([id, others]) => {
        window.__sonareDebug.armTrack(null);
        for (const other of others) window.__sonareDebug.removeAutomationLane(other, 'faderDb');
        window.__sonareDebug.setLoopRange(0, 4, false);
        window.__sonareDebug.removeTrack(id);
      },
      [recTrackId, otherIds],
    );
  }
}
