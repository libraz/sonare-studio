/**
 * MIDI FX: the transform panel bakes Transpose, Quantize and Harmonize into the
 * notes of the active clip, and one undo takes each back.
 */
export const name = 'midi-fx';

const NOTES = [
  { pitch: 60, startPpq: 0.1, durationPpq: 0.4 },
  { pitch: 62, startPpq: 1.2, durationPpq: 0.4 },
  { pitch: 64, startPpq: 2.3, durationPpq: 0.4 },
  { pitch: 65, startPpq: 3.4, durationPpq: 0.4 },
];
const TOLERANCE_PPQ = 0.01;

const notes = (page) =>
  page.evaluate(() =>
    window.__sonareDebug
      .activeNotes()
      .map((note) => ({ pitch: note.pitch, startPpq: note.startPpq }))
      .sort((a, b) => a.startPpq - b.startPpq || a.pitch - b.pitch),
  );

const same = (actual, expected) =>
  actual.length === expected.length &&
  actual.every(
    (note, index) =>
      note.pitch === expected[index].pitch &&
      Math.abs(note.startPpq - expected[index].startPpq) < TOLERANCE_PPQ,
  );

export async function run(ctx) {
  const { page, fail } = ctx;
  const trackCountBefore = await page.evaluate(() => window.__sonareDebug.trackCount());
  const activeClipBefore = await page.evaluate(() => window.__sonareDebug.activeClipId());
  const added = await page.evaluate(
    (seed) => window.__sonareDebug.addNotedMidiClip('MIDI FX pass', 0, 4, seed),
    NOTES,
  );
  const original = await notes(page);

  await page.click('.dock-tabs button:has-text("Piano Roll")');
  const panel = page.locator('.midi-fx-panel');

  /** Opens the panel, lets `configure` set its controls and presses Apply. */
  const applyFx = async (configure) => {
    await page
      .locator('.roll-toolbar .tb-menu')
      .filter({ hasText: /^\s*MIDI FX\s*$/ })
      .click();
    await panel.waitFor({ state: 'visible', timeout: 5000 });
    await configure();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await panel.waitFor({ state: 'detached', timeout: 5000 });
  };
  /** One undo must restore the notes the clip held before the transform. */
  const undoesToOriginal = async (label) => {
    await page.locator('.undo-toggle').click();
    try {
      await page.waitForFunction(
        (expected) => {
          const now = window.__sonareDebug.activeNotes();
          return (
            now.length === expected.length &&
            expected.every((note) =>
              now.some(
                (n) => n.pitch === note.pitch && Math.abs(n.startPpq - note.startPpq) < 0.01,
              ),
            )
          );
        },
        original,
        { timeout: 5000 },
      );
    } catch {
      fail(`${label}: one undo did not restore the original notes`);
    }
  };

  // Transpose +7 semitones.
  await applyFx(() => panel.locator('#fx-transpose').fill('7'));
  const transposed = await notes(page);
  if (
    !same(
      transposed,
      original.map((note) => ({ ...note, pitch: note.pitch + 7 })),
    )
  ) {
    fail(`Transpose +7 gave ${JSON.stringify(transposed)}`);
  }
  await undoesToOriginal('Transpose');

  // Quantize to the 1/8 grid at full strength.
  await applyFx(async () => {
    await panel
      .getByRole('group', { name: 'Quantize grid' })
      .getByRole('button', { name: '1/8', exact: true })
      .click();
    await panel.locator('#fx-q-strength').fill('1');
  });
  const quantized = await notes(page);
  const snapped = original.map((note) => ({
    ...note,
    startPpq: Math.round(note.startPpq / 0.5) * 0.5,
  }));
  if (!same(quantized, snapped)) fail(`Quantize 1/8 gave ${JSON.stringify(quantized)}`);
  await undoesToOriginal('Quantize');

  // Harmonize with a major triad: every note gains two voices.
  await applyFx(() =>
    panel
      .getByRole('group', { name: 'Harmonize chord' })
      .getByRole('button', { name: 'Major', exact: true })
      .click(),
  );
  const harmonized = await notes(page);
  const root = harmonized.filter((note) => original.some((o) => o.pitch === note.pitch));
  if (harmonized.length !== original.length * 3 || root.length < original.length) {
    fail(`Harmonize Major gave ${harmonized.length} notes from ${original.length}`);
  }
  await undoesToOriginal('Harmonize');
  console.info(
    `MIDI FX: transpose ${JSON.stringify(transposed.map((n) => n.pitch))}, ` +
      `quantize ${JSON.stringify(quantized.map((n) => n.startPpq))}, ` +
      `harmonize ${harmonized.length} notes`,
  );

  await page.evaluate((id) => window.__sonareDebug.removeTrack(id), added.trackId);
  await page.waitForFunction(
    (count) => window.__sonareDebug.trackCount() === count,
    trackCountBefore,
    { timeout: 5000 },
  );
  await page.evaluate((id) => window.__sonareDebug.selectClip(id), activeClipBefore);
}
