import { settings as settingsEn } from '../../../src/ui/i18n/en/settings.ts';
import { shellEditors as editorsEn } from '../../../src/ui/i18n/en/shell-editors.ts';
import { shellFrame as frameEn } from '../../../src/ui/i18n/en/shell-frame.ts';
import { settings as settingsJa } from '../../../src/ui/i18n/ja/settings.ts';
import { shellEditors as editorsJa } from '../../../src/ui/i18n/ja/shell-editors.ts';
import { shellFrame as frameJa } from '../../../src/ui/i18n/ja/shell-frame.ts';
import { openDemo, openFreshPage, skipTour } from '../fresh-page.mjs';

/**
 * Japanese UI: choosing Japanese in Settings relabels the menus, dock tabs and
 * dialogs from the ja message tree, the choice survives a reload, and choosing
 * English restores the English labels. Runs in its own browser context so the
 * shared page keeps its English UI whatever happens here.
 */
export const name = 'language-ja';

const SETTINGS_KEY = 'sonare-studio.settings';

/** Visible chrome the language switch has to relabel, as [selector, en, ja]. */
const LABELS = [
  ['#menubar-trigger-file', frameEn.menus.file, frameJa.menus.file],
  ['#menubar-trigger-edit', frameEn.menus.edit, frameJa.menus.edit],
  ['#menubar-trigger-options', frameEn.menus.options, frameJa.menus.options],
  ['[id="editor-dock-tab-mixer"]', editorsEn.editor.tabs.mixer, editorsJa.editor.tabs.mixer],
  ['[id="editor-dock-tab-roll"]', editorsEn.editor.tabs.pianoRoll, editorsJa.editor.tabs.pianoRoll],
];

const storedLanguage = (page) =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw).settings?.language ?? null) : null;
  }, SETTINGS_KEY);

async function visibleText(page, selector) {
  const text = await page.locator(selector).first().textContent({ timeout: 5000 });
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

async function expectLabels(page, fail, which) {
  const index = which === 'ja' ? 2 : 1;
  for (const entry of LABELS) {
    const actual = await visibleText(page, entry[0]).catch(() => null);
    if (actual !== entry[index]) {
      fail(
        `${which}: ${entry[0]} reads ${JSON.stringify(actual)}, expected ${JSON.stringify(entry[index])}`,
      );
    }
  }
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== which) fail(`${which}: <html lang> is ${JSON.stringify(lang)}`);
}

async function chooseLanguage(page, from, value) {
  const messages = from === 'ja' ? settingsJa : settingsEn;
  await page.click('#menubar-trigger-options');
  await page.locator('[id="menubar-options-options_2e_settings"]').click();
  const dialog = page.locator(`[role="dialog"][aria-label="${messages.title}"]`);
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await dialog.locator(`[role="combobox"][aria-label="${messages.general.language}"]`).click();
  await page.locator(`.select-list .select-option[data-value="${value}"]`).click();
}

export async function run(ctx) {
  const { page: sharedPage, baseUrl, fail } = ctx;
  const { context, page } = await openFreshPage(sharedPage, { locale: 'en-US' });
  try {
    await openDemo(page, baseUrl);
    await skipTour(page);
    await expectLabels(page, fail, 'en');

    // English to Japanese.
    await chooseLanguage(page, 'en', 'ja');
    await page
      .locator(`[role="dialog"][aria-label="${settingsJa.title}"]`)
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 5000 });
    await expectLabels(page, fail, 'ja');
    if ((await storedLanguage(page)) !== 'ja') fail('the Japanese choice was not stored');
    console.info('labels switched to Japanese');

    // It survives a reload.
    await page.reload({ waitUntil: 'load' });
    await page.locator('[data-testid="start-demo"]').waitFor({ state: 'visible', timeout: 30000 });
    if ((await page.evaluate(() => document.documentElement.lang)) !== 'ja') {
      fail('the reloaded page is not Japanese');
    }
    await page.locator('[data-testid="start-demo"]').click();
    await page.waitForFunction(
      () => window.__sonareDebug?.initialized() === true && window.__sonareDebug.noteCount() > 0,
      null,
      { timeout: 30000 },
    );
    await expectLabels(page, fail, 'ja');
    console.info('Japanese labels persisted across a reload');

    // And back to English.
    await chooseLanguage(page, 'ja', 'en');
    await page
      .locator(`[role="dialog"][aria-label="${settingsEn.title}"]`)
      .waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 5000 });
    await expectLabels(page, fail, 'en');
    if ((await storedLanguage(page)) !== 'en') fail('the English choice was not stored');
  } finally {
    await context.close();
  }
}
