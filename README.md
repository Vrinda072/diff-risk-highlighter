# Diff Risk Highlighter

A Chrome extension that scans a GitHub pull request's "Files changed" tab
and flags which diff hunks are actually risky to review carefully versus
which are safe to skim — using static heuristics, no LLM required.

> **Status:** all 5 planned milestones are built (scaffold, risk engine,
> DOM integration, polish/scale, optional LLM explanations), plus a v1.1
> pass. GitHub rolled out a full React rewrite of the Files Changed tab
> sometime between 2026-08-26 and 2026-09-23 (`/pull/<n>/files` now
> redirects to `/pull/<n>/changes` with an entirely different DOM) —
> caught by re-verifying the extension live against real PRs rather than
> assuming the original build still held. `src/content.js` now scans
> both the classic DOM and the new React grid unconditionally on every
> pass, verified live against the same SQL-injection and
> signature-change fixture PRs used during the original calibration
> (correct classification, correct badge, correct summary-bar counts on
> both). See [docs/github-diff-dom.md](docs/github-diff-dom.md) for the
> full DOM capture and selector mapping.

## The problem

Code review attention is scarce and PRs bury the parts that matter under
mechanical changes: renamed variables, reformatted imports, generated
files, moved-but-unchanged blocks. Reviewers end up either skimming
everything at the same shallow depth, or reading every hunk with equal
care and running out of attention before they reach the part that
actually changed behavior. Diff Risk Highlighter triages hunks *before*
you start reading, so you can spend your attention where it's likely to
matter.

## How risk detection works

