// Tests the artifact we would actually ship: build the release ZIP, unpack it
// into a temp folder, load THAT folder into Chromium, and drive it on both
// GitHub layouts. github.com requests are answered from local markup, so this
// is the real extension with no network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test: base, expect, chromium } = require('@playwright/test');
const { build } = require('../scripts/package.js');
const { classicFile, reactFile, pageHtml, SAMPLE_FILES, LATE_FILE } = require('./github-pages.js');

const LAYOUTS = {
  classic: { url: 'https://github.com/acme/demo/pull/1/files', render: classicFile, list: '#files' },
  react: { url: 'https://github.com/acme/demo/pull/2/changes', render: reactFile, list: '[data-testid="progressive-diffs-list"]' },
};

const test = base.extend({
  ext: [
    async ({}, use) => {
      const { zip, files } = build();
      const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-zip-'));
      execFileSync('unzip', ['-q', zip, '-d', unpacked]);
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-profile-'));
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
      });
      await context.route(/^https?:\/\//, (route) => {
        const url = route.request().url();
        const layout = Object.keys(LAYOUTS).find((k) => url === LAYOUTS[k].url);
        if (layout) return route.fulfill({ contentType: 'text/html', body: pageHtml(layout, SAMPLE_FILES) });
        return route.abort();
      });
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker');
      await use({ context, worker, unpacked, files });
      await context.close();
      fs.rmSync(unpacked, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
});

test('the ZIP holds exactly the runtime files', async ({ ext }) => {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(ext.unpacked, full).split(path.sep).join('/'));
    }
  })(ext.unpacked);
  // Chromium may add its own _metadata folder to a loaded extension.
  expect(found.filter((f) => !f.startsWith('_metadata/')).sort()).toEqual([...ext.files].sort());
});

test('the service worker starts from the packaged files', async ({ ext }) => {
  const info = await ext.worker.evaluate(() => ({
    name: chrome.runtime.getManifest().name,
    explainLoaded: typeof self.DriskhExplain,
  }));
  expect(info).toEqual({ name: 'Diff Risk Highlighter', explainLoaded: 'object' });
});

for (const [layout, cfg] of Object.entries(LAYOUTS)) {
  test(`${layout} layout: scan, lazy load, toggle, remount, tab switch, settles`, async ({ ext }) => {
    const page = await ext.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && /chrome-extension/.test(m.location().url || '') && errors.push(m.text()));
    await page.goto(cfg.url);

    const bar = page.locator('#driskh-summary-bar');
    const pill = (level) => bar.locator(`.driskh-count--${level} b`);
    const counts = async (high, medium, low) => {
      await expect(pill('high')).toHaveText(String(high));
      await expect(pill('medium')).toHaveText(String(medium));
      await expect(pill('low')).toHaveText(String(low));
    };
    // The real content script, injected by Chromium from the unpacked ZIP.
    await counts(1, 1, 1);
    await expect(page.locator('.driskh-badge--high')).toHaveCount(1);
    await expect(page.locator('.driskh-badge--medium')).toHaveCount(1);
    await expect(page.locator('.driskh-explain-btn')).toHaveCount(1);

    // A file GitHub loads later gets scanned and added to the summary.
    await page.evaluate(([sel, html]) => document.querySelector(sel).insertAdjacentHTML('beforeend', html), [cfg.list, cfg.render(LATE_FILE)]);
    await counts(2, 1, 1);
    await expect(page.locator('.driskh-badge--high')).toHaveCount(2);

    const toggle = bar.locator('.driskh-switch');
    await toggle.click();
    await expect(page.locator('.driskh-badge').first()).toBeHidden();
    await toggle.click();
    await expect(page.locator('.driskh-badge').first()).toBeVisible();

    // The page re-renders and throws our bar away: it must come back, filled.
    await page.evaluate(() => {
      document.getElementById('driskh-summary-bar').remove();
      document.body.appendChild(document.createElement('span'));
    });
    await counts(2, 1, 1);

    // Leaving the Files tab without a reload removes the bar; returning restores it.
    await page.evaluate(() => {
      history.pushState(null, '', location.pathname.replace(/\/(files|changes)$/, ''));
      document.body.appendChild(document.createElement('span'));
    });
    await expect(bar).toHaveCount(0);
    await page.evaluate((url) => {
      history.pushState(null, '', url);
      document.body.appendChild(document.createElement('span'));
    }, cfg.url);
    await counts(2, 1, 1);

    // Idle page: no DOM writes should keep happening (self-retrigger loop).
    await page.waitForTimeout(600);
    const mutations = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const observer = new MutationObserver((list) => (n += list.length));
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(n);
          }, 1500);
        })
    );
    expect(mutations).toBe(0);

    // With no provider chosen, Explain says so (and opens the options page).
    const opened = ext.context.waitForEvent('page', (p) => p.url().includes('options.html'));
    await page.locator('.driskh-explain-btn').first().click();
    await expect(page.locator('.driskh-explain-error').first()).toContainText(/options/i);
    const options = await opened;
    await expect(options.getByRole('heading', { name: 'Explain settings' })).toBeVisible();
    await options.close();

    expect(errors).toEqual([]);
    await page.close();
  });
}
