/** Arrangement: add a track and draw a clip on it. */
export const name = 'track-and-clip';

export async function run(ctx) {
  const { page, fail } = ctx;
  const { demoTrackCount } = ctx.state;

  // Add a MIDI track via the arrangement header column's add-track menu.
  const expectedTracks = demoTrackCount + 1;
  await page.click('.track-headers .add-track');
  await page.click('.add-track-items button:has-text("MIDI track")');
  await page.waitForFunction(
    (expected) => window.__sonareDebug.trackCount() === expected,
    expectedTracks,
    { timeout: 5000 },
  );
  const headerCount = await page.locator('.track-headers .track-header').count();
  if (headerCount !== expectedTracks) {
    fail(`expected ${expectedTracks} track headers after adding a track, got ${headerCount}`);
  } else {
    console.info(`track added: ${expectedTracks} track headers`);
  }

  // Double-click the newly added (empty) bottom lane to create a one-bar clip.
  const clipsBefore = await page.evaluate(() => window.__sonareDebug.clipCount());
  const arrangeCanvas = page.locator('.arrangement-canvas');
  await arrangeCanvas.waitFor({ state: 'visible', timeout: 5000 });
  const arrangeBox = await arrangeCanvas.boundingBox();
  if (!arrangeBox || arrangeBox.width <= 0 || arrangeBox.height <= 0) {
    fail(`arrangement canvas has no size: ${JSON.stringify(arrangeBox)}`);
  }
  // The added lane sits below the 28 px ruler plus the demo's lanes (56 px each);
  // aim mid-lane.
  const newLaneY = arrangeBox.y + 28 + demoTrackCount * 56 + 28;
  await page.mouse.dblclick(arrangeBox.x + arrangeBox.width * 0.3, newLaneY);
  await page.waitForFunction(
    (before) => window.__sonareDebug.clipCount() === before + 1,
    clipsBefore,
    { timeout: 5000 },
  );
  console.info(`clip created on the new lane: ${clipsBefore} -> ${clipsBefore + 1}`);

  ctx.state.expectedTracks = expectedTracks;
}
