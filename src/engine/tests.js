// Weakened, removed or skipped test assertions.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'), require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.tests = factory(parts.text, parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (textModule, languageModule) {
  'use strict';

  const { BOUNDARY_PAIR_SIMILARITY, STRING_LITERAL_RE, pairLines } = textModule;
  const { isCommentLine, languageOf } = languageModule;

  const TEST_PATH_PATTERNS = [
    /(^|\/)(tests?|__tests__|spec|specs|testing)\//i,
    /(^|\/)test_[^/]+\.py$|_tests?\.py$|(^|\/)tests?\.py$/, // tests.py: Django's convention
    /_test\.(go|rs|c|cc|cpp|exs?)$/,
    /\.(test|spec)\.[cm]?[jt]sx?$/,
    /(Test|Tests|IT|Spec)\.(java|kt|scala|cs|php|swift|groovy)$/,
    /_spec\.rb$|(^|\/)test_[^/]+\.rb$/,
  ];

  function isTestFile(filePath) {
    return TEST_PATH_PATTERNS.some((re) => re.test(filePath || ''));
  }

  const ASSERTION_RE =
    /\b(assert\w*|expect|require\.\w+|XCTAssert\w*|(EXPECT|ASSERT)_[A-Z_]+|should\w*|verify)\s*[.(!]|^\s*assert\s|#expect\s*\(/;

  function countAssertions(lines, lang) {
    return lines.filter((l) => !isCommentLine(l, lang) && ASSERTION_RE.test(l.replace(STRING_LITERAL_RE, '""'))).length;
  }

  // Strict matcher -> matcher that accepts strictly more values.
  const LOOSENED_MATCHERS = [
    [/\.(toEqual|toStrictEqual|toBe|toMatchObject|toHaveLength)\(/, /\.(toBeTruthy|toBeDefined|toBeFalsy|not\.toBeNull|not\.toBeUndefined|toBeInstanceOf)\(/],
    [/\bassert(Equal|Equals|Same|Identical|ListEqual|DictEqual|CountEqual)\s*\(/, /\bassert(True|False|IsNotNone|NotNull|IsNone|Null|IsInstance)\s*\(/],
    [/\bassert\.(Equal|Exactly|Same|ElementsMatch)\(/, /\bassert\.(True|NotNil|NotEmpty|Contains|Greater\w*|Less\w*)\(/],
    [/\bassert_eq!\(/, /\bassert!\(/],
  ];
  // What an exact expected string was replaced with, if it got looser.
  const LOOSE_EXPECTATION_RE = /^\/.*\/[a-z]*$|^expect\.(any|anything|stringContaining|stringMatching|objectContaining|arrayContaining)\(|^(mock\.|unittest\.mock\.)?ANY$/;
  const NUMBER_RE = /\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
  const UPPER_BOUND_ASSERT_RE = /\b(assertLess\w*|toBeLessThan\w*|assert\.Less\w*|lessThan\w*)\b|<=?/;
  const LOWER_BOUND_ASSERT_RE = /\b(assertGreater\w*|toBeGreaterThan\w*|assert\.Greater\w*|greaterThan\w*)\b|>=?/;
  const TOLERANCE_RE = /\b(rtol|atol|delta|places|tolerance|tol|epsilon|eps|abs|rel)\s*=/;
  const COMPARISON_RE = /<=|>=|==|!=|<|>/g;
  const SKIP_MARKER_RE =
    /\b(it|test|describe|context)\.(skip|todo)\(|\b(xit|xtest|xdescribe|xcontext)\(|@(pytest\.mark\.skip\w*|unittest\.skip\w*|skip\w*|Disabled|Ignore)\b|\[(Ignore|Skip)\b|\bt\.Skip(Now|f)?\(|\bpytest\.skip\(|\bself\.skipTest\(|#\[ignore\]/;

  function assertionVerb(line) {
    const m = line.match(/\b(assert\w*|expect|require\.\w+|XCTAssert\w*|(?:EXPECT|ASSERT)_[A-Z_]+)\b/);
    return m ? m[1] : null;
  }

  // Common prefix/suffix split of two lines: what the edit replaced.
  function changedMiddle(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return [a.slice(p, a.length - s).trim(), b.slice(p, b.length - s).trim()];
  }

  function weakenedAssertionInPair(removed, added, lang) {
    if (isCommentLine(removed, lang) || isCommentLine(added, lang)) return null;

    for (const [strict, loose] of LOOSENED_MATCHERS) {
      if (strict.test(removed) && !strict.test(added) && loose.test(added)) {
        return `Assertion loosened: "${removed.match(strict)[0]}" replaced by "${added.match(loose)[0]}".`;
      }
    }

    const [was, now] = changedMiddle(removed, added);
    const wasString = /^(["'`]).*\1,?$/.test(was);
    if (wasString && LOOSE_EXPECTATION_RE.test(now.replace(/,$/, ''))) {
      return 'An exact expected string in a test was replaced by a looser pattern.';
    }

    if (!ASSERTION_RE.test(removed) || assertionVerb(removed) !== assertionVerb(added)) return null;

    const skeleton = (l) => l.replace(STRING_LITERAL_RE, '""').replace(NUMBER_RE, 'N').replace(/\s+/g, '');
    if (skeleton(removed) === skeleton(added)) {
      const rNums = removed.replace(STRING_LITERAL_RE, '""').match(NUMBER_RE) || [];
      const aNums = added.replace(STRING_LITERAL_RE, '""').match(NUMBER_RE) || [];
      const i = rNums.findIndex((n, k) => n !== aNums[k]);
      if (i !== -1 && rNums.filter((n, k) => n !== aNums[k]).length === 1) {
        const [from, to] = [parseFloat(rNums[i]), parseFloat(aNums[i])];
        const upper = UPPER_BOUND_ASSERT_RE.test(removed) || TOLERANCE_RE.test(removed);
        const lower = LOWER_BOUND_ASSERT_RE.test(removed) && !upper;
        if ((upper && to > from) || (lower && to < from)) {
          return `Assertion threshold loosened (${rNums[i]} → ${aNums[i]}) — check the test wasn't relaxed just to pass.`;
        }
      }
      return null;
    }

    const rComparisons = (removed.replace(STRING_LITERAL_RE, '""').match(COMPARISON_RE) || []).length;
    const aComparisons = (added.replace(STRING_LITERAL_RE, '""').match(COMPARISON_RE) || []).length;
    if (aComparisons < rComparisons && aComparisons > 0) {
      return 'An assertion lost a condition (fewer comparisons in the same assertion) — check the test still covers what it did.';
    }
    return null;
  }

  function detectWeakenedTest(filePath, removedLines, addedLines) {
    if (!isTestFile(filePath)) return null;

    const skipsAdded = addedLines.filter((l) => SKIP_MARKER_RE.test(l)).length;
    const skipsRemoved = removedLines.filter((l) => SKIP_MARKER_RE.test(l)).length;
    if (skipsAdded > skipsRemoved) return 'A test was skipped/disabled — confirm it is tracked and not just hiding a failure.';

    const lang = languageOf(filePath);
    const removedCount = countAssertions(removedLines, lang);
    const addedCount = countAssertions(addedLines, lang);
    if (removedCount > addedCount) {
      const n = removedCount - addedCount;
      return `Removed ${n} test assertion${n === 1 ? '' : 's'} — check the behavior is still covered, not just that the test passes.`;
    }

    for (const { removed, added } of pairLines(removedLines, addedLines, BOUNDARY_PAIR_SIMILARITY)) {
      if (removed.trim() === added.trim()) continue;
      const reason = weakenedAssertionInPair(removed, added, lang);
      if (reason) return reason;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Concurrency: a first, deliberately conservative pass. It prefers
  // missing races over flagging ordinary code, so it only looks for two
  // shapes whose meaning doesn't depend on knowing the program:
  //   1. Synchronization removed: fewer lock/atomic/synchronized uses on
  //      the added side than the removed side of the same hunk. Swapping
  //      one primitive for another (volatile -> atomic_bool, raw mutex ->
  //      LockGuarded) nets out and isn't flagged.
  //   2. A new check-then-act on a shared container (check membership,
  //      then insert) in code that visibly runs concurrently, with no lock
  //      added alongside it.
  // Real race *fixes* usually add synchronization, which neither shape
  // flags — see test/fixtures/real-prs (race-condition) for how that plays
  // out on real PRs.
  // ---------------------------------------------------------------------

  return {
    detectWeakenedTest,
    isTestFile,
  };
});
