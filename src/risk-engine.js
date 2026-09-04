// Diff Risk Highlighter — risk detection engine (Milestone 2)
//
// Pure, DOM-free scoring module: given one diff hunk's added/removed lines
// and file path, returns a risk level + a one-line reason a reviewer can
// act on. No parsing/AST — deliberately regex/text heuristics (see
// README "Known Limitations" for why, and when to graduate to a parser).
//
// Calibrated against real merged PRs (see test/fixtures/), not invented
// examples — most notably:
//   - psf/requests#4052, django/django#21696  -> signature-change / rename
//   - VIP-portal#698, deltablot/partage#8     -> SQL injection / XSS
//   - django#18925, pandas#66045, numpy#32143 -> "dead code" branch removal
//   - alacritty#9027                          -> a 1-line off-by-one
//   - passcore#150                            -> pure reformatting
//
// Exposed as a UMD-ish global so it can be loaded as a second
// <script>/content-script file (see manifest.json) with zero build step,
// while still being `require`-able from Node for the test suite.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DiffRiskEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVELS = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };
  const LEVEL_RANK = { low: 0, medium: 1, high: 2 };

  // ---------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------

  const LARGE_HUNK_LINE_THRESHOLD = 40;
  const RENAME_PAIR_SIMILARITY = 0.35;
  const BOUNDARY_PAIR_SIMILARITY = 0.5;

  // ---------------------------------------------------------------------
  // Tokenizing + line-similarity helpers, shared by the rename and
  // boundary-operator detectors below.
  // ---------------------------------------------------------------------

  // Longest-first so e.g. "..=" is matched whole rather than as ".." + "=".
  const MULTI_CHAR_OPERATORS = [
    '..=', '===', '!==', '<=', '>=', '==', '!=', '&&', '||', '=>', '->',
    '::', '..', '++', '--', '+=', '-=', '*=', '/=', '**',
  ].sort((a, b) => b.length - a.length);

  const TOKEN_RE = new RegExp(
    MULTI_CHAR_OPERATORS.map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
      '|[A-Za-z_$][A-Za-z0-9_$]*|\\d+(?:\\.\\d+)?|[^\\sA-Za-z0-9_$]',
    'g'
  );

  function tokenize(line) {
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
  function isKeyword(word) {
    return KEYWORDS.has(word);
  }

  function bigrams(str) {
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
  function lineSimilarity(a, b) {
    const ta = a.trim();
    const tb = b.trim();
    if (ta === tb) return 1;
    const A = bigrams(ta);
    const B = bigrams(tb);
    if (A.size === 0 || B.size === 0) return ta === tb ? 1 : 0;
    let intersection = 0;
    for (const [bg, count] of A) {
      if (B.has(bg)) intersection += Math.min(count, B.get(bg));
    }
    let totalA = 0;
    for (const c of A.values()) totalA += c;
    let totalB = 0;
    for (const c of B.values()) totalB += c;
    return (2 * intersection) / (totalA + totalB);
  }

  // Greedy best-match pairing between removed/added lines by similarity.
  // Not a real LCS/Myers diff — but hunks are short, and "greedy nearest
  // neighbor" is enough to line up "the edited version of this line"
  // without pulling in a diff library.
  function pairLines(removedLines, addedLines, threshold) {
    const usedAdded = new Set();
    const pairs = [];
    for (const removed of removedLines) {
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < addedLines.length; i++) {
        if (usedAdded.has(i)) continue;
        const score = lineSimilarity(removed, addedLines[i]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx !== -1 && bestScore >= threshold) {
        usedAdded.add(bestIdx);
        pairs.push({ removed, added: addedLines[bestIdx], score: bestScore });
      }
    }
    return pairs;
  }

  // ---------------------------------------------------------------------
  // Safe-transform detectors: hunks that are provably behavior-preserving,
  // so they short-circuit to LOW before any keyword scan runs. (A pure
  // rename of a variable called `password` is still safe to skim — the
  // logic didn't change just because the word is scary.)
  // ---------------------------------------------------------------------

  function normalizeForFormatting(lines) {
    return lines
      .join('\n')
      .replace(/\s+/g, '')
      .replace(/,+([)\]}])/g, '$1'); // trailing commas are cosmetic (see passcore#150 fixture)
  }

  function detectFormattingOnly(removedLines, addedLines) {
    if (removedLines.length === 0 || addedLines.length === 0) return false;
    const r = normalizeForFormatting(removedLines);
    const a = normalizeForFormatting(addedLines);
    return r.length > 0 && r === a;
  }

  // Lockfiles and other machine-generated files are near-universally
  // skipped in code review (they're regenerated by tooling, not
  // hand-edited) — no real PR fixture was needed to justify this one,
  // it's standard reviewer practice across virtually every ecosystem.
  const GENERATED_FILE_RE =
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.generated\.\w+$/i;

  function detectGeneratedFile(filePath) {
    return GENERATED_FILE_RE.test(filePath);
  }

  const COMMENT_LINE_RE = /^\s*(#|\/\/|\/\*|\*|--|;|"""|''')/;

  function detectCommentOnly(removedLines, addedLines) {
    const all = [...removedLines, ...addedLines].filter((l) => l.trim() !== '');
    if (all.length === 0) return false;
    return all.every((l) => COMMENT_LINE_RE.test(l));
  }

  // Checks whether every non-identical removed/added line pair differs
  // *only* by consistent identifier substitution (same old name always
  // maps to the same new name, and vice versa) — i.e. a mechanical rename,
  // not a rewrite that happens to keep the line short.
  function detectPureRename(removedLines, addedLines) {
    if (removedLines.length === 0 || removedLines.length !== addedLines.length) return false;

    const pairs = pairLines(removedLines, addedLines, RENAME_PAIR_SIMILARITY);
    if (pairs.length !== removedLines.length) return false;

    const mapping = new Map();
    const reverseMapping = new Map();
    let sawDifference = false;

    for (const { removed, added } of pairs) {
      if (removed.trim() === added.trim()) continue;

      const rTokens = tokenize(removed);
      const aTokens = tokenize(added);
      if (rTokens.length !== aTokens.length) return false;

      for (let i = 0; i < rTokens.length; i++) {
        const rt = rTokens[i];
        const at = aTokens[i];
        if (rt.type !== at.type) return false;
        if (rt.value === at.value) continue;

        if (rt.type !== 'ident') return false; // punctuation/operator/number changed -> real edit
        if (isKeyword(rt.value) || isKeyword(at.value)) return false;

        if (mapping.has(rt.value) && mapping.get(rt.value) !== at.value) return false;
        if (reverseMapping.has(at.value) && reverseMapping.get(at.value) !== rt.value) return false;
        mapping.set(rt.value, at.value);
        reverseMapping.set(at.value, rt.value);
        sawDifference = true;
      }
    }

    return sawDifference;
  }

  // ---------------------------------------------------------------------
  // Risk-raising detectors
  // ---------------------------------------------------------------------

  const CONFUSABLE_OPERATOR_PAIRS = [
    ['<=', '<'],
    ['>=', '>'],
    ['..=', '..'],
    ['===', '=='],
    ['!==', '!='],
    ['&&', '||'],
  ];

  // Finds a hunk where one line was edited into an almost-identical line
  // that differs in exactly one token, and that token is a comparison /
  // range operator or an off-by-one-shaped integer literal change.
  // Modeled directly on alacritty#9027 (`..` -> `..=` in a range bound).
  function detectBoundaryChange(removedLines, addedLines) {
    const pairs = pairLines(removedLines, addedLines, BOUNDARY_PAIR_SIMILARITY);
    for (const { removed, added } of pairs) {
      if (removed.trim() === added.trim()) continue;

      const rTokens = tokenize(removed);
      const aTokens = tokenize(added);
      if (rTokens.length !== aTokens.length) continue;

      const diffIndexes = [];
      for (let i = 0; i < rTokens.length; i++) {
        if (rTokens[i].value !== aTokens[i].value) diffIndexes.push(i);
      }
      if (diffIndexes.length !== 1) continue;

      const i = diffIndexes[0];
      const rVal = rTokens[i].value;
      const aVal = aTokens[i].value;

      for (const [long, short] of CONFUSABLE_OPERATOR_PAIRS) {
        if ((rVal === long && aVal === short) || (rVal === short && aVal === long)) {
          return `Comparison/range boundary changed ("${rVal}" → "${aVal}") on an otherwise unchanged line — classic off-by-one shape.`;
        }
      }

      if (rTokens[i].type === 'number' && aTokens[i].type === 'number') {
        if (Math.abs(parseInt(rVal, 10) - parseInt(aVal, 10)) === 1) {
          return `A numeric literal shifted by 1 ("${rVal}" → "${aVal}") on an otherwise unchanged line — classic off-by-one shape.`;
        }
      }
    }
    return null;
  }

  const ERROR_HANDLING_RE = /\b(try|catch|except|finally|rescue)\b/g;

  function countMatches(lines, re) {
    let count = 0;
    for (const line of lines) {
      count += (line.match(re) || []).length;
    }
    return count;
  }

  // Comparing counts (not just "does removedLines mention try/catch") matters
  // in practice: reformatting a try/catch block re-wraps its lines, so the
  // keyword shows up in removedLines even though addedLines still has the
  // exact same handling — that's not a removal. Confirmed against
  // passcore#150, a pure-reformat PR that false-positived here before this
  // fix (a try/catch got re-indented, not removed).
  function detectRemovedErrorHandling(removedLines, addedLines) {
    return countMatches(removedLines, ERROR_HANDLING_RE) > countMatches(addedLines, ERROR_HANDLING_RE);
  }

  const CONDITIONAL_RE = /^[\s})]*\b(if|else if|elif|else|switch|case|match)\b/;
  const EXIT_KEYWORD_RE = /\b(return|raise|throw)\b/;

  function detectRemovedConditional(removedLines) {
    const conditionalLines = removedLines.filter((l) => CONDITIONAL_RE.test(l));
    if (conditionalLines.length === 0) return null;

    const substantial =
      conditionalLines.length >= 3 || removedLines.some((l) => EXIT_KEYWORD_RE.test(l));

    return {
      severity: substantial ? LEVELS.HIGH : LEVELS.MEDIUM,
      reason:
        'Removed a conditional branch — confirm it was actually unreachable, not a behavior change.',
    };
  }

  // A single SQL-ish word ("delete", "select") is common English/app
  // vocabulary (a "delete" button, a <select> dropdown, `.delete()` on an
  // ORM queryset) and matches constantly in ordinary code. Real query
  // construction almost always pairs a verb with a clause keyword
  // (SELECT...FROM, DELETE...WHERE, INSERT...VALUES) — requiring both
  // cuts a huge amount of noise. Confirmed against django/django#16012's
  // real test suite, which is full of bare "delete"/"select" as English
  // words and previously false-positived here.
  const SQL_VERB_RE = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i;
  // NOTE: deliberately excludes JOIN — `.join(...)` (string/array join) is
  // common enough in ordinary code that it swamped this signal in testing
  // (see below) for essentially no real SQL-detection benefit; multi-table
  // SQL joins are still caught via the FROM/WHERE that accompanies them.
  const SQL_CLAUSE_RE = /\b(FROM|WHERE|INTO|VALUES)\b/i;
  const STRING_BUILD_RE = /(\+\s*["'`]|["'`]\s*\+|\.append\(|\.concat\(|f["']|%s|\$\{)/;
  const SQL_WINDOW_SIZE = 6;

  // Real SQL string-building often spans a few lines (one line per clause,
  // joined with `+`, as in VIP-portal#698's fixture), so this can't require
  // verb+clause+build all on one line. But checking the whole hunk as one
  // blob was checked in calibration and matched constantly on unrelated
  // 100+ line hunks — e.g. Django admin test fixtures with `.join(`,
  // f-strings, and the English words "select"/"delete" nowhere near each
  // other. A small sliding window is the middle ground: real query
  // construction has verb/clause/concatenation close together; incidental
  // matches scattered across a large hunk mostly don't.
  function hasSqlShape(lines) {
    for (let start = 0; start < lines.length; start++) {
      const windowText = lines.slice(start, start + SQL_WINDOW_SIZE).join('\n');
      if (SQL_VERB_RE.test(windowText) && SQL_CLAUSE_RE.test(windowText) && STRING_BUILD_RE.test(windowText)) {
        return true;
      }
    }
    return false;
  }

  function detectSqlInjectionShape(removedLines, addedLines) {
    return hasSqlShape(removedLines) || hasSqlShape(addedLines);
  }

  // Curated for low collision with everyday code, based on real false
  // positives seen while calibrating against django/django#16012:
  //   - `admin` alone matches constantly in any django.contrib.admin file
  //     (that's the app's name, not a security signal there).
  //   - `auth\w*` (wildcard) matched "author" and "authorship".
  //   - bare `token`/`session`/`cookie` match tokenizers, ORM sessions,
  //     and unrelated state — too generic to be a useful signal alone.
  // So: no wildcards, no single common English words: only fairly
  // unambiguous security-specific terms/acronyms.
  const SECURITY_KEYWORDS_RE =
    /\b(password|passwd|secret|jwt|oauth|csrf|xsrf|cors|ssrf|xss|authenticat(?:e|es|ed|ing|ion)|authoriz(?:e|es|ed|ing|ation)|unauthorized|encrypt(?:s|ed|ing|ion)?|decrypt(?:s|ed|ing|ion)?|crypto|superuser|privileged?|sanitiz(?:e|es|ed|ing|ation)|content-security-policy|x-content-type-options|set-cookie)\b/i;

  function detectSecuritySensitive(removedLines, addedLines) {
    const joined = [...removedLines, ...addedLines].join('\n');
    return SECURITY_KEYWORDS_RE.test(joined);
  }

  const FUNCTION_DECL_RE =
    /\b(?:def|function|fn|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/;

  function extractSignatures(lines) {
    const sigs = new Map();
    for (const line of lines) {
      const m = FUNCTION_DECL_RE.exec(line);
      if (m) sigs.set(m[1], m[2].trim());
    }
    return sigs;
  }

  function detectSignatureChange(removedLines, addedLines) {
    const removedSigs = extractSignatures(removedLines);
    const addedSigs = extractSignatures(addedLines);
    for (const [name, oldParams] of removedSigs) {
      if (addedSigs.has(name) && addedSigs.get(name) !== oldParams) {
        return { name, oldParams, newParams: addedSigs.get(name) };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * @param {{filePath?: string, addedLines?: string[], removedLines?: string[]}} hunk
   * @returns {{level: 'low'|'medium'|'high', reason: string}}
   */
  function assessHunk(hunk) {
    const filePath = (hunk && hunk.filePath) || '';
    const addedLines = (hunk && hunk.addedLines) || [];
    const removedLines = (hunk && hunk.removedLines) || [];

    if (addedLines.length === 0 && removedLines.length === 0) {
      return { level: LEVELS.LOW, reason: 'No changes to assess.' };
    }

    if (detectGeneratedFile(filePath)) {
      return { level: LEVELS.LOW, reason: 'Lockfile/generated file — not worth a line-by-line review.' };
    }
    if (detectFormattingOnly(removedLines, addedLines)) {
      return { level: LEVELS.LOW, reason: 'Formatting-only change — no code semantics affected.' };
    }
    if (detectCommentOnly(removedLines, addedLines)) {
      return { level: LEVELS.LOW, reason: 'Only comments/docs changed.' };
    }
    if (detectPureRename(removedLines, addedLines)) {
      return {
        level: LEVELS.LOW,
        reason: 'Structurally identical to the removed code except for renamed identifier(s) — looks like a mechanical rename.',
      };
    }

    const candidates = [];

    if (detectSqlInjectionShape(removedLines, addedLines)) {
      candidates.push({
        severity: LEVELS.HIGH,
        reason:
          'Touches SQL query construction via string concatenation — check for injection risk and prefer parameterized queries.',
      });
    }

    const boundaryReason = detectBoundaryChange(removedLines, addedLines);
    if (boundaryReason) {
      candidates.push({ severity: LEVELS.HIGH, reason: boundaryReason });
    }

    if (detectRemovedErrorHandling(removedLines, addedLines)) {
      candidates.push({
        severity: LEVELS.HIGH,
        reason:
          'Removed exception handling (try/catch/except) — confirm the error path is truly unreachable.',
      });
    }

    if (detectSecuritySensitive(removedLines, addedLines)) {
      candidates.push({
        severity: LEVELS.HIGH,
        reason:
          'Touches security-sensitive code (auth/session/crypto/headers) — review carefully even if the change looks small.',
      });
    }

    const conditional = detectRemovedConditional(removedLines);
    if (conditional) {
      candidates.push(conditional);
    }

    const signatureChange = detectSignatureChange(removedLines, addedLines);
    if (signatureChange) {
      candidates.push({
        severity: LEVELS.MEDIUM,
        reason: `Function signature changed: ${signatureChange.name}(${signatureChange.oldParams}) → ${signatureChange.name}(${signatureChange.newParams}) — check all call sites still pass compatible arguments.`,
      });
    }

    if (candidates.length === 0) {
      const totalLines = addedLines.length + removedLines.length;
      if (totalLines > LARGE_HUNK_LINE_THRESHOLD) {
        candidates.push({
          severity: LEVELS.MEDIUM,
          reason: `Large hunk (${totalLines} lines changed) with no specific red flag — still worth a careful read.`,
        });
      }
    }

    if (candidates.length === 0) {
      return { level: LEVELS.LOW, reason: 'No strong risk signals detected in this hunk.' };
    }

    candidates.sort((a, b) => LEVEL_RANK[b.severity] - LEVEL_RANK[a.severity]);
    const top = candidates[0];
    return { level: top.severity, reason: top.reason };
  }

  return {
    LEVELS,
    assessHunk,
    // Exposed for unit testing individual detectors in isolation.
    _internal: {
      tokenize,
      lineSimilarity,
      pairLines,
      detectGeneratedFile,
      detectFormattingOnly,
      detectCommentOnly,
      detectPureRename,
      detectBoundaryChange,
      detectRemovedErrorHandling,
      detectRemovedConditional,
      detectSqlInjectionShape,
      detectSecuritySensitive,
      detectSignatureChange,
    },
  };
});
