// Offline browser suite (npm run test:browser): runs in CI on every push.
// It never touches the network: the fixture pages are served locally, and the
// packaged-extension tests answer github.com URLs from local markup. The live
// GitHub suite is separate (playwright.config.js).

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'browser',
  testMatch: '*.spec.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  webServer: {
    command: 'node scripts/static-server.js 8934',
    url: 'http://127.0.0.1:8934/package.json',
    reuseExistingServer: !process.env.CI,
  },
});
