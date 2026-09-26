# GitHub PR Diff DOM Notes

Captured 2026-08-26 against a live PR (`github.com/facebook/react/pull/28855/files`)
on the legacy (non-React-rewrite) diff renderer, which is still what GitHub
serves as of this writing. GitHub has changed this markup before and will
likely change it again — if the extension suddenly stops finding hunks,
re-run the inspection below before assuming the heuristics are broken.

## Page identification

- URL pattern: `https://github.com/<owner>/<repo>/pull/<number>/files`
  (optionally with a trailing `/<sha>` or query string for range diffs).
- Regex used in the content script: `/\/pull\/\d+\/files(\/|$)/` tested
  against `location.pathname`.

## Navigation: Turbo is present, but behavior is unconfirmed for logged-in users

GitHub ships Turbo (Hotwire) on every page, and the tab bar link markup
includes `data-turbo-frame="repo-content-turbo-frame"` when inspected
from the Files changed tab:

```html
<a href="/react/react/pull/28855/files"
   class="tabnav-tab ..."
   data-turbo-frame="repo-content-turbo-frame">
```

This looks like a frame-morph navigation (URL changes, DOM swaps, no
reload). **However**, actually clicking the "Files changed" tab (tested
logged-out) produced a genuine full page reload, not an in-place morph —
confirmed by `window` state being reset and `performance.getEntriesByType
('navigation')` reporting a fresh `"navigate"` entry for the `/files`
URL. The page also carries `<meta name="disable-turbo" content="true">`,
which is consistent with Turbo Drive being turned off there. That meta
tag was observed while logged out (`turbo-body-classes` included
`logged-out`) — **it's unverified whether a logged-in session (i.e. an
actual reviewer using this extension) gets the same full-reload
behavior, or a Turbo-morphed SPA transition instead.** Re-test this
logged in before relying on either assumption.

Consequences for the extension — built defensively to handle either
case without needing to know which one is true:

- The manifest matches any `/pull/*` URL (not just `/pull/*/files`), so
  if tab switches turn out to be full reloads, the content script simply
  re-injects and re-runs on each one.
- If a given session instead does Turbo-morph navigation (no reinjection
  triggered), the script also listens for `turbo:load` / `turbo:frame-
  load` and re-checks `location.pathname` itself.
- A `MutationObserver` on `document.documentElement` catches diff hunks
  that load asynchronously *after* either kind of navigation "finishes"
  (large PRs render hunks incrementally) — see below.
- Work triggered by the `MutationObserver` is debounced — GitHub's diff
  pages mutate the DOM frequently (line comments, "Viewed" checkboxes,
  sticky headers), and naively re-scanning on every mutation is wasteful
  on large diffs (this becomes more important in Milestone 4).

## Per-file block: `.file`

Each changed file is a `<div class="file ...">` block:

```html
<div class="file js-file js-details-container ... Details Details--on open"
     id="diff-<sha256>"
     data-tagsearch-path="packages/internal-test-utils/__tests__/ReactInternalTestUtils-test.js"
     data-file-type=".js"
     data-file-deleted="false"
     data-targets="diff-file-filter.diffEntries">
```

Useful attributes:

