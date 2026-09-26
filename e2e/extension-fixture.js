// Playwright fixture that launches Chromium with this repo loaded as an
// unpacked extension (--load-extension), exactly as a user would via
// chrome://extensions → "Load unpacked". Extensions only load in a
// persistent context, and only in full Chromium (channel: 'chromium'),
// which also supports extensions in headless mode — the stripped-down
// headless shell Playwright uses by default does not.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { test: base, chromium, expect } = require('@playwright/test');

const EXTENSION_PATH = path.resolve(__dirname, '..');

// GitHub only serves its new React "Files changed" UI (/pull/<n>/changes)
// to signed-in sessions; anonymous requests to /changes get a 302 to the
// classic /files page. So by default this suite exercises the classic UI.
// To exercise the new UI, save a signed-in session once with
// `npm run test:e2e:login` (you sign in yourself, in a real browser
// window) — its cookies are then loaded here. Gitignored.
const SESSION_FILE = process.env.E2E_GITHUB_SESSION || path.join(__dirname, '.auth', 'github.json');

const test = base.extend({
  // Worker-scoped: one browser (and one extension load) per worker, not
  // per test — the live-GitHub tests are slow enough already.
  extensionContext: [
    async ({}, use) => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-e2e-'));
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: !process.env.HEADED,
        viewport: { width: 1400, height: 1000 },
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
        ],
      });
      if (fs.existsSync(SESSION_FILE)) {
        await context.addCookies(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).cookies);
      }
      await use(context);
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],

  page: async ({ extensionContext }, use) => {
    const page = await extensionContext.newPage();
    await use(page);
    await page.close();
  },
});

module.exports = { test, expect, EXTENSION_PATH, SESSION_FILE };
