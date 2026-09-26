// `npm run test:e2e:login` — opens a normal Chromium window on GitHub's
// sign-in page. Sign in yourself; once GitHub reports a signed-in user,
// the session cookies are saved to e2e/.auth/github.json (gitignored) so
// `npm run test:e2e` runs against the new React Files-changed UI instead
// of the classic one anonymous sessions get. Delete the file to go back.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { SESSION_FILE } = require('./extension-fixture.js');

(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://github.com/login');
  console.log('Sign in to GitHub in the browser window (waiting up to 5 minutes)...');

  await page.waitForFunction(
    () => !!document.querySelector('meta[name="user-login"]')?.content,
    null,
    { timeout: 5 * 60_000, polling: 1000 }
  );

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  console.log(`Saved signed-in session to ${SESSION_FILE}`);
  await browser.close();
})();
