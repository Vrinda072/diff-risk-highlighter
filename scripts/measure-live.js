// Measures how long the REAL extension keeps a live GitHub page frozen.
//
//   node scripts/measure-live.js owner/repo#123 [--load-all] [--no-extension]
//   EXTENSION_DIR=/path/to/another/build measures a different version.
//
// Loads this folder unpacked into Chromium, opens the PR's Files tab, and
// records browser "long tasks" (main thread busy for 50 ms or more, during
// which the page cannot respond). --load-all clicks every "Load diff" button,
// as a reviewer would on a huge PR. --no-extension is the control run: the
// difference between the two is what the extension costs. Needs network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '..'));
const target = process.argv.find((a) => /^[\w.-]+\/[\w.-]+#\d+$/.test(a));
if (!target) throw new Error('usage: node scripts/measure-live.js owner/repo#123 [--load-all] [--no-extension]');
const loadAll = process.argv.includes('--load-all');
const control = process.argv.includes('--no-extension');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-measure-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 900 },
    args: control ? [] : [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
  });
  const [repo, number] = target.split('#');
  const started = Date.now();
  await page.goto(`https://github.com/${repo}/pull/${number}/files`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForSelector(control ? '.file[data-tagsearch-path], table[aria-label^="Diff for: "]' : '#driskh-summary-bar .driskh-count', { timeout: 120_000 });
  const firstResultMs = Date.now() - started;
  await page.waitForTimeout(4000);

  let clicked = 0;
  if (loadAll) {
    const buttons = page.getByRole('button', { name: /^load diff$/i });
    for (let rounds = 0; rounds < 400 && (await buttons.count()) > 0; rounds++) {
      await buttons.first().click({ timeout: 5000 }).catch(() => {});
      clicked++;
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(8000);
  }

  const result = await page.evaluate(() => ({
    ...JSON.parse(document.documentElement.dataset.driskhProfile || '{}'),
    diffLinesRendered: document.querySelectorAll('td.blob-code, td.diff-text-cell').length,
    files: document.querySelectorAll('.file[data-tagsearch-path], table[aria-label^="Diff for: "]').length,
    hunksScored: document.querySelectorAll('tr[data-driskh-level]').length,
    longTasks: window.__longTasks.length,
    longestMs: Math.round(Math.max(0, ...window.__longTasks)),
    blockedMs: Math.round(window.__longTasks.reduce((a, b) => a + b, 0)),
  }));
  console.log(
    JSON.stringify({ target, extension: !control, loadAll, loadClicks: clicked, firstResultMs, ...result })
  );
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
})();
