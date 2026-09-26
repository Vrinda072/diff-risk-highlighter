# Working rules for this repo

## Branches and PRs
- Every change goes on its own branch and ends as a PR opened with `gh pr create`.
- Never commit to `main`.

## Tests
- Run `npm test` before every commit.
- Never delete or weaken existing tests to make them pass. If a test looks wrong, raise it instead of editing it.

## Heuristic changes (`src/risk-engine.js`)
- Check every change against every fixture in `test/fixtures/real-prs/` (not just the ones with assertions in `test/risk-engine.real-diffs.test.js`).
- Report per-fixture high/medium/low hunk counts from before and after the change in the PR description. Load fixtures the same way the real-diffs test does: `parseDiff` from `test/helpers/parse-diff.js`, then `assessHunk`.

## Build-free extension
- No bundlers, transpilers, or build steps. The files in `src/` load in Chrome exactly as written.
- No runtime dependencies inside `src/` unless the repo owner approves first.

## Docs
- When a change fixes a limitation, update the README's "Known Limitations / Future Work" section in the same PR.
