// Pure scoring math for the held-out evaluation (unit-tested in
// test/eval-metrics.test.js). The question it answers: when a reviewer has
// time for only the first K hunks, does the ordering put the real fix there?

const RANK = { high: 2, medium: 1, low: 0 };

// Each strategy returns hunk positions in the order a reviewer would read
// them. Ties always fall back to display order, so results are reproducible.
const STRATEGIES = {
  // the extension: by severity
  engine: (hunks) => order(hunks, (h) => RANK[h.level]),
  // what GitHub shows today
  display: (hunks) => hunks.map((_, i) => i),
  // a cheap heuristic anyone could use: biggest change first
  largest: (hunks) => order(hunks, (h) => h.size),
};

function order(hunks, score) {
  return hunks.map((_, i) => i).sort((a, b) => score(hunks[b]) - score(hunks[a]) || a - b);
}

function hitAtK(ranking, relevant, k) {
  return ranking.slice(0, k).some((i) => relevant.has(i));
}

// Chance a uniformly random order puts at least one of `relevant` items in the
// first k of n: 1 - C(n - r, k) / C(n, k).
function randomHitAtK(n, r, k) {
  if (r <= 0) return 0;
  let miss = 1;
  for (let i = 0; i < Math.min(k, n); i++) miss *= Math.max(0, n - r - i) / (n - i);
  return 1 - miss;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// 95% percentile bootstrap over pull requests (seeded, so reports reproduce).
function bootstrapCI(values, { iterations = 4000, seed = 7 } = {}) {
  if (!values.length) return [NaN, NaN];
  let state = seed;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iterations)], means[Math.ceil(0.975 * iterations) - 1]];
}

// prs: [{ kind, hunks: [{level, size}], fix: Set, review: Set }]
function evaluate(prs, { k = 3 } = {}) {
  const bugfixes = prs.filter((p) => p.kind === 'bugfix' && p.fix.size > 0);
  const hit = {};
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    for (const depth of [1, k]) {
      const values = bugfixes.map((p) => (hitAtK(strategy(p.hunks), p.fix, depth) ? 1 : 0));
      hit[`${name}@${depth}`] = { rate: mean(values), ci: bootstrapCI(values), n: values.length };
    }
  }
  for (const depth of [1, k]) {
    hit[`random@${depth}`] = { rate: mean(bugfixes.map((p) => randomHitAtK(p.hunks.length, p.fix.size, depth))), n: bugfixes.length };
  }

  let fixTotal = 0, fixFlagged = 0, hunkTotal = 0, flagged = 0, flaggedReview = 0, reviewTotal = 0, high = 0, highReview = 0;
  for (const p of prs) {
    p.hunks.forEach((h, i) => {
      const isFlag = h.level !== 'low';
      hunkTotal++;
      if (isFlag) flagged++;
      if (h.level === 'high') high++;
      if (p.fix.has(i)) { fixTotal++; if (isFlag) fixFlagged++; }
      // A labelled fix hunk is review-worthy by definition.
      if (p.review.has(i) || p.fix.has(i)) {
        reviewTotal++;
        if (isFlag) flaggedReview++;
        if (h.level === 'high') highReview++;
      }
    });
  }
  const ratio = (a, b) => (b ? a / b : NaN);
  return {
    k,
    pullRequests: prs.length,
    bugfixWithLabels: bugfixes.length,
    hunks: hunkTotal,
    hit,
    fixRecall: ratio(fixFlagged, fixTotal),
    reviewBudget: ratio(flagged, hunkTotal),
    precision: ratio(flaggedReview, flagged),
    highPrecision: ratio(highReview, high),
    reviewRecall: ratio(flaggedReview, reviewTotal),
  };
}

// Agreement between two labellers on the same yes/no decisions.
function cohensKappa(a, b) {
  if (a.length !== b.length || !a.length) return NaN;
  const n = a.length;
  const agree = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.filter(Boolean).length / n;
  const pb = b.filter(Boolean).length / n;
  const chance = pa * pb + (1 - pa) * (1 - pb);
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

module.exports = { STRATEGIES, hitAtK, randomHitAtK, bootstrapCI, evaluate, cohensKappa };
