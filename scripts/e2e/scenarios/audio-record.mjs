/** Audio: record from the fake microphone. */
import { assertInputCaptureRequest } from '../harness.mjs';

export const name = 'audio-record';

export async function run(ctx) {
  const { page, fail } = ctx;

  // Record onto a lane of its own. The imported asset's lane already carries a
  // clip at PPQ 0, and a track holds one lane of non-overlapping clips, so
  // recording from rest onto that lane asks the engine for something it does
  // not model — which is a scenario of its own, not this one.
  const recordTrackCount = await page.evaluate(() => window.__sonareDebug.trackCount());
  await page.click('.track-headers .add-track');
  await page.click('.add-track-items button:has-text("Audio track")');
  await page.waitForFunction(
    (before) => window.__sonareDebug.trackCount() === before + 1,
    recordTrackCount,
    { timeout: 5000 },
  );
  const recordLaneIndex = recordTrackCount;

  // AudioContext resume requires a browser user gesture, so Play is the
  // authoritative startup path for this browser smoke.
  await page.evaluate(() => window.__sonareDebug.seekPpq(0));
  await page.click('.transport-bar .transport-key.play');
  try {
    await page.waitForFunction(() => window.__sonareDebug?.engineStarted() === true, null, {
      timeout: 60000,
    });
  } catch {
    const state = await page.evaluate(() => ({
      started: window.__sonareDebug.engineStarted(),
      error: window.__sonareDebug.lastError(),
      playDisabled: document.querySelector('.transport-bar .transport-key.play')?.disabled,
      stopDisabled: document.querySelector('.transport-bar .transport-key.stop')?.disabled,
    }));
    throw new Error(`audio engine did not start: ${JSON.stringify(state)}`);
  }
  console.info('engine started');

  // Do not seek while the transport is running: it is a separate lifecycle
  // path from arming and recording, and would make this scenario ambiguous.
  await page.click(`.track-headers .track-header:nth-child(${recordLaneIndex + 1}) .toggle.arm`);
  await page.waitForFunction(() => window.__sonareDebug.armedTrackId() !== null, null, {
    timeout: 5000,
  });
  console.info('audio track armed');

  const clipsBeforeRecord = await page.evaluate(() => window.__sonareDebug.audioClipCount());
  await page.waitForFunction(() => window.__sonareDebug.recordingState() === 'idle', null, {
    timeout: 30000,
  });
  const recordReadiness = await page.evaluate(() => ({
    engineStarted: window.__sonareDebug.engineStarted(),
    armedTrackId: window.__sonareDebug.armedTrackId(),
    recordingState: window.__sonareDebug.recordingState(),
    recordDisabled: document.querySelector('.transport-bar .record-button')?.disabled,
    lastError: window.__sonareDebug.lastError(),
  }));
  console.info('record readiness:', recordReadiness);
  if (!recordReadiness.engineStarted || recordReadiness.recordDisabled) {
    fail(`recording engine is not ready: ${JSON.stringify(recordReadiness)}`);
    throw new Error('Recording engine stopped before the record control became available.');
  }
  await page.waitForFunction(
    () => {
      const button = document.querySelector('.transport-bar .record-button');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    null,
    { timeout: 30000 },
  );
  await page.click('.transport-bar .record-button');
  try {
    await page.waitForFunction(() => window.__sonareDebug.isRecording() === true, null, {
      timeout: 20000,
    });
  } catch {
    // Recording can decline for reasons the transport never surfaces (no input
    // permission, a device that never opens, a worklet that died). Report the
    // engine's own view rather than a bare timeout.
    const state = await page.evaluate(() => ({
      recordingState: window.__sonareDebug.recordingState(),
      isRecording: window.__sonareDebug.isRecording(),
      engineStarted: window.__sonareDebug.engineStarted(),
      armedTrackId: window.__sonareDebug.armedTrackId(),
      inputLevel: window.__sonareDebug.inputLevel(),
      recordingError: window.__sonareDebug.recordingError?.() ?? null,
      lastError: window.__sonareDebug.lastError(),
    }));
    throw new Error(`recording never started: ${JSON.stringify(state)}`);
  }
  await assertInputCaptureRequest(page, fail);
  // The engine's input-capture meter must register the fake microphone tone.
  await page.waitForFunction(() => window.__sonareDebug.inputLevel() > 0.001, null, {
    timeout: 5000,
  });
  console.info('input level meter follows the engine input capture');
  // Record one second of the tone.
  await page.waitForTimeout(1000);
  await page.click('.transport-bar .record-button');
  try {
    await page.waitForFunction(
      (before) => window.__sonareDebug.audioClipCount() === before + 1,
      clipsBeforeRecord,
      { timeout: 20000 },
    );
  } catch {
    // Stopping runs a capture read-back and an asset ingest, either of which can
    // decline without the transport showing it. Say which stage it stalled in.
    const state = await page.evaluate(() => ({
      recordingState: window.__sonareDebug.recordingState(),
      isRecording: window.__sonareDebug.isRecording(),
      audioClipCount: window.__sonareDebug.audioClipCount(),
      armedTrackId: window.__sonareDebug.armedTrackId(),
      clipRanges: window.__sonareDebug.clipRanges?.() ?? null,
      recordingError: window.__sonareDebug.recordingError?.() ?? null,
      lastError: window.__sonareDebug.lastError(),
    }));
    throw new Error(
      `recorded take never landed: expected ${clipsBeforeRecord + 1} audio clips, ` +
        JSON.stringify(state),
    );
  }
  console.info(`recorded take landed as a clip: ${clipsBeforeRecord} -> ${clipsBeforeRecord + 1}`);
  await page.click('.transport-bar .transport-key.stop');
}
