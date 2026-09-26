// End-to-end: the real extension, loaded unpacked into Chromium, running
// on the live GitHub "Files changed" page of every PR behind
// test/fixtures/real-prs/. For each one it checks that the summary bar
// renders, that high/medium hunks get badges, and that the counts the
// extension shows match what src/risk-engine.js gives for the fixture
// diff (see e2e/real-prs.js for how the fixture's hunks are lined up with
// GitHub's rendering).
//
// Which GitHub UI is exercised depends on the session — see
// e2e/extension-fixture.js. Each test is annotated with the one it saw.

const { test, expect } = require('./extension-fixture.js');
const { REAL_PRS, expectedCounts, expectedFileCount } = require('./real-prs.js');

const HUNK_BOUNDARY = 'td.blob-code-hunk, td.diff-hunk-cell'; // classic, new UI
const FILE_DIFF_TABLE = 'table.diff-table, table[aria-label^="Diff for: "]'; // one per rendered file

// Waits until every file in the fixture has a rendered diff table. Two
// things delay that: the classic UI streams later files in batches after
// the first paint, and both UIs defer large/generated files behind a
// "Load diff" / "Load Diff" button — clicked here as they show up, since
// the fixture includes those files' hunks.
async function waitForAllFileDiffs(page, fileCount) {
  const tables = page.locator(FILE_DIFF_TABLE);
  const loadButtons = page.getByRole('button', { name: /^load diff$/i });
  await expect
    .poll(
      async () => {
        for (const button of await loadButtons.all()) {
          await button.click({ timeout: 5_000 }).catch(() => {}); // may detach mid-click as it loads
        }
        return tables.count();
      },
      { timeout: 60_000 }
    )
    .toBe(fileCount);
}

async function readSummaryCounts(page) {
  const bar = page.locator('#driskh-summary-bar');
  const read = async (level) => parseInt(await bar.locator(`.driskh-count--${level}`).innerText(), 10);
  return { high: await read('high'), medium: await read('medium'), low: await read('low') };
}

for (const pr of REAL_PRS) {
  test.describe.serial(`${pr.repo}#${pr.number} (${pr.fixture})`, () => {
    const expected = expectedCounts(pr.fixture);
    let page;
    let ui;

    test.beforeAll(async ({ extensionContext }) => {
      page = await extensionContext.newPage();
      await page.goto(`https://github.com/${pr.repo}/pull/${pr.number}/files`);
      await waitForAllFileDiffs(page, expectedFileCount(pr.fixture));
      // Read after the diffs render: signed-in sessions redirect /files →
      // /changes client-side, so the URL right after goto() can be stale.
      ui = /\/changes(\/|$)/.test(new URL(page.url()).pathname) ? 'new React UI (/changes)' : 'classic UI (/files)';

      // The extension scans on a debounced MutationObserver; wait until
      // every real (@@) hunk boundary on the page has been classified.
      // Empty expand-to-EOF boundaries are deliberately not required here —
      // see the low-count test below.
      await expect
        .poll(() =>
          page.evaluate(
            (sel) =>
              [...document.querySelectorAll(sel)]
                .filter((td) => td.textContent.trim())
                .every((td) => td.closest('tr').dataset.driskhLevel),
            HUNK_BOUNDARY
          )
        )
        .toBe(true);
    });

    test.afterAll(async () => {
      await page?.close();
    });

    test.beforeEach(() => {
      test.info().annotations.push({ type: 'github-ui', description: ui });
    });

    test('summary bar appears', async () => {
      const bar = page.locator('#driskh-summary-bar');
      await expect(bar).toBeVisible();
      await expect(bar).toContainText(/\d+ hunks? scanned/);
    });

    test('high/medium hunks get badges', async () => {
      await expect(page.locator('.driskh-badge--high')).toHaveCount(expected.high);
      await expect(page.locator('.driskh-badge--medium')).toHaveCount(expected.medium);
    });

    test('summary bar high/medium counts match risk-engine on the fixture', async () => {
      const shown = await readSummaryCounts(page);
      expect({ high: shown.high, medium: shown.medium }).toEqual({ high: expected.high, medium: expected.medium });
    });

    test('summary bar low count matches risk-engine on the fixture', async () => {
      // Known bug, both UIs: GitHub puts an "expand to end of file" row
      // after a file's last hunk that reuses the hunk-boundary cell with
      // no @@ header and no lines under it. src/content.js treats it as a
      // real hunk and scores it low, so the bar over-counts "low" (and the
      // total) by one per such file. Declared as an expected failure only
      // when those rows are present, so this starts failing loudly
      // ("expected to fail, but passed") once content.js skips them.
      const phantomRows = await page.evaluate(
        (sel) => [...document.querySelectorAll(sel)].filter((td) => !td.textContent.trim()).length,
        HUNK_BOUNDARY
      );
      test.fail(phantomRows > 0, `${phantomRows} empty expand-to-EOF row(s) counted as low-risk hunks`);

      const shown = await readSummaryCounts(page);
      expect(shown.low).toBe(expected.low);
    });
  });
}
