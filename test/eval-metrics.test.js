// The held-out scoring math (eval/metrics.js) on small hand-checked cases, so
// the numbers in a report can be trusted.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGIES, hitAtK, randomHitAtK, bootstrapCI, evaluate, cohensKappa } = require('../eval/metrics.js');
const { hunksOf } = require('../eval/hunks.js');

const h = (level, size = 1) => ({ level, size });

describe('orderings', () => {
  const hunks = [h('low', 9), h('medium', 2), h('high', 1), h('medium', 50)];

  it('engine: severity first, display order breaks ties', () => {
    assert.deepEqual(STRATEGIES.engine(hunks), [2, 1, 3, 0]);
  });
  it('display: untouched', () => {
    assert.deepEqual(STRATEGIES.display(hunks), [0, 1, 2, 3]);
  });
  it('largest first', () => {
    assert.deepEqual(STRATEGIES.largest(hunks), [3, 0, 1, 2]);
  });
});

describe('hit rates', () => {
  it('hitAtK only looks at the first k', () => {
    assert.equal(hitAtK([4, 3, 2, 1, 0], new Set([2]), 2), false);
    assert.equal(hitAtK([4, 3, 2, 1, 0], new Set([2]), 3), true);
  });
  it('random order: one relevant hunk in 10, top 3 = 30%', () => {
    assert.ok(Math.abs(randomHitAtK(10, 1, 3) - 0.3) < 1e-9);
  });
  it('random order: 2 relevant of 4, top 2 = 1 - 1/6', () => {
    assert.ok(Math.abs(randomHitAtK(4, 2, 2) - 5 / 6) < 1e-9);
  });
  it('random order: k at least n always hits', () => {
    assert.equal(randomHitAtK(2, 1, 3), 1);
  });
});

describe('evaluate', () => {
  const prs = [
    // engine puts the fix (index 4) first; display order does not
    { kind: 'bugfix', hunks: [h('low'), h('low'), h('low'), h('low'), h('high')], fix: new Set([4]), review: new Set() },
    // engine misses: the fix is scored low and sits last
    { kind: 'bugfix', hunks: [h('medium'), h('medium'), h('medium'), h('low'), h('low')], fix: new Set([4]), review: new Set([0]) },
    // ordinary PR: counts toward review budget and precision only
    { kind: 'ordinary', hunks: [h('medium'), h('low')], fix: new Set(), review: new Set() },
  ];
  const r = evaluate(prs, { k: 3 });

  it('computes top-3 hit rate over bug-fix PRs only', () => {
    assert.equal(r.bugfixWithLabels, 2);
    assert.equal(r.hit['engine@3'].rate, 0.5);
    assert.equal(r.hit['display@3'].rate, 0);
  });
  it('computes recall, budget and precision', () => {
    assert.equal(r.fixRecall, 0.5); // 1 of 2 fix hunks flagged
    assert.equal(r.reviewBudget, 5 / 12);
    assert.equal(r.precision, 2 / 5); // flagged and review-worthy (fix counts)
    assert.equal(r.reviewRecall, 2 / 3);
  });
});

describe('uncertainty and agreement', () => {
  it('bootstrap CI is reproducible and brackets the mean', () => {
    const values = [1, 1, 1, 0, 0, 1, 0, 1, 1, 1];
    const [lo, hi] = bootstrapCI(values);
    assert.deepEqual(bootstrapCI(values), [lo, hi]);
    assert.ok(lo <= 0.7 && hi >= 0.7 && lo < hi);
  });
  it("Cohen's kappa: perfect agreement is 1, chance-level is 0", () => {
    assert.equal(cohensKappa([true, false, true, false], [true, false, true, false]), 1);
    assert.equal(cohensKappa([true, true, false, false], [true, false, true, false]), 0);
  });
});

describe('hunksOf', () => {
  it('numbers hunks like the test parser and keeps their raw text', () => {
    const diff = [
      'diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js',
      '@@ -1,2 +1,2 @@', ' keep', '-old', '+new',
      '@@ -9 +9 @@', '-a', '+b',
    ].join('\n');
    const hunks = hunksOf(diff);
    assert.deepEqual(hunks.map((x) => [x.index, x.filePath, x.removedLines, x.addedLines]), [
      [0, 'x.js', ['old'], ['new']],
      [1, 'x.js', ['a'], ['b']],
    ]);
    assert.equal(hunks[0].text, ' keep\n-old\n+new');
  });
});
