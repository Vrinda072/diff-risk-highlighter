// End-to-end for the optional "Explain" feature, through the real extension
// on a live pull request: first-run guidance, the options page, and (opt-in)
// a real answer from a local Ollama model.
//
//   npm run test:e2e                      # setup + options-page tests
//   OLLAMA_E2E=1 npm run test:e2e         # also asks a real local model
//
// The Ollama tests need `ollama serve` running with
//   OLLAMA_ORIGINS="chrome-extension://*"
// and a model pulled; set OLLAMA_MODEL to override the default (qwen3).

const { test, expect } = require('./extension-fixture.js');

const PR_URL = 'https://github.com/stellar/passkey-kit/pull/4/files';
const OLLAMA = Boolean(process.env.OLLAMA_E2E);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3';

async function serviceWorker(context) {
  const [existing] = context.serviceWorkers();
  return existing || context.waitForEvent('serviceworker');
}

async function openPrWithExplainButton(context) {
  const page = await context.newPage();
  await page.goto(PR_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.driskh-explain-btn').first()).toBeVisible({ timeout: 60_000 });
  return page;
}

test.describe.serial('Explain', () => {
  let sw;
  let optionsUrl;

  test.beforeAll(async ({ extensionContext }) => {
    sw = await serviceWorker(extensionContext);
    await sw.evaluate(() => chrome.storage.local.clear());
    optionsUrl = `chrome-extension://${new URL(sw.url()).host}/src/options.html`;
  });

  test.afterAll(async () => {
    await sw.evaluate(() => chrome.storage.local.clear());
  });

  test('before a provider is chosen, Explain says so and opens the options page', async ({ extensionContext }) => {
    const page = await openPrWithExplainButton(extensionContext);
    const opened = extensionContext.waitForEvent('page', (p) => p.url().includes('options.html'));
    await page.locator('.driskh-explain-btn').first().click();
    await expect(page.locator('.driskh-explain-error').first()).toContainText(/options/i);
    const options = await opened;
    await expect(options.getByRole('heading', { name: 'Explain settings' })).toBeVisible();
    await options.close();
    await page.close();
  });

  test('the options page saves a free Gemini setup (no network call is made)', async ({ extensionContext }) => {
    const page = await extensionContext.newPage();
    await page.goto(optionsUrl);
    await page.locator('input[name="provider"][value="gemini"]').check();
    await page.locator('#geminiKey').fill('AIza-test-key');
    await page.locator('#geminiModel').fill('gemini-2.5-flash-lite');
    await page.locator('#save').click();
    await expect(page.locator('#status')).toHaveText('Saved.');

    const stored = await sw.evaluate(() => chrome.storage.local.get('driskhSettings'));
    expect(stored.driskhSettings).toMatchObject({
      provider: 'gemini',
      geminiKey: 'AIza-test-key',
      geminiModel: 'gemini-2.5-flash-lite',
    });

    await page.reload(); // survives a reload, and shows the saved choice
    await expect(page.locator('input[name="provider"][value="gemini"]')).toBeChecked();
    await expect(page.locator('#geminiKey')).toHaveValue('AIza-test-key');
    await page.close();
  });

  test('a bad Gemini key is reported on the page, not swallowed', async ({ extensionContext }) => {
    // Real request to Google with a bogus key: it must come back as a clear
    // "rejected" message. (Skips itself if Google is unreachable.)
    const page = await openPrWithExplainButton(extensionContext);
    await page.locator('.driskh-explain-btn').first().click();
    const err = page.locator('.driskh-explain-error').first();
    await expect(err).toBeVisible({ timeout: 30_000 });
    const text = (await err.textContent()) || '';
    test.skip(/reach/i.test(text), 'Google was unreachable from this machine');
    expect(text).toMatch(/rejected|key/i);
    await page.close();
  });

  test.describe('with a local Ollama model', () => {
    test.skip(!OLLAMA, 'set OLLAMA_E2E=1 to run (needs a running Ollama with OLLAMA_ORIGINS set)');
    test.setTimeout(240_000);

    test.beforeAll(async () => {
      await sw.evaluate(
        (model) => chrome.storage.local.set({ driskhSettings: { provider: 'ollama', ollamaModel: model } }),
        OLLAMA_MODEL
      );
    });

    test('options page "Save and test" gets a real answer', async ({ extensionContext }) => {
      const page = await extensionContext.newPage();
      await page.goto(optionsUrl);
      await expect(page.locator('input[name="provider"][value="ollama"]')).toBeChecked();
      await page.locator('#test').click();
      await expect(page.locator('#status')).toContainText('It works', { timeout: 180_000 });
      await page.close();
    });

    test('clicking Explain on a live high-risk hunk shows a model-written sentence', async ({ extensionContext }) => {
      const page = await openPrWithExplainButton(extensionContext);
      await page.locator('.driskh-explain-btn').first().click();
      const note = page.locator('.driskh-explanation:not(.driskh-explain-error)').first();
      await expect(note).toBeVisible({ timeout: 180_000 });
      const text = ((await note.textContent()) || '').replace('💡', '').trim();
      expect(text.length).toBeGreaterThan(30);
      expect(text).not.toMatch(/<think>/);
      await expect(page.locator('.driskh-explain-error')).toHaveCount(0);
      await page.close();
    });
  });
});