The engine ([src/risk-engine.js](src/risk-engine.js)) takes one diff
hunk — its added lines, removed lines, and file path — and returns a
`{ level, reason }` verdict. No AST, no language-specific parser: it's
regex/text heuristics on purpose (see
[Known Limitations](#known-limitations--future-work) for the tradeoffs
that come with that). It was calibrated against real merged PRs, not
invented examples — see
[test/fixtures/real-prs/README.md](test/fixtures/real-prs/README.md)
for the full list and what each one caught.

**Checked first, short-circuits to low risk** (a hunk that's provably
behavior-preserving is safe to skim no matter what words appear in it):

1. **Lockfile/generated or vendored file** — `package-lock.json`,
   `yarn.lock`, `Cargo.lock`, `*.min.js`, protobuf output, `vendor/`,
   `node_modules/`, `third_party/`, etc. Never hand-reviewed in practice.
   Path rules adapted from
   [github-linguist](https://github.com/github-linguist/linguist)'s
   `generated.rb` and `vendor.yml`, which is what GitHub itself uses to
   classify these files.
2. **Formatting-only change** — added/removed lines are identical once
   whitespace and trailing commas are stripped (a Prettier/Black-style
   reformat, even one that re-wraps a call across more lines).
3. **Comment/docstring-only change** — every changed line is a comment.
4. **Mechanical rename** — every line that differs does so *only* by a
   consistent identifier substitution (same old name always maps to the
   same new name). Catches the "renamed variable that looks like a big
   logic change" case — e.g. django/django#21696 renaming a public API
   constant (`RAISE` → `FETCH_RAISE`) across 15 files.

**Risk-raising signals** (highest-severity match wins; level is `high`
or `medium`):

| Signal | Level | Why |
|---|---|---|
| SQL built via string concatenation | high | A SQL verb (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) and a clause (`FROM`/`WHERE`/`INTO`/`VALUES`) *and* string-concatenation syntax, all within a few lines of each other. Modeled on a real SQL-injection fix. |
| Comparison/range boundary changed | high | A line edited into an almost-identical line differing in exactly one token, where that token is a confusable operator pair (`<`/`<=`, `..`/`..=`, `==`/`===`, …) or an integer literal shifted by 1. Classic off-by-one shape — modeled on a real 1-line Rust fix (`..` → `..=`) that a line-count heuristic would've waved through as trivial. |
| Removed exception handling | high | `try`/`catch`/`except`/`finally` occurrences *decrease* between removed and added lines (not just "mentioned in removedLines" — a reformatted-but-kept try/catch doesn't count). |
| Security-sensitive keywords | high | `password`, `jwt`, `csrf`, `authenticat(e/ion)`, `Content-Security-Policy`, etc. Deliberately excludes generic words like `admin`, `token`, `session`, `auth\*` that collided constantly with ordinary code during calibration (see limitations). |
| Removed conditional branch | medium (high if it also removes a `return`/`raise`/`throw`, or spans ≥3 conditional lines) | A static heuristic can't prove a removed `if`/`else`/`switch` was truly dead code — it can only tell you to go check, which is exactly what happened in three real "dead code cleanup" PRs used as fixtures here. |
| Function signature changed | medium | A `def`/`function`/`fn`/`func` declaration with the same name appears on both sides with a different parameter list — catches things as small as a single added default value. |
| Large hunk, no other signal | medium | Fallback for hunks over ~40 changed lines that didn't trip anything more specific. |

Anything left over is **low** risk.

**Documentation files** (`CHANGELOG`, `README`, `*.md`/`*.rst`/…,
anything under `docs/`; adapted from linguist's `documentation.yml`)
skip the security-keyword and boundary-change detectors and the
large-hunk fallback. Prose that *describes* an authorization fix isn't
an authorization change. The structural detectors (removed error
handling, removed conditional, signature change, SQL shape) still run
on them. The boundary-change detector also ignores **version-shaped
numbers**: semver-like literals anywhere (`"0.16.2"` → `"0.16.3"`), and
any quoted version value in `package.json`, `Cargo.toml`, or
`pyproject.toml`. Both rules come from
[stellar/passkey-kit#4](https://github.com/stellar/passkey-kit/pull/4),
described below.

### A note on why the keyword lists look narrow

The first pass at the SQL and security heuristics used broad `\w*`
wildcards and single common words (`admin`, `auth`, `token`, `delete`).
Running that against real PRs — not toy examples — immediately produced
absurd results: every hunk touching `django.contrib.admin` came back
"high risk" because the word "admin" is the app's name, and a 300-line
Django test file got flagged as SQL injection because it contained
`.join(`, an f-string, and the English words "select" and "delete" in
unrelated places. Both were tightened (word-boundary-only matches, no
wildcards, and — for SQL — requiring the verb/clause/concatenation
signals to co-occur within a small sliding window of lines) until they
stopped firing on that noise while still catching the real fixtures.
That back-and-forth is preserved as regression tests in
[test/risk-engine.real-diffs.test.js](test/risk-engine.real-diffs.test.js).

### What a 17-fixture human review actually found

Calibration tests assert the engine gets specific fixtures right; they
don't tell you where it's still wrong. So after the fixture set grew to
17 real merged PRs, every one was run through `assessHunk` and the
output read hunk-by-hunk, the same way a reviewer would judge whether
the flags make sense. That pass found three real gaps. They weren't
fixed at the time, on purpose, since fixing a heuristic without more
real-PR calibration tends to trade one false positive/negative for
another. The third has since been fixed and checked against all 17
fixtures:

- **A same-shape, different-cause off-by-one is missed.**
  [`mglet_offbyone.diff`](test/fixtures/real-prs/mglet_offbyone.diff)
  ([kmturbulenz/mglet-base#226](https://github.com/kmturbulenz/mglet-base/pull/226))
  fixes a real indexing bug by *appending* `- 1` to an array-index
  expression (`idx = ... + (i-1)*kk*jj` →
  `idx = ... + (i-1)*kk*jj - 1`). The boundary-change detector only
  fires when exactly one token differs between two otherwise-identical
  lines (`<` → `<=`, `2` → `3`) — it's built to catch an operator or
  literal being *swapped*, not new tokens being *added*. This PR scores
  entirely `low`. A real off-by-one fix, invisible to the engine.
- **No heuristic for concurrency bugs at all.**
  [`squarelet_race.diff`](test/fixtures/real-prs/squarelet_race.diff)
  ([MuckRock/squarelet#777](https://github.com/MuckRock/squarelet/pull/777))
  is a genuine race-condition fix and gets zero `high` flags. There's
  nothing in the engine that looks for the shape of a concurrency bug
  (missing lock/check-then-act patterns, shared mutable state) —
  because nothing was ever built to. This isn't a mistuned threshold,
  it's a category the heuristics don't cover yet.
- **Fixed: prose and version bumps diluted a correct flag on the PR
  that matters most.**
  [`passkey_authbypass.diff`](test/fixtures/real-prs/passkey_authbypass.diff)
  ([stellar/passkey-kit#4](https://github.com/stellar/passkey-kit/pull/4))
  is a real authorization-bypass fix. The engine *does* correctly flag
  the actual fix (`context.rs`, `lib.rs`) as `high` — but returns 15
  `high` hunks total for the PR, most of them `CHANGELOG.md`/
  `README.md` prose that merely *describes* an authorization fix in
  English, plus a `package.json`/version-string bump (`"0.16.2"` →
  `"0.16.3"`) that the off-by-one detector treats identically to a loop
  boundary shifting by one. The security-keyword and boundary-change
  detectors both do their job correctly in isolation; neither one
  currently excludes non-code files or version-literal-shaped numbers,
  so on a PR that's genuinely about security, the one flag that matters
  is buried in fourteen that don't.
  **Now:** documentation files skip those two detectors, and version-shaped
  numbers are masked before the boundary check (see
  [How risk detection works](#how-risk-detection-works)). This PR goes
  from 15 high to 8. The 3 fix hunks in `context.rs`/`lib.rs` stay high;
  all 7 prose/version hunks that were high are now low. The other 5
  highs are the PR's own auth tests (`test_auth.rs`,
  `test_integration.rs`), which use the same security vocabulary. No
  other fixture's high count changed; `django_feature` loses 2 medium
  flags on long prose hunks in its `docs/`.

Reproducible with the same one-liner used for this pass:

```bash
node -e '
const fs = require("fs"), path = require("path");
const { assessHunk } = require("./src/risk-engine.js");
const { parseDiff } = require("./test/helpers/parse-diff.js");
const dir = "test/fixtures/real-prs";
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".diff")).sort()) {
  const hunks = parseDiff(fs.readFileSync(path.join(dir, f), "utf8"));
  const c = { high: 0, medium: 0, low: 0 };
  hunks.forEach(h => c[assessHunk(h).level]++);
  console.log(f, hunks.length, "hunks ->", c);
}'
```

## How it shows up on the page

Wired into `src/content.js`: for each `<td class="blob-code-hunk">`
boundary found in a file's diff table (see
[docs/github-diff-dom.md](docs/github-diff-dom.md) for why that's less
trivial than it sounds), the hunk's added/removed lines are extracted
and run through the engine. Medium/high hunks get:

- a colored left edge on every row in that hunk, via `box-shadow: inset`
  (never `border`, so nothing reflows or shifts GitHub's own layout), and
- a small `HIGH`/`MEDIUM` badge appended into the hunk's own `@@ ... @@`
  header cell, with the reason as its tooltip.

Low-risk hunks are left completely untouched — the goal is to draw the
eye to what needs it, not paint every row a color.

A sticky summary bar is inserted just above the file list: total hunks
scanned, the high/medium/low breakdown, and a row of clickable chips
(one per high-risk file) that `scrollIntoView` to that hunk. It's
`position: sticky` at the same offset as GitHub's own per-file sticky
headers, measured from the toolbar's actual height rather than a
hardcoded pixel value. The bar also carries a **Highlighting** checkbox —
switching it off hides every marker/badge/stat instantly via a single CSS
class on `<html>` (no re-render, no data thrown away) and persists the
choice with `chrome.storage.local`, so it survives the full-page reloads
that happen when switching between a PR's Conversation/Files-changed tabs
(see Milestone 1's Turbo findings — an in-memory-only flag would reset
constantly in practice).

## Handling scale and lazy-loading

GitHub itself defers diff content for large PRs and large individual
files: a file's `<table class="diff-table">` doesn't exist until GitHub
swaps it in from an `<include-fragment>`, either automatically or behind
a "Load diff" click. Verified this live against a real PR
([BOINC/boinc#7243](https://github.com/BOINC/boinc/pull/7243), a
2,848-line file deletion hidden behind "Load diff") — clicking it fires
exactly the kind of DOM mutation this extension's `MutationObserver`
already listens for, and the newly-loaded hunk was picked up and
classified (`medium`, "Large hunk") on the very next scheduled rescan
with no extra code needed. The same mechanism handles files that are
wholly new or wholly deleted (all-additions/all-deletions hunks) — the
engine already scores an empty `addedLines`/`removedLines` side
correctly, and GitHub still emits a normal `td.blob-code-hunk` boundary
for them (just a non-expandable variant, since there's no context to
expand).

The part that *did* need work: re-scanning efficiently at scale. Every
scheduled rescan originally re-walked every row of every file's table,
even ones that hadn't changed since the last scan — fine for a handful
of files, wasteful once a PR has 100+ of them or one huge file. Each
file now caches its hunk-header count (`td.blob-code-hunk` occurrences)
and is skipped entirely if that count hasn't changed, so a no-op rescan
only pays for a cheap count check per file instead of walking every row.

Measured with [test/perf/synthetic-large-diff.html](test/perf/synthetic-large-diff.html)
(150 synthetic files × 3 hunks = 450 hunks, open it in a browser or via
`.claude/launch.json`'s `static-server` config): the *cold* first-pass
scan is unaffected either way (~30–50ms, and dominated by one-time
JIT/layout warmup noise — confirmed by swapping run order and watching
which version "wins" flip). The number that actually matters is the
*warm* rescan — what fires on every unrelated DOM mutation after the
page has settled (a "Viewed" checkbox, a lazy-loaded avatar, GitHub's
own UI) — measured as a median over 8 reps:

| | before (walks every row) | after (skips unchanged files) |
|---|---|---|
| warm no-op rescan, 450 hunks | ~1.6ms | ~0.1ms |

A roughly 16x reduction on a no-op rescan, and — more importantly than
the specific number — it turns the cost from *O(total rows across every
file)* into *O(file count)*, which is what actually determines whether
this scales past 150 files to 500+.

### The bug that mattered most: the extension retriggering itself

While instrumenting the live-page tests above, the same `MutationObserver`
that watches for GitHub's own changes turned out to also be watching
*this extension's own output* — appending a badge (`appendChild`) and
rewriting the summary bar (`bar.innerHTML = ...`) are both childList
mutations under `{childList: true, subtree: true}`. The result: after
the very first scan, the script kept re-triggering itself indefinitely,
with no user interaction at all. Confirmed by instrumenting
`MutationObserver` globally on a real, otherwise-idle PR page and
counting callback invocations: **89 scans in 8 seconds**, climbing
without bound the whole time it was left running.

Fixed two ways, one load-bearing and one a nice-to-have:

1. **`observer.disconnect()` for the duration of the script's own
   synchronous DOM writes**, reconnecting immediately after. Since
   JavaScript is single-threaded, nothing else can mutate the page
   during that window, so this can't miss a genuine external change —
   it only blinds the observer to writes it caused itself.
2. The summary bar now caches the last HTML it rendered and skips the
   `innerHTML` write entirely when a rescan produces identical content
   — avoiding the reflow/paint cost even for the (now harmless, but
   still wasteful) case of a genuine external mutation that doesn't
   actually change anything the bar shows.

Re-measured after the fix on the same live page, same instrumentation:
**1 scan total**, stable for the full observation window. Locked in as a
permanent regression check —
[test/dom/pull/999/files/self-trigger-regression.html](test/dom/pull/999/files/self-trigger-regression.html)
loads the *actual* `src/risk-engine.js` and `src/content.js` (not
copies) against a small synthetic diff and asserts the mutation-callback
count stops growing after the initial scan. It lives at that specific
nested path so the URL itself satisfies the content script's
`/pull/<n>/files` page-detection gate without needing to fake
`location.pathname`.

## Optional LLM explanations

Every high-risk hunk's badge is joined by an **Explain** button. Nothing
about this feature runs — no network request, no permission prompt
beyond what the extension already has — unless that button is clicked.

Clicking it the first time asks for an Anthropic API key (a plain
`prompt()`, stored only in `chrome.storage.local` — never synced,
logged, or sent anywhere except directly to `api.anthropic.com` when you
click "Explain" again). The request itself is made from
[src/background.js](src/background.js), a small MV3 service worker, not
from the content script: a content script's `fetch()` is subject to the
CSP of the page it's injected into, and GitHub's CSP does not allow
requests to arbitrary third-party API hosts — an extension's background
service worker isn't bound by that page's CSP, only by its own declared
`host_permissions` (`https://api.anthropic.com/*` in
[manifest.json](manifest.json)). Verified end-to-end (button → prompt →
stored key → retried request → rendered response) with a mocked
background response, since exercising this for real needs a live API
key.

## Demo

_TODO: demo GIF here (`docs/demo.gif`) — recorded manually, since loading
an unpacked extension requires a native file picker that can't be
automated._

## Setup

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this project's root folder.
5. Open any GitHub pull request's **Files changed** tab
   (`github.com/<owner>/<repo>/pull/<number>/files`) — you should see a
   summary bar above the file list, and colored edges/badges on any
   medium- or high-risk hunks.

No build step, no runtime dependencies — it's a plain Manifest V3
content script. The test suite uses Node's built-in test runner (Node
18+), so there's nothing to `npm install` for that either:

```bash
npm test
```

This runs [test/risk-engine.unit.test.js](test/risk-engine.unit.test.js)
(heuristic-by-heuristic, including the dead-code-removal and
looks-like-a-rename edge cases) and
[test/risk-engine.real-diffs.test.js](test/risk-engine.real-diffs.test.js)
(the calibration pass against real PR fixtures described above).

The DOM-integration perf harness needs a real browser (it generates and
times 150 synthetic diff files), so it's separate from `npm test`. Serve
the project root and open it — for example with the `static-server`
config already in `.claude/launch.json`:

```bash
python3 -m http.server 8934
```

then visit `http://localhost:8934/test/perf/synthetic-large-diff.html`,
or `http://localhost:8934/test/dom/pull/999/files/self-trigger-regression.html`
for the self-triggering-observer regression check described below.

### End-to-end tests (Playwright)

The E2E suite loads this folder as an unpacked extension into Chromium
(`--load-extension`) and runs it on the live GitHub "Files changed" page
of every PR behind `test/fixtures/real-prs/`. It checks that the summary
bar renders, that high/medium hunks get badges, and that the bar's counts
match what the risk engine gives for the fixture diff. It needs network
access to github.com, so it's separate from `npm test` and isn't run in
CI:

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

By default it runs signed out, which means GitHub serves the **classic**
UI. The new React UI is only served to signed-in sessions. To run the
suite against that UI, sign in once in the window this opens (you type
your own credentials; the session cookies are saved to the gitignored
`e2e/.auth/`):

```bash
npm run test:e2e:login
```

`HEADED=1 npm run test:e2e` shows the browser. Every test is annotated
with the UI it actually saw.

## Known Limitations / Future Work

- **GitHub replaced the Files Changed DOM this extension targets,
  mid-project** (confirmed 2026-09-23, after the original build was
  verified against the old DOM on 2026-08-26) — GitHub now redirects
  `/pull/<n>/files` to `/pull/<n>/changes` and renders it with a full
  React/Primer grid instead of the old server-rendered table. Confirmed
  live against two unrelated repos (a small fixture repo and
  `psf/requests`), so it's a platform-wide rollout, not an
  account-specific preview. It is, however, **signed-in only**: as of
  2026-09-26, signed-out sessions still get the classic UI (`/changes`
  302s back to `/files`), so both DOMs remain in use.
  **v1.1 adapts to this**: `src/content.js`
  now scans both DOM shapes unconditionally on every pass rather than
  detecting one up front, so it keeps working regardless of which UI a
  given session renders — including if GitHub reverts or further
  A/B-tests this change. Verified live against the same SQL-injection
  and signature-change fixture PRs used in the original calibration.
  On 2026-09-26 the new UI's hunk extraction was checked byte-for-byte
  against the fixture diffs on two 19–25-file PRs, including files
  behind its "Load Diff" button. Still not verified: PRs with hundreds
  of files, and the new UI's split view. See
  [docs/github-diff-dom.md](docs/github-diff-dom.md) for the full DOM
  capture and selector mapping.
- **The summary bar over-counts low-risk hunks** (both UIs). GitHub adds
  an "expand to end of file" row after a file's last hunk, and it uses
  the same boundary cell as a real `@@` hunk header. `src/content.js`
  counts it as an empty hunk and scores it low. The result is that the
  "low" count and the "N hunks scanned" total are one too high per file
  that doesn't end at EOF (e.g. 59 low instead of 47 on
  django/django#16012). High/medium counts and badges are correct.
  Caught by the E2E suite; see
  [docs/github-diff-dom.md](docs/github-diff-dom.md).
- **New UI: collapsing and re-expanding a file** throws away and
  rebuilds its diff table, dropping that file's badges. From reading the
  code (not verified live), the next scan should re-mark it, but the
  re-marked hunks can reuse another hunk's `driskh-hunk-N` id, so a
  "Jump to high risk" chip may scroll to the wrong hunk.
- **Regex/string heuristics, not real parsing.** v1 deliberately avoids
  an AST parser to stay lightweight and language-agnostic, but that
  means it can be fooled by things a real parser wouldn't miss: a
  `try`/`catch` keyword inside a string or comment, a variable swapped
  for a different variable of the same "shape" (the rename detector
  requires *consistent* substitution to guard against this, but it's
  still not real semantic analysis), or a function-signature check that
  only recognizes `def`/`function`/`fn`/`func`-style declarations and
  misses bare class methods or arrow functions. **A natural v2 upgrade
  is swapping the regex heuristics for real AST-based diffing** (e.g.
  via `tree-sitter`) for the languages we care most about, falling back
  to the current heuristics for anything unsupported.
- **The summary bar can cosmetically overlap a file's own sticky
  header** for the height of the bar, since both compete for the same
  scroll position and GitHub's own sticky offset isn't (and shouldn't
  be) patched via injected CSS. Doesn't break anything functionally,
  just a few pixels of visual overlap during scroll on multi-file PRs.
- **Expanding context lines within an already-scanned hunk** (GitHub's
  "Expand Up"/"Expand Down" links) doesn't extend that hunk's colored
  edge to the newly-revealed rows, because the per-file hunk-count cache
  (see above) only re-walks a file when its hunk *count* changes, and
  expanding context usually doesn't change that count. Purely cosmetic —
  the added/removed lines driving the risk score haven't changed, so the
  classification itself is still correct — but it can leave a small gap
  in the border. Only merging two adjacent hunks into one (which *does*
  change the count) triggers a re-render of the full hunk today.
- The risk-raising keyword lists (SQL, security) are deliberately
  narrow after calibration surfaced real false positives (see above) —
  which means they're also conservative and will miss variations not in
  the list (e.g. `pwd` instead of `password`, raw SQL built with
  `String.format` instead of `+` concatenation). Widening them safely
  needs more real-PR calibration, not just adding more words.
- **Two concrete gaps found during the 17-fixture review** are still
  open (see
  [What a 17-fixture human review actually found](#what-a-17-fixture-human-review-actually-found)
  for the fixtures and full detail): the boundary-change detector
  misses an off-by-one introduced by *adding* a token instead of
  swapping one, and there's no heuristic for concurrency/race-condition
  bugs at all. (The third, prose and version bumps burying a real flag,
  is fixed.)
- **File classification is path-only.** Linguist also detects generated
  files by content (e.g. a "Code generated … DO NOT EDIT" header), but a
  hunk only carries a few lines from the middle of a file, so a
  generated file at an unconventional path is still scanned as code.
  Documentation detection is also by path. A code sample removed from a
  `.md` file still goes through the structural detectors (by design),
  but a security term inside it no longer raises a flag.
- Test-file-specific handling (e.g. flagging a *weakened or removed*
  assertion, as opposed to just noticing the file is a test) isn't
  implemented — a reasonable v2 addition. Test files currently get the
  same detectors as production code, so on a security fix the tests
  exercising it are flagged high too (5 of the 8 remaining highs on
  stellar/passkey-kit#4).
- Split (side-by-side) diff view was checked live and works: GitHub
  reuses the same `td.blob-code-hunk`/`blob-code-addition`/
  `blob-code-deletion` classes there (a "changed" line just puts the old
  and new versions in the same `<tr>` via `data-split-side="left"`/`"right"`
  instead of two separate rows), so the same selectors and hunk grouping
  apply unchanged — verified by running the real extraction against
  `?diff=split` on the SQL-injection fixture PR and getting the identical
  4-hunk, 1-high classification as unified view. See
  [docs/github-diff-dom.md](docs/github-diff-dom.md) for the exact markup.
- Binary files and renames-with-no-content-changes aren't handled
  distinctly from a normal small diff (they typically produce zero
  hunks, so they end up simply not scanned rather than explicitly
  flagged as "nothing to review here").
- No support yet for GitHub Enterprise custom domains — matches
  `github.com` only.
- The LLM explanation layer only supports Anthropic's API today — no
  OpenAI/other-provider option, and the model id is hardcoded rather
  than user-configurable.
- The "Explain" flow was verified with a mocked background response, not
  a real Anthropic API call — the actual request/response shape
  (`data.content[0].text`) matches Anthropic's documented Messages API
  but hasn't been exercised against the live endpoint.

## Project structure

```
manifest.json                    Manifest V3 config ("storage" permission, background service worker, api.anthropic.com host permission)
.claude/launch.json              Static-server config for opening test/perf/*.html with scripts enabled
src/content.js                   Content script: page detection, hunk extraction, markers, summary bar, toggle, Explain button
src/background.js                Service worker: makes the optional Anthropic API call (only file allowed to)
src/risk-engine.js               Risk detection engine (DOM-free, unit-testable)
docs/github-diff-dom.md          Notes on GitHub's diff DOM/selectors
test/risk-engine.unit.test.js    Heuristic-by-heuristic unit tests
test/risk-engine.real-diffs.test.js  Calibration/regression tests against real PRs
test/fixtures/real-prs/          Raw diffs from real merged PRs, used by the above
test/perf/synthetic-large-diff.html  Manual perf harness (150-file synthetic diff; needs a real DOM, not part of `npm test`)
test/dom/pull/999/files/self-trigger-regression.html  Loads the real content.js/risk-engine.js and asserts the observer doesn't retrigger itself
playwright.config.js             E2E config (npm run test:e2e); kept out of test/ so npm test stays fast and browser-free
e2e/extension-fixture.js         Launches Chromium with this folder loaded via --load-extension
e2e/real-prs.js                  Live PR for each fixture + expected high/medium/low counts from the risk engine
e2e/real-prs.spec.js             E2E tests against those live PR pages
e2e/save-github-session.js       npm run test:e2e:login — saves a signed-in session so E2E covers the new React UI
.github/workflows/test.yml       CI: npm test on every push and PR
```
