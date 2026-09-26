// E2E suite (npm run test:e2e): loads the unpacked extension into
// Chromium and runs it against live GitHub PR pages. Kept out of test/
// on purpose — `npm test` (node --test test/) runs every .js file under
// test/, and this suite needs a browser and the network.

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.js',
  // Live github.com: allow for slow page loads, retry once for network
  // flakiness, and cap parallelism so anonymous requests don't get
  // rate-limited.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 1,
  workers: 4,
  reporter: [['list']],
});
