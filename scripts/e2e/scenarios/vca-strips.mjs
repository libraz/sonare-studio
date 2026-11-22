/**
 * VCA strips: a group created from the track header menu and driven from its
 * mixer fader lowers its member in the rendered loop region and leaves
 * non-members alone.
 */
export const name = 'vca-strips';

const LOOP = { startPpq: 1, endPpq: 3 };
const FADER_STEPS_DOWN = 12;
const MEMBER = 'VCA member';
const FREE = 'VCA free';

const probe = (page) =>
  page.evaluate((range) => window.__sonareDebug.exportProbe(false, range, true), LOOP);

const stemPeak = (result, trackName) => {
  const stem = result.stems?.find((entry) => entry.name === trackName);
  if (!stem) throw new Error(`no stem named ${trackName}: ${JSON.stringify(result.stems)}`);
  return stem.peakDb;
};

export async function run(ctx) {
  const { page, fail } = ctx;
  const created = await page.evaluate(
    async ([member, free]) => {
      const memberId = window.__sonareDebug.addAudioTrack(member);
      const freeId = window.__sonareDebug.addAudioTrack(free);
      await window.__sonareDebug.addToneClip(memberId, 4, 220, 0.5, 0);
      await window.__sonareDebug.addToneClip(freeId, 4, 330, 0.01, 0);
      // Silence the demo so the mix peak is this track's own level.
      const others = window.__sonareDebug
        .trackIds()
        .filter((id) => id !== memberId && id !== freeId);
      for (const id of others) {
        window.__sonareDebug.setAutomationLanePoints(id, 'faderDb', [
          { ppq: 0, value: -120, curve: 'hold' },
        ]);
      }
      return { memberId, freeId, others };
    },
    [MEMBER, FREE],
  );
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });
  // A loop region needs the running engine, which the boot scenario started.
  await page.evaluate(
    (range) => window.__sonareDebug.setLoopRange(range.startPpq, range.endPpq, true),
    LOOP,
  );
  const open = await probe(page);

  // Create the group from the member's header menu; it assigns the track too.
  await page
    .locator('.track-headers .track-header', { hasText: MEMBER })
    .first()
    .click({ button: 'right' });
  await page.locator('.context-menu-item[data-menu-item-id="vca-new"]').click();
  const group = await page.evaluate((memberName) => {
    const doc = window.__sonareDebug.projectDocument();
    const track = doc.tracks.find((entry) => entry.name === memberName);
    return { vcaId: track?.vcaId ?? null, groups: doc.mixer?.vcaGroups ?? [] };
  }, MEMBER);
  if (group.vcaId === null || group.groups.length !== 1) {
    fail(`the VCA group was not created and assigned: ${JSON.stringify(group)}`);
  }

  // Move the group's fader down from the mixer.
  await page.click('.dock-tabs button:has-text("Mixer")');
  const slider = page.locator('.vca-strip [role="slider"]').first();
  await slider.waitFor({ state: 'visible', timeout: 10000 });
  await slider.focus();
  for (let step = 0; step < FADER_STEPS_DOWN; step += 1) await page.keyboard.press('ArrowDown');
  const gainDb = await page.evaluate(
    () => window.__sonareDebug.projectDocument().mixer?.vcaGroups?.[0]?.gainDb ?? null,
  );
  if (gainDb === null || Math.abs(gainDb + FADER_STEPS_DOWN) > 0.5) {
    fail(`the VCA fader did not reach -${FADER_STEPS_DOWN} dB: ${gainDb}`);
  }
  await page.waitForFunction(() => window.__sonareDebug.applyPending() === false, null, {
    timeout: 20000,
  });

  const lowered = await probe(page);
  const memberDelta = stemPeak(lowered, MEMBER) - stemPeak(open, MEMBER);
  const freeDelta = stemPeak(lowered, FREE) - stemPeak(open, FREE);
  const mixDelta = lowered.peakDb - open.peakDb;
  if (Math.abs(memberDelta - gainDb) > 0.5) {
    fail(`member stem moved ${memberDelta.toFixed(2)} dB, the VCA is at ${gainDb} dB`);
  }
  if (Math.abs(freeDelta) > 0.1) fail(`a non-member stem moved ${freeDelta.toFixed(2)} dB`);
  if (Math.abs(mixDelta - gainDb) > 2) {
    fail(`loop-region mix moved ${mixDelta.toFixed(2)} dB, the VCA is at ${gainDb} dB`);
  }
  console.info(
    `VCA ${gainDb} dB: member ${memberDelta.toFixed(2)} dB, non-member ` +
      `${freeDelta.toFixed(2)} dB, loop mix ${mixDelta.toFixed(2)} dB`,
  );

  await page.evaluate(({ memberId, freeId, others }) => {
    window.__sonareDebug.setLoopRange(0, 8, false);
    for (const id of others) window.__sonareDebug.removeAutomationLane(id, 'faderDb');
    window.__sonareDebug.removeTrack(memberId);
    window.__sonareDebug.removeTrack(freeId);
  }, created);
  // The group outlives its members; take it out through its own strip.
  await page.locator('.vca-strip .vca-remove').first().click();
  await page.waitForFunction(
    () => (window.__sonareDebug.projectDocument().mixer?.vcaGroups ?? []).length === 0,
    null,
    { timeout: 5000 },
  );
}
