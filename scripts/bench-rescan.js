// Offline benchmark of the content script on a PR that streams in file by
// file, as GitHub does. Times only the extension's own work: its mutation
// callback and its debounced scans.
//
//   node scripts/bench-rescan.js [--files 300] [--layout classic|react] [--runs 3]
//   EXTENSION_DIR=/path/to/another/checkout node scripts/bench-rescan.js
//
// Every file arrives after the previous scan has run, so each one costs one
// scan: the case where rescanning the whole page hurts most.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { classicFile, reactFile, pageHtml, SAMPLE_FILES } = require('../browser/github-pages.js');

const ROOT = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '..'));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const FILES = Number(arg('files', 300));
const RUNS = Number(arg('runs', 3));
const LAYOUT = arg('layout', 'classic');

// Four hunks of ordinary code per file, plus a flagged one every tenth file.
function makeFile(n) {
  const hunks = Array.from({ length: 4 }, (_, h) => ({
    removed: Array.from({ length: 6 }, (_, i) => `    const value${i} = compute(input, ${h * 10 + i});`),
    added: Array.from({ length: 6 }, (_, i) => `    const value${i} = computeAll(input, options, ${h * 10 + i});`),
  }));
  if (n % 10 === 0) hunks.push(...SAMPLE_FILES[0].hunks);
  return { path: `src/module${n}/file${n}.js`, hunks };
}

async function once() {
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  const url = `https://github.com/acme/bench/pull/1/${LAYOUT === 'classic' ? 'files' : 'changes'}`;
  await page.route('**/*', (route) =>
    route.request().url() === url ? route.fulfill({ contentType: 'text/html', body: pageHtml(LAYOUT, [makeFile(0)]) }) : route.abort()
  );
  await page.goto(url);
  // Time the content script's two entry points before it is loaded.
  await page.evaluate(() => {
    window.__spent = 0;
    window.__scans = 0;
    const timed = (fn, isScan) => function (...args) {
      const t = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        window.__spent += performance.now() - t;
        if (isScan) window.__scans++;
      }
    };
    const Native = window.MutationObserver;
    window.MutationObserver = class extends Native {
      constructor(callback) {
        super(timed(callback, false));
      }
    };
    const nativeTimeout = window.setTimeout.bind(window);
    window.__timeout = nativeTimeout;
    window.setTimeout = (fn, delay, ...rest) => nativeTimeout(delay >= 100 ? timed(fn, true) : fn, delay, ...rest);
    window.chrome = window.chrome || {};
    window.chrome.storage = { local: { get: (d, cb) => cb && cb(Array.isArray(d) ? {} : { ...d }), set() {} }, onChanged: { addListener() {} } };
    window.chrome.runtime = { sendMessage() {} };
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const file of manifest.content_scripts[0].js) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, file), 'utf8') });
  }
  await page.waitForSelector('#driskh-summary-bar .driskh-count');

  const render = LAYOUT === 'classic' ? classicFile : reactFile;
  const list = LAYOUT === 'classic' ? '#files' : '[data-testid="progressive-diffs-list"]';
  const html = Array.from({ length: FILES - 1 }, (_, i) => render(makeFile(i + 1)));
  const result = await page.evaluate(
    async ({ html, list }) => {
      const sleep = (ms) => new Promise((r) => window.__timeout(r, ms));
      window.__spent = 0;
      window.__scans = 0;
      for (const file of html) {
        document.querySelector(list).insertAdjacentHTML('beforeend', file);
        const before = window.__scans;
        while (window.__scans === before) await sleep(20);
      }
      await sleep(2500); // let any trailing scan run
      return {
        spentMs: Math.round(window.__spent),
        scans: window.__scans,
        marked: document.querySelectorAll('tr[data-driskh-level]').length,
        badges: document.querySelectorAll('.driskh-badge').length,
        summary: document.querySelector('#driskh-summary-bar .driskh-total')?.textContent.trim(),
      };
    },
    { html, list }
  );
  await browser.close();
  return result;
}

(async () => {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await once());
  const times = runs.map((r) => r.spentMs).sort((a, b) => a - b);
  const { scans, marked, badges, summary } = runs[0];
  console.log(JSON.stringify({ layout: LAYOUT, files: FILES, scans, marked, badges, summary, medianMs: times[Math.floor(times.length / 2)], allMs: times }));
})();
