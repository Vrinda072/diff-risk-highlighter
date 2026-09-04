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
