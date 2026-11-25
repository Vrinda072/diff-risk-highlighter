# Held-out evaluation

**Question:** when a reviewer only reads the first three hunks, does the
extension's ordering put the real fix among them more often than GitHub's own
order does?

The 42 pull requests in `test/fixtures/real-prs/` informed the heuristics, so
their 71 of 84 fix-hunk figure describes the development set. It says nothing
about new code. This folder measures new code.

## What is sealed

`heldout.json` lists 100 merged pull requests (67 bug fixes, 33 ordinary
changes) from 100 repositories, with each diff's SHA-256.

- Popular, active repositories (1,000+ stars): TypeScript, JavaScript, Python,
  Go, Rust, Java, C++ and C#. **No Ruby or PHP** — the quotas filled before the
  collector reached them.
- Collected in two batches the same day (60, then 40 more), both before the
  engine changed from the baseline. The pilot was drawn from the first batch.
- **Merged after the audit** that inspected development data, and from no
  repository in `seen-repos.json` (every repo that appeared while building or
  auditing the engine).
- 6 to 40 hunks. With three or fewer hunks every ordering scores 100%.
- One PR per repository. A random 12 are marked `pilot`.
- Nobody, including the author of the harness, has run the engine on them.
  Third-party diffs are not committed; `fetch.js` re-downloads and verifies them.

`baseline-1.1.0` is the git tag of the engine as it stood when the set was
sealed. Changes made afterwards use development data only: the fixtures under
`test/fixtures/` and the 94 PRs from the November 2026 audit (which stopped
being held-out the moment their errors were read). No development data comes
from a repository in the sealed set.

## Steps

```bash
node eval/fetch.js --pilot
node eval/label.js --name yourname --pilot     # open the printed file
# label, press "Export labels", save the download as eval/labels/yourname.json
node eval/score.js --labels eval/labels/yourname.json
```

Then drop `--pilot` for the full set. For agreement, have a second person label
the pilot on their own and add `--second eval/labels/them.json`.

**Rules that keep the result honest:** label before scoring; do not run the
extension on these PRs; do not tune the engine after looking at held-out
results. If you do tune, this set becomes development data and a new one has to
be sealed (`node eval/collect.js --since <date>`, after adding these repos to
`seen-repos.json`).

## What gets reported

- **Fix in the first 1 and 3 hunks** for bug-fix PRs, with a 95% bootstrap
  interval, for: the extension (severity, ties in display order), GitHub's
  order, largest hunk first, and random.
- Fix-hunk recall, the share of hunks flagged (the review budget), precision
  against the separate "needs close review" labels.
- Cohen's kappa when two people label the same PRs.

## Questions fixed before labelling

On the development set two signals picked fix hunks worse than chance
([docs/ablation.md](../docs/ablation.md)): the large-hunk fallback (2 fixes in
14 flags) and the security keyword inside a test (0 in 9). Fix labels cannot say
whether those hunks deserve a read, so neither was changed. The scorer also
reports the engine without each one. A signal goes only if removing it costs no
fix-in-first-3 and no review-worthy hunks beyond what the confidence intervals
can distinguish, and precision against "needs close review" goes up. With this
many pull requests the answer may be "can't tell yet".

## Limits of this design

- Bug-fix versus ordinary starts as a guess from the title; the labeller can
  change or exclude it.
- One day's merges from popular repositories is not all code review.
- Even 100 PRs gives wide intervals, and the 12-PR pilot much wider. Report them.
