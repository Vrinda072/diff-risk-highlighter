// Records docs/img/demo.webm and docs/img/live-dark.png: the REAL extension
// (this folder, loaded unpacked into Chromium exactly like the e2e suite
// does) running in GitHub's dark theme on a live pull request.
//
//   npm install && npx playwright install chromium
//   node scripts/record-demo.js          # then: python3 scripts/make-gif.py
//
// The cursor and the captions are drawn by THIS script into the page for the
// recording only — they are not part of the extension. Needs network access.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'img');
const PR_URL = process.env.DEMO_PR || 'https://github.com/stellar/passkey-kit/pull/4/files';
const SIZE = { width: 1120, height: 680 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(extra) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-demo-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    colorScheme: 'dark',
    viewport: SIZE,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    ...extra,
  });
  return { context, cleanup: () => fs.rmSync(userDataDir, { recursive: true, force: true }) };
}

// Waits until the extension has classified every real (@@) hunk on the page,
// clicking GitHub's own "Load diff" buttons so lazy files are included.
async function waitUntilScanned(page) {
  const loadButtons = page.getByRole('button', { name: /^load diff$/i });
  for (let i = 0; i < 40; i++) {
    for (const button of await loadButtons.all()) await button.click({ timeout: 3000 }).catch(() => {});
    const ready = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('td.blob-code-hunk, td.diff-hunk-cell')].filter((td) => td.textContent.trim());
      return cells.length > 0 && cells.every((td) => td.closest('tr').dataset.driskhLevel) && !!document.querySelector('#driskh-summary-bar .driskh-pill');
    });
    if (ready) return;
    await sleep(750);
  }
  throw new Error('extension never finished scanning ' + PR_URL);
}

const OVERLAY = () => {
  const add = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
        margin: -3px 0 0 -3px; transition: transform .04s linear; }
      #demo-cursor svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
      .demo-ripple { position: fixed; z-index: 2147483646; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
        border: 2px solid #58a6ff; pointer-events: none; animation: demo-ripple .5s ease-out forwards; }
      @keyframes demo-ripple { to { transform: scale(3.2); opacity: 0; } }
      #demo-caption { position: fixed; z-index: 2147483647; left: 50%; bottom: 22px; transform: translateX(-50%);
        max-width: 80vw; padding: 9px 18px; border-radius: 999px; background: rgba(13,17,23,.94); color: #f0f6fc;
        border: 1px solid #3d444d; font: 600 15px/1.3 -apple-system, "Segoe UI", sans-serif; letter-spacing: .01em;
        box-shadow: 0 8px 24px rgba(1,4,9,.55); pointer-events: none; opacity: 0; transition: opacity .25s; }
      #demo-caption.on { opacity: 1; }`;
    document.documentElement.appendChild(style);
    const cur = document.createElement('div');
    cur.id = 'demo-cursor';
    cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 7.5-6 1.8-2.6 5.6z" fill="#fff" stroke="#0d1117" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cur);
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    document.documentElement.appendChild(cap);
    addEventListener('mousemove', (e) => { cur.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
};

async function caption(page, text) {
  await page.evaluate((t) => {
    const el = document.getElementById('demo-caption');
    if (!el) return;
    if (!t) return el.classList.remove('on');
    el.textContent = t;
    el.classList.add('on');
  }, text);
}

async function glide(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box for target');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await sleep(250);
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1) The video.
  const rec = await launch({ recordVideo: { dir: path.join(os.tmpdir(), 'driskh-video'), size: SIZE } });
  const videoStart = Date.now();
  const page = await rec.context.newPage();
  await page.addInitScript(OVERLAY);
  await page.goto(PR_URL, { waitUntil: 'domcontentloaded' });
  await waitUntilScanned(page);
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.move(640, 380);
  await sleep(600);
  const trimSeconds = (Date.now() - videoStart) / 1000 - 0.4;

  await page.evaluate(() => document.getElementById('driskh-summary-bar').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => scrollBy(0, -70)); // leave GitHub's header out of the way
  await caption(page, 'Open any pull request. The extension scans every hunk.');
  await sleep(3200);

  const chips = page.locator('#driskh-summary-bar .driskh-jump-chip');
  const chipCount = await chips.count();
  await caption(page, 'Jump straight to the high-risk hunks');
  for (let i = 0; i < Math.min(chipCount, 2); i++) {
    await glide(page, chips.nth(i));
    await chips.nth(i).click();
    await sleep(3000);
  }

  await caption(page, 'Docs, renames and reformatting stay untouched');
  const prose = page.locator('.file[data-tagsearch-path="CHANGELOG.md"]').first();
  if (await prose.count()) {
    await prose.scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollBy(0, -140));
  }
  await sleep(3200);

  await page.evaluate(() => document.getElementById('driskh-summary-bar').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => scrollBy(0, -70));
  await caption(page, 'One click turns highlighting off…');
  await sleep(900);
  const toggle = page.locator('#driskh-summary-bar .driskh-switch');
  await glide(page, toggle);
  await toggle.click();
  await sleep(2200);
  await caption(page, '…and back on');
  await toggle.click();
  await sleep(2400);
  await caption(page, '');
  await sleep(500);

  const videoPath = await page.video().path();
  await page.close();
  await rec.context.close();
  rec.cleanup();
  fs.copyFileSync(videoPath, path.join(OUT, 'demo.webm'));
  fs.writeFileSync(path.join(OUT, '.demo-trim'), String(trimSeconds.toFixed(2)));
  console.log(`wrote docs/img/demo.webm (trim first ${trimSeconds.toFixed(2)}s)`);

  // 2) A sharp still: the summary bar plus a flagged hunk, at 2x.
  const shot = await launch({ deviceScaleFactor: 2 });
  const sp = await shot.context.newPage();
  await sp.goto(PR_URL, { waitUntil: 'domcontentloaded' });
  await waitUntilScanned(sp);
  const firstChip = sp.locator('#driskh-summary-bar .driskh-jump-chip').first();
  await firstChip.click();
  await sleep(1800);
  await sp.screenshot({ path: path.join(OUT, 'live-dark.png') });
  await sp.close();
  await shot.context.close();
  shot.cleanup();
  console.log('wrote docs/img/live-dark.png');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
