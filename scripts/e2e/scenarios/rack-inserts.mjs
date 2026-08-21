/** Device rack: insert add/bypass are realtime (no re-schedule). */
export const name = 'rack-inserts';

export async function run(ctx) {
  const { page, fail } = ctx;

  // The picker is the app's own listbox, not a native <select>: its options
  // are teleported to the body and only exist while it is open.
  await page.click('.device-rack .add-insert .select-trigger');
  await page.waitForSelector('.select-list [role="option"]', { timeout: 5000 });
  const insertChoice = await page.evaluate(() => {
    const values = [...document.querySelectorAll('.select-list [role="option"]')]
      .filter((el) => el.getAttribute('aria-disabled') !== 'true')
      .map((el) => el.getAttribute('data-value'))
      .filter((value) => value !== null && value.length > 0);
    return (
      values.find((value) => value === 'saturation.softClipper') ??
      values.find((value) => value.startsWith('dynamics.')) ??
      values[0] ??
      null
    );
  });
  if (!insertChoice) {
    await page.keyboard.press('Escape');
    fail('device rack offers no insert processors');
  } else {
    const idsBeforeInsert = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    );
    const insertCountsBefore = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.trackInsertCounts()),
    );
    await page.click(`.select-list [role="option"][data-value="${insertChoice}"]`);
    await page.waitForFunction(
      (before) => JSON.stringify(window.__sonareDebug.trackInsertCounts()) !== before,
      insertCountsBefore,
      { timeout: 10000 },
    );
    await page.waitForTimeout(400);
    const insertAddState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (insertAddState.pending || insertAddState.ids !== idsBeforeInsert) {
      fail(`insert add caused a re-schedule: pending=${insertAddState.pending}`);
    }
    console.info(`insert "${insertChoice}" added without re-scheduling`);

    const statesBeforeBypass = await page.evaluate(() =>
      JSON.stringify(window.__sonareDebug.trackInsertStates()),
    );
    await page.click('.device-rack .insert-power');
    await page.waitForFunction(
      (before) => JSON.stringify(window.__sonareDebug.trackInsertStates()) !== before,
      statesBeforeBypass,
      { timeout: 10000 },
    );
    await page.waitForTimeout(400);
    const bypassState = await page.evaluate(() => ({
      pending: window.__sonareDebug.applyPending(),
      ids: JSON.stringify(window.__sonareDebug.scheduledClipIds()),
    }));
    if (bypassState.pending || bypassState.ids !== idsBeforeInsert) {
      fail(`insert bypass caused a re-schedule: pending=${bypassState.pending}`);
    }
    console.info('insert bypass toggled without re-scheduling');
  }
}