- `data-tagsearch-path` — the file path (most reliable source).
- `data-file-type` — extension, including the dot (`.js`, `.py`, etc).
- `data-file-deleted` — `"true"` for deleted files.
- `id="diff-<sha256>"` — stable per-file anchor, usable for jump links
  (relevant for Milestone 3's summary bar).

### File header: `.file-header`

Nested inside `.file`, also carries the path (as `data-path`) plus a
short SHA and an anchor id matching the parent's `id`:

```html
<div class="file-header ... js-file-header ..."
     data-path="packages/internal-test-utils/__tests__/ReactInternalTestUtils-test.js"
     data-short-path="4779b3a"
     data-anchor="diff-4779b3ae8d67b9bfa0952a61fb8a2ff69cb3f12f69495d9839970790280a6563"
     data-file-type=".js"
     data-file-deleted="false">
```

Prefer `.file-header`'s `data-path` or `.file`'s `data-tagsearch-path`
over scraping visible link text/titles, which include truncation and
icons.

## Diff table: `table.diff-table`

Each `.file` contains one `<table class="diff-table js-diff-table ...">`
with a header row (`Original file line number` / `Diff line number` /
`Diff line change`) followed by data rows.

### Hunk header rows

A hunk boundary (`@@ -a,b +c,d @@ ...`) row is **not** a standalone
single-cell `<tr>` — it shares its row with an expand-up/expand-down
link cell (or, if there's no room to expand, may be alone). The real
shape, confirmed against a live page:

```html
<tr class="js-expandable-line js-skip-tagsearch" data-position="0">
  <td class="blob-num blob-num-expandable" colspan="2">
    <a class="js-expand ..." href="#diff-<sha256>" aria-label="Expand Up">...</a>
  </td>
  <td class="blob-code blob-code-inner blob-code-hunk">@@ -2129,6 +2129,28 @@ describe(...) {</td>
</tr>
```

To find this row from code, don't assume cell count or `data-hunk` on
the row itself (see pitfall below) — instead select the `td.blob-code-hunk`
cell and walk up: `cell.closest('tr')`. That row is exactly the one to
append a badge/icon into (via `td.blob-code-hunk`, which is safe to
append to without disturbing the expand-link cell), and its first child
(`row.children[0]`, whatever its colspan) is where a left-edge
box-shadow marker should go to keep the stripe continuous with the rest
of the hunk's rows.

**Pitfall (confirmed against a live page):** `data-hunk` is on the `<tr>`
of *every* row belonging to a hunk group, not just the boundary row — a
28-line hunk had 28 rows all sharing one `data-hunk` value, and the
boundary row itself (above) doesn't even carry a `data-hunk` attribute.
Counting `tr[data-hunk]` wildly overcounts hunks. The reliable selector
for **counting hunks per file** is the header cell itself:
`fileEl.querySelectorAll('td.blob-code-hunk').length`.

### Added / removed / context line rows

```html
<!-- addition -->
<tr class="show-top-border">
  <td class="blob-num blob-num-addition empty-cell"></td>
  <td class="blob-num blob-num-addition js-linkable-line-number js-blob-rnum"
      data-line-number="2132"></td>
  <td class="blob-code blob-code-addition js-file-line">
    <span class="blob-code-inner blob-code-marker" data-code-marker="+">    // @gate __DEV__</span>
  </td>
</tr>

<!-- deletion -->
<td class="blob-code blob-code-deletion js-file-line">
  <span class="blob-code-inner blob-code-marker js-skip-tagsearch" data-code-marker="-">
    expectedMessage = replaceComponentStack(expectedMessageOrArray<span class="x x-first x-last">[0]</span>);
  </span>
</td>
```

Selectors:

- `td.blob-code-addition` — one per added line.
- `td.blob-code-deletion` — one per removed line.
- Context (unchanged) lines use plain `td.blob-code` without the
  `-addition`/`-deletion` modifier.
- The actual line text is inside the nested
  `span.blob-code-inner` (strip the leading marker character if reading
  `textContent` — `data-code-marker` gives you `+`/`-` separately so you
  don't have to).
- `data-line-number` on the sibling `td.blob-num-*` gives the original
  file's line number for that row (empty/`empty-cell` on the side that
  doesn't apply, e.g. the "old line number" column for a pure addition).

## Split (side-by-side) diff view: verified compatible

Reachable via `?diff=split` on the Files-changed URL. The table gets an
extra class (`file-diff-split js-file-diff-split`) and each row can now
carry up to 4 cells instead of 2–3 (old line-number / old code / new
line-number / new code), but the classes this extension actually
selects on are **unchanged**:

```html
<!-- a modified line: old (left) and new (right) share one row -->
<tr data-hunk="...">
  <td class="blob-num blob-num-deletion ..." data-line-number="164"></td>
  <td data-split-side="left" class="code-review blob-code blob-code-deletion ...">
    <span class="blob-code-inner ..." data-code-marker="-">        try {</span>
  </td>
  <td class="blob-num blob-num-addition ..." data-line-number="172"></td>
  <td data-split-side="right" class="code-review blob-code blob-code-addition ...">
    <span class="blob-code-inner ...">...</span>
  </td>
</tr>
```

`td.blob-code-deletion` and `td.blob-code-addition` still exist, still
one per changed line, just side by side in the same `<tr>` instead of
two separate rows — which is actually *closer* to how the risk engine
already models a hunk (parallel `addedLines`/`removedLines` arrays), so
`row.querySelector('td.blob-code-addition .blob-code-inner')` and the
`-deletion` equivalent on the same row both resolve correctly without
any special-casing. The hunk-boundary row is the same
`td.blob-code-hunk`-in-a-shared-`<tr>` shape too, just with
`colspan="1"` instead of `2` on the expand-link cell (there are more
columns to span now). Verified by running the real extraction logic
against `?diff=split` on the SQL-injection fixture PR and getting the
identical 4-hunk / 1-high result as unified view.

## v1.1, 2026-09-23: GitHub replaced this entire DOM — now supported alongside it

Confirmed live (both `virtual-imaging-platform/VIP-portal#698`, a small
fixture repo, and `psf/requests#4052`, a large well-known one — so this
isn't an account/repo-specific flag) while doing an end-to-end "run it"
check of the shipped extension: GitHub has rolled out a full React
rewrite of the Files Changed tab, called internally "the upgraded Files
Changed experience" (a dismissible banner announces it, linking
`https://gh.io/new-files-changed-changelog`), and **every selector this
document describes above stopped matching, on every PR, immediately.**

`src/content.js` now supports both DOM shapes: it scans for the new
React grid's elements and the classic table's elements unconditionally
on every pass (they're disjoint selectors, so only the one the current
page actually rendered ever matches), rather than picking one at
load time. That was a deliberate choice over detecting the "right" one
up front — it means the extension keeps working through GitHub
A/B-testing this again, rolling it back, or any session simply landing
on whichever UI for reasons outside this extension's control.

What changed:

- **URL**: `/pull/<n>/files` now client-redirects to `/pull/<n>/changes`.
  The content script's page-detection regex (`/\/pull\/\d+\/files(\/|$)/`)
  does not match the new path, so the script's own top-level gate fails
  even before it would look for any DOM.
- **Everything the extension selects on is gone**: `.file[data-tagsearch-path]`,
  `table.diff-table`, `td.blob-code-hunk`, `td.blob-code-addition`,
  `td.blob-code-deletion`, `#files` — all zero matches on the new page.
  The diff content is still server-rendered into the initial HTML (as a
  JSON payload inside a `<script data-target="react-app.embeddedData">`
  tag), but the actual *visible* DOM a content script would read is a
  completely different, deeply-nested Primer/React table.

What the new DOM actually looks like (captured live from
`psf/requests#4052`'s `utils.py` hunk, the same one used as the
`requests_regression.diff` fixture — full `outerHTML`, not trimmed):

```html
<table aria-label="Diff for: requests/utils.py" role="grid" class="... DiffLines-module__tableLayoutFixed__Ui4OU">
  <tbody>
    <!-- hunk boundary: one <tr>, one <td colspan="4"> -->
    <tr class="diff-line-row">
      <td class="diff-hunk-cell focusable-grid-cell left-side" colspan="4" role="gridcell">
        <div class="d-flex flex-row">
          <button aria-label="Expand file up from line 684" ...></button>
          <code class="diff-text-cell hunk">
            <div class="diff-text-inner color-fg-muted">@@ -684,7 +684,7 @@ def should_bypass_proxies(url, no_proxy):</div>
          </code>
        </div>
      </td>
    </tr>

    <!-- context line: real line-number cells on both sides, one content cell -->
    <tr class="diff-line-row" data-row-selected="false">
      <td class="... diff-line-number-neutral" data-diff-side="left" data-line-number="684">684</td>
      <td class="... diff-line-number-neutral" data-diff-side="right" data-line-number="684">684</td>
      <td class="diff-text-cell ..." data-diff-side="right" data-line-number="684">
        <code class="diff-text syntax-highlighted-line">
          <div class="diff-text-inner">    <span class="pl-k">return</span> <span class="pl-c1">False</span></div>
        </code>
      </td>
    </tr>

    <!-- deletion: its OWN <tr> (not packed with the addition) -->
    <tr class="diff-line-row" data-row-selected="false">
      <td class="..." data-diff-side="left" data-line-number="687">687</td>
      <td class="... empty-diff-line left-side"></td>
      <td class="diff-text-cell ..." data-diff-side="left" data-line-number="687">
        <code class="diff-text syntax-highlighted-line deletion">
          <span class="diff-text-marker">-</span>
          <div class="diff-text-inner">def get_environ_proxies(url, no_proxy):</div>
        </code>
      </td>
    </tr>

    <!-- addition: a SEPARATE following <tr>, same line number (687), new side -->
    <tr class="diff-line-row" data-row-selected="false">
      <td class="... empty-diff-line left-side"></td>
      <td class="..." data-diff-side="right" data-line-number="687">687</td>
      <td class="diff-text-cell ..." data-diff-side="right" data-line-number="687">
        <code class="diff-text syntax-highlighted-line addition">
          <span class="diff-text-marker">+</span>
          <div class="diff-text-inner">def get_environ_proxies(url, no_proxy=None):</div>
        </code>
      </td>
    </tr>
  </tbody>
</table>
```

An earlier pass at this document (still visible in git history) guessed
that a changed line packs old+new into one shared `<tr>`, split-view
style. Live inspection of the actual `outerHTML` shows that guess was
wrong: every line — boundary, context, addition, or deletion — is its
own `<tr class="diff-line-row">`, in the same top-to-bottom order a
classic unified diff produces. That's the one correction worth flagging
explicitly, since it's the load-bearing fact for `src/content.js`'s new
`extractHunksFromNewDiffTable()`: it can walk `tr.diff-line-row` in
document order exactly like the classic extractor walks `tr`, just with
different per-row selectors.

**Selectors now used by `src/content.js`** (verified live, both against
`vip_sqli`'s SQL-injection fixture PR and `requests_regression`'s
signature-change fixture PR — correct classification, correct badge
placement, correct summary-bar counts on both):

| Old DOM | New DOM |
|---|---|
| `.file[data-tagsearch-path]` (per-file container + path) | `table[aria-label^="Diff for: "]` (the table itself carries the path — one fewer lookup than before) |
| `td.blob-code-hunk` (hunk boundary) | `td.diff-hunk-cell` |
| `td.blob-code-addition .blob-code-inner` | `td.diff-text-cell code.diff-text.addition .diff-text-inner` |
| `td.blob-code-deletion .blob-code-inner` | `td.diff-text-cell code.diff-text.deletion .diff-text-inner` |
| (context line, no special class) | `code.diff-text` with neither `.addition` nor `.deletion` |
| `#files` (summary-bar insertion anchor) | `[data-testid="progressive-diffs-list"]` (`#files` doesn't exist in the new UI) |
| `.pr-toolbar` (sticky-offset measurement) | doesn't exist in the new UI — degrades to `top: 0` |

**Caution kept from the original capture**: the table's own class
(`DiffLines-module__tableLayoutFixed__Ui4OU`) is a webpack CSS-module
hash that GitHub regenerates on every frontend deploy — not used as a
selector for exactly that reason. Everything `src/content.js` anchors on
above is either a plain, apparently hand-authored class
(`diff-line-row`, `diff-hunk-cell`, `diff-text-cell`, `diff-text-inner`,
`addition`, `deletion`) or a semantic/ARIA attribute (`aria-label`,
`data-testid`), the same stability bet the classic-DOM selectors made.

Both extractors now run unconditionally on every scan (see
`processPage()` in `src/content.js`) rather than picking one DOM shape
at load time, so the extension keeps working through GitHub changing
which UI a given session renders — including reverting this rollout,
A/B-testing it further, or any account-specific variation neither
repo tested here happened to hit.

## 2026-09-26: Which UI is served, and what the E2E suite found

Found while building the Playwright suite (`npm run test:e2e`, see
`e2e/`), which loads the real unpacked extension into Chromium and runs
it against the live PR behind every fixture in `test/fixtures/real-prs/`.

### Which UI you get depends on being signed in

The v1.1 section above describes the React UI as a platform-wide
rollout where `/files` redirects to `/changes`. That's only true for
**signed-in** sessions:

| Session | `/pull/<n>/files` | `/pull/<n>/changes` | UI rendered |
|---|---|---|---|
| Signed out | 200 | **302 → `/files`** (server-side; same with a desktop Chrome user agent, and with plain `curl`) | classic table |
| Signed in | client-redirects to `/changes` | 200 | React grid |

So a logged-out browser (including the E2E suite by default, and any CI
run) only ever sees the classic UI, while real reviewers (who are signed
in) get the React UI. Both need to keep working. The E2E suite can be
pointed at the React UI by saving a session you sign into yourself
(`npm run test:e2e:login`; cookies go to the gitignored `e2e/.auth/`).

### React UI: selectors still match, and extraction is byte-exact

Checked signed-in on 2026-09-26 against `psf/requests#4052`,
`stellar/passkey-kit#4` (25 files, 2 behind "Load Diff") and
`django/django#16012` (19 files, 1 behind "Load Diff"). Every selector
in the v1.1 mapping table above still resolves. Running
`extractHunksFromNewDiffTable()` from `src/content.js` verbatim in the
page and fingerprinting each hunk (file path, added/removed line counts,
hash of the line text) gave an **identical** set to the fixture diffs
(after the hunk merge described below): 54/54 hunks on passkey-kit,
59/59 on django. Since the risk engine is a pure function of those
lines, the extension scores the React UI exactly as it scores the
fixtures. Injected badges (appended to the hunk's `div.d-flex.flex-row`,
the same place `markHunk()` puts them) and a bar inserted before
`[data-testid="progressive-diffs-list"]` both survived a full-page
scroll.

### Bug, both UIs: the "expand to end of file" row is counted as a hunk

After a file's last hunk, both UIs render one more hunk-boundary row
that is not a hunk. It's the "expand down to end of file" control, with
no `@@` header and no diff lines under it:

```html
<!-- classic (psf/requests#4052, utils.py) -->
<tr class="js-expandable-line js-skip-tagsearch" data-position="">
  <td class="blob-num blob-num-expandable" colspan="2"><a class="js-expand directional-expander single-expander" aria-label="Expand Down" …>…</a></td>
  <td class="blob-code blob-code-inner blob-code-hunk"></td>   <!-- empty -->
</tr>

<!-- React UI (psf/requests#4052, utils.py) -->
<tr class="diff-line-row" data-row-selected="false">
  <td colspan="4" class="diff-hunk-cell focusable-grid-cell left-side"
      data-grid-cell-id="diff-<sha256>-empty-empty-0" data-line-anchor="diff-<sha256>R691" role="gridcell">
    <div class="d-flex flex-row">
      <button aria-label="Expand file down from line 690" data-direction="down" …></button>
      <code class="diff-text-cell hunk"><div class="diff-text-inner color-fg-muted"></div></code>  <!-- empty -->
    </div>
  </td>
</tr>
```

Both extractors in `src/content.js` start a new hunk at any
`td.blob-code-hunk` / `td.diff-hunk-cell`, so each of these becomes an
empty hunk, which the engine scores `low`. The effect is that the summary
bar's **low count and "N hunks scanned" total are inflated by one per
file that doesn't end at EOF**. High/medium counts, badges and jump links
are unaffected. It shows up on 16 of the 17 fixture PRs, e.g.
`django/django#16012` shows 59 low where the engine gives 47. The only
exception is `camconf_refactor`, whose single file runs to EOF.
`td.blob-code-hunk` was already the "reliable" hunk-counting selector in
the classic notes above, and this is the case it misses. The fix is to
skip boundary cells with no `@@` text. This is not fixed yet, and the
E2E low-count test is declared as an expected failure while these rows
are present, so it will flip once the fix lands.

### React UI: collapsing a file throws its table away

Collapsing a file (the header's "Collapse file" button) removes its
`<table aria-label="Diff for: …">` from the DOM, and re-expanding
builds a brand-new one without the injected badges or `data-driskh-*`
attributes. Scrolling does not do this, and the classic UI hides
collapsed diffs instead of removing them. Based on reading the code (not
verified live), `content.js` should recover: the new table has no
`data-driskh-hunk-count`, so the next observer-triggered scan re-marks
it. But `processPage()` derives the next `hunkIndex` from the number of
already-processed rows, so the re-marked hunks can get a
`driskh-hunk-N` id that another hunk already has. A "Jump to high risk"
chip for one of them could then scroll to the wrong hunk.

### Other things worth knowing about the React UI

- **Deferred files** show a `Load Diff` button (capital D; classic is
  `Load diff`) with "Large diffs are not rendered by default." or "Some
  generated files are not rendered by default." Until clicked there's
  no table, so those files are simply not scanned, the same as the
  classic behavior described below.
- **`content-visibility: auto`** is set on every diff entry. Off-screen
  entries report an empty `innerText` even though their DOM is fully
  there. `content.js` reads `textContent`, which is unaffected. Don't
  switch to `innerText`.
- **Load timing:** with a real viewport, all non-deferred files of a
  19–25-file PR were in the DOM at first load, with no scroll-driven
  loading. With a 0×0 viewport (a hidden browser tab), only the first 3
  of 19 rendered, so measure with a visible, sized window. PRs with
  hundreds of files weren't tested.

### Both UIs merge hunks one line apart

GitHub's web diff merges two hunks of the same file when exactly one
unchanged line separates them (like `git diff --inter-hunk-context=1`).
`gh pr diff`, which produced the fixtures, keeps them separate. Across
all 17 fixtures, every 1-line gap was merged live and every gap of 2+
was not. This only matters when comparing page counts to fixture counts.
`e2e/real-prs.js` applies the same merge, and it's why
`django/django#21696` shows 22 hunks on the page but 24 in the fixture.

### Not verified yet

- React UI **split view**. Switching to it changes the signed-in
  account's saved diff preference, so it wasn't toggled on the account
  used for this check.
- React UI summary-bar sticky offset and overlap. There's no
  `.pr-toolbar`, so the bar sticks at `top: 0`, and it wasn't checked
  against GitHub's own sticky file headers.
- React UI behavior on PRs with hundreds of files.

## Known gaps / not yet verified

- **Binary files, renames, mode-only changes**: not captured in this
  pass. Expect `.file-header` to carry different affordances (no diff
  table, or a "renamed" note) and the heuristics engine (Milestone 2)
  will need to treat "no addition/deletion rows found" as its own case
  rather than assuming zero risk.
- **"Load diff" placeholders — resolved.** GitHub defers large files'
  diffs behind an `<include-fragment class="js-diff-entry-loader"
  data-fragment-url="...">` that swaps in a real `table.diff-table` once
  loaded (via a "Load diff" click, or automatically for some files).
  `.file` exists but has no table until then; `extractHunksFromFile`
  already tolerates that (returns no hunks). Verified live on
  [BOINC/boinc#7243](https://github.com/BOINC/boinc/pull/7243) — a
  2,848-line deletion behind "Load diff" — that clicking it triggers the
  same childList mutation this extension's `MutationObserver` already
  watches for, so the newly-loaded hunk gets picked up and classified on
  the very next scheduled scan with no extra code.
- Selectors above are **not** guaranteed stable across GitHub deploys.
  If detection breaks, re-run the inspection snippet below in the
  DevTools console on a live PR's Files changed tab.

## Quick re-inspection snippet

React UI (`/changes`):

```js
const t = document.querySelector('table[aria-label^="Diff for: "]');
console.log({
  path: t.getAttribute('aria-label'),
  hunks: [...t.querySelectorAll('td.diff-hunk-cell')].filter((td) => td.textContent.trim()).length,
  additions: t.querySelectorAll('code.diff-text.addition .diff-text-inner').length,
  deletions: t.querySelectorAll('code.diff-text.deletion .diff-text-inner').length,
});
```

Classic UI (`/files`):

```js
const f = document.querySelectorAll('.file')[0];
console.log({
  path: f.dataset.tagsearchPath,
  header: f.querySelector('.file-header')?.dataset,
  hunks: f.querySelectorAll('tr[data-hunk]').length,
  additions: f.querySelectorAll('td.blob-code-addition').length,
  deletions: f.querySelectorAll('td.blob-code-deletion').length,
});
```
