// Runs the self-checking fixture pages (they load the real src/ files) and
// fails if any check inside them fails.

const { test, expect } = require('@playwright/test');

const BASE = 'http://127.0.0.1:8934/test/dom/pull/999';

test('React-layout fixture: every in-page check passes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/changes/new-ui-fixture.html`);
  await page.waitForFunction(() => window.__newUiTestResult, null, { timeout: 40_000 });
  const result = await page.evaluate(() => window.__newUiTestResult);
  expect(result.failed).toEqual([]);
  expect(errors).toEqual([]);
});

test('classic-layout fixture: the observer settles and does not retrigger itself', async ({ page }) => {
  await page.goto(`${BASE}/files/self-trigger-regression.html`);
  await page.waitForFunction(() => window.__selfTriggerTestResult, null, { timeout: 20_000 });
  const result = await page.evaluate(() => window.__selfTriggerTestResult);
  expect(result).toMatchObject({ growth: 0, badgeFound: true, pass: true });
});
