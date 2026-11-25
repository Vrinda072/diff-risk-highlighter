// Levels, tokenizing and line pairing shared by the detectors.

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.text = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** @type {{LOW: 'low', MEDIUM: 'medium', HIGH: 'high'}} */
  const LEVELS = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };
  const LEVEL_RANK = { low: 0, medium: 1, high: 2 };

  // ---------------------------------------------------------------------

  // boundary-operator detectors below.
  // ---------------------------------------------------------------------

  // Longest-first so e.g. "..=" is matched whole rather than as ".." + "=".
  const MULTI_CHAR_OPERATORS = [
    '..=', '===', '!==', '<=', '>=', '==', '!=', '&&', '||', '=>', '->',
    '::', '..', '++', '--', '+=', '-=', '*=', '/=', '**', '<<', '>>', '??', '?.',
    ':=', '<-', '|=', '&=', '^=', '%=',
  ].sort((a, b) => b.length - a.length);

  const TOKEN_RE = new RegExp(
    MULTI_CHAR_OPERATORS.map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
      '|[A-Za-z_$][A-Za-z0-9_$]*|\\d+(?:\\.\\d+)?|[^\\sA-Za-z0-9_$]',
    'g'
  );

  function tokenize(/** @type {string} */ line) {
    const tokens = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(line))) {
      const value = m[0];
      let type = 'other';
      if (/^[A-Za-z_$]/.test(value)) type = 'ident';
      else if (/^\d/.test(value)) type = 'number';
      tokens.push({ type, value });
    }
    return tokens;
  }

  // Common keywords across the languages we're likely to see in a GitHub
  // diff. Used to stop the rename detector from treating a changed
  // keyword (e.g. `if` -> `while`) as "just a renamed identifier".
  const KEYWORDS = new Set(
    (
      'if else elif for while do switch case default break continue return ' +
      'def class function func fn let const var public private protected ' +
      'static final abstract void int float double bool boolean char string ' +
      'str new this self super import from as export default try catch ' +
      'except finally throw raise async await yield lambda match struct ' +
      'impl trait enum interface extends implements null none nil true ' +
      'false undefined in of not and or is typeof instanceof delete ' +
      'package module require include using namespace go defer chan ' +
      'select goto sizeof template typename'
    ).split(/\s+/)
  );

  // Case-sensitive on purpose: most languages this targets have lowercase
  // keywords, and a class/identifier that happens to share letters with one
  // case-insensitively (e.g. a class named `Raise`, cf. django#21696's
  // `Raise` -> `FetchRaise`) is a real identifier, not the keyword.
  function isKeyword(/** @type {string} */ word) {
    return KEYWORDS.has(word);
  }

  function bigrams(/** @type {string} */ str) {
    const counts = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      counts.set(bg, (counts.get(bg) || 0) + 1);
    }
    return counts;
  }

  // Sorensen-Dice coefficient over character bigrams: cheap, dependency-free,
  // and good enough to tell "this is probably the edited version of that
  // line" apart from "this is an unrelated line" without a real diff algorithm.
  // A line's bigram profile is built once and reused for every comparison.
  /** @typedef {{trimmed: string, grams: Map<string, number>, total: number}} Profile */

  function lineProfile(/** @type {string} */ line) {
    const trimmed = line.trim();
    const grams = bigrams(trimmed);
    let total = 0;
    for (const count of grams.values()) total += count;
    return { trimmed, grams, total };
  }

  function profileSimilarity(/** @type {Profile} */ a, /** @type {Profile} */ b) {
    if (a.trimmed === b.trimmed) return 1;
    if (a.grams.size === 0 || b.grams.size === 0) return 0;
    let intersection = 0;
    for (const [bg, count] of a.grams) {
      const other = b.grams.get(bg);
      if (other) intersection += Math.min(count, other);
    }
    return (2 * intersection) / (a.total + b.total);
  }

  function lineSimilarity(/** @type {any} */ a, /** @type {any} */ b) {
    return profileSimilarity(lineProfile(a), lineProfile(b));
  }

  // Comparing every removed line with every added line is quadratic: one real
  // 1,500-line hunk cost seconds of GitHub's main thread, and 6,000 x 6,000
  // took 111 s. Hunks up to this many line pairs are still compared
  // exhaustively. Bigger ones first match identical lines, then use those as
  // anchors and only compare each remaining removed line with added lines near
  // where its neighbours landed.
  const MAX_EXHAUSTIVE_PAIRS = 40000;
  const PAIR_WINDOW = 40;

  // For large hunks: where each identical removed line sits on the added side.
  function exactMatches(/** @type {Profile[]} */ removed, /** @type {Profile[]} */ added) {
    const positions = new Map();
    added.forEach((/** @type {Profile} */ line, /** @type {number} */ i) => {
      if (!positions.has(line.trimmed)) positions.set(line.trimmed, []);
      positions.get(line.trimmed).push(i);
    });
    const cursor = new Map();
    return removed.map((/** @type {Profile} */ line) => {
      const list = positions.get(line.trimmed);
      if (!list) return -1;
      const next = cursor.get(line.trimmed) || 0;
      if (next >= list.length) return -1;
      cursor.set(line.trimmed, next + 1);
      return list[next];
    });
  }

  // Greedy best-match pairing between removed/added lines by similarity.
  // Not a real LCS/Myers diff — but "greedy nearest neighbor" is enough to
  // line up "the edited version of this line" without pulling in a diff library.
  function pairLines(/** @type {string[]} */ removedLines, /** @type {string[]} */ addedLines, /** @type {number} */ threshold) {
    const removed = removedLines.map(lineProfile);
    const added = addedLines.map(lineProfile);
    const large = removed.length * added.length > MAX_EXHAUSTIVE_PAIRS;
    const exact = large ? exactMatches(removed, added) : [];
    const usedAdded = new Array(added.length).fill(false);
    if (large) exact.forEach((/** @type {number} */ i) => i >= 0 && (usedAdded[i] = true));
    // wide enough that the windows still cover the added side when it is much longer
    const half = large ? Math.max(PAIR_WINDOW, Math.ceil(added.length / Math.max(1, removed.length))) : 0;

    const pairs = [];
    let anchor = null;
    for (let r = 0; r < removed.length; r++) {
      const line = removed[r];
      if (large && exact[r] >= 0) {
        anchor = { r, a: exact[r] };
        pairs.push({ removed: removedLines[r], added: addedLines[exact[r]], score: 1 });
        continue;
      }
      let from = 0;
      let to = added.length;
      if (large) {
        const center = anchor ? anchor.a + (r - anchor.r) : Math.round((r * added.length) / removed.length);
        from = Math.max(0, Math.min(center, added.length - 1) - half);
        to = Math.min(added.length, Math.max(center, 0) + half + 1);
      }
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = from; i < to; i++) {
        if (usedAdded[i]) continue;
        const other = added[i];
        // Dice can't exceed this, so skip pairs that can't win (same results, less work).
        if (line.trimmed !== other.trimmed) {
          const bound = (2 * Math.min(line.total, other.total)) / (line.total + other.total || 1);
          if (bound <= bestScore || bound < threshold) continue;
        }
        const score = profileSimilarity(line, other);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx !== -1 && bestScore >= threshold) {
        usedAdded[bestIdx] = true;
        pairs.push({ removed: removedLines[r], added: addedLines[bestIdx], score: bestScore });
      }
    }
    return pairs;
  }

  // ---------------------------------------------------------------------
  // Language facts the safe-transform detectors depend on. What counts as a
  // comment, and whether whitespace or line breaks change behavior, differs
  // by language: `*len = n;` is code in C, `--count;` is a decrement, and a
  // Python or YAML dedent moves a line into a different block.
  // ---------------------------------------------------------------------

  // The other off-by-one shape: the fix *adds* (or drops) a `+ 1` / `- 1`
  // instead of swapping a token — kmturbulenz/mglet-base#226
  // (`idx = ... + (i-1)*kk*jj` -> `... - 1`), uqfoundation/dill#651
  // (`range(1,lbuf)` -> `range(1,lbuf+1)`), microsoft/global-renewables-
  // watch#12 (`randint(0, width - size)` -> `... + 1`), twmb/franz-go#381
  // (a stray `+ 1` removed). Deliberately narrow: the pair must be the only
  // difference on the line, the literal must be exactly 1, and the line
  // must read like an index/bound expression (subscript, comparison, or a
  // bound-ish identifier), so an ordinary `total = total + 1` rewrite of
  // unrelated code doesn't qualify.
  const STRING_LITERAL_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;

  const BOUNDARY_PAIR_SIMILARITY = 0.5;

  return {
    BOUNDARY_PAIR_SIMILARITY,
    LEVELS,
    LEVEL_RANK,
    MULTI_CHAR_OPERATORS,
    STRING_LITERAL_RE,
    isKeyword,
    lineSimilarity,
    pairLines,
    tokenize,
  };
});
