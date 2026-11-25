// Off-by-one shapes: boundary operators, shifted literals, added or removed 1.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'), require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.boundary = factory(parts.text, parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (textModule, languageModule) {
  'use strict';

  const { BOUNDARY_PAIR_SIMILARITY, STRING_LITERAL_RE, pairLines, tokenize } = textModule;
  const { isCommentLine, languageOf } = languageModule;

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

  // A version bump ("0.16.2" -> "0.16.3") is a numeric literal shifting by
  // one on an otherwise identical line — exactly the off-by-one shape —
  // but it's release bookkeeping, not a boundary. Confirmed against
  // stellar/passkey-kit#4, where four version bumps were flagged high.
  // Version literals are masked out before lines are compared, so a bump
  // makes the pair identical while any *other* edit on the line is still
  // seen:
  //   - anywhere: semver-shaped literals, 3+ dotted numeric parts
  //     (1.2.3, v2.0.0-rc.1). Real code almost never has those that
  //     aren't versions; two-part numbers (0.5, 1.2) are left alone
  //     since they're ordinary floats.
  //   - in package manifests: any quoted version-shaped value, including
  //     two-part ones and ranges ("1.0", "^18.2", ">=3.8"), which covers
  //     `version` fields and dependency pins alike.
  const SEMVER_LITERAL_RE = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g;
  const PACKAGE_MANIFEST_RE = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml)$/;
  const QUOTED_VERSION_RE = /(["'])[\^~<>=!\s]*v?\d+(?:\.(?:\d+|[xX*]))*(?:[-+][0-9A-Za-z.-]+)?\1/g;
  const ACTION_REF_RE = /@v\d+(?:\.\d+)*\b/g;
  const WILDCARD_VERSION_RE = /(["'])\d+(?:\.\d+)*\.[*xX]\1/g;

  const VERSION_MASK = 'VERSION_LITERAL';

  function maskVersionLiterals(line, filePath) {
    let masked = line
      .replace(SEMVER_LITERAL_RE, VERSION_MASK)
      // `uses: actions/checkout@v3` -> `@v4`, and quoted wildcards such as
      // '6.4.*' -> '7.4.*', are version bumps wherever they appear.
      .replace(ACTION_REF_RE, '@' + VERSION_MASK)
      .replace(WILDCARD_VERSION_RE, `$1${VERSION_MASK}$1`);
    if (PACKAGE_MANIFEST_RE.test(filePath || '')) {
      masked = masked.replace(QUOTED_VERSION_RE, `$1${VERSION_MASK}$1`);
    }
    return masked;
  }

  const BOUND_IDENT_RE = /(idx|index|len|length|size|count|end|start|begin|first|last|max|min|limit|bound|offset|pos|upper|lower|stop|range|capacity|slice)/i;
  const BOUND_SYNTAX_RE = /\[|<=?|>=?|\.\./;

  function looksLikeBoundExpression(tokens) {
    return tokens.some((t) => (t.type === 'ident' && BOUND_IDENT_RE.test(t.value)) || (t.type === 'other' && BOUND_SYNTAX_RE.test(t.value)));
  }

  // If `longer` is `shorter` with exactly one `+ 1` / `- 1` token pair
  // inserted, returns that pair as a string ("+ 1" / "- 1"), else null.
  function insertedUnitStep(shorter, longer) {
    if (longer.length !== shorter.length + 2) return null;
    let p = 0;
    while (p < shorter.length && shorter[p].value === longer[p].value) p++;
    const [op, one] = [longer[p], longer[p + 1]];
    if (!op || !one || (op.value !== '+' && op.value !== '-') || one.value !== '1') return null;
    for (let i = p; i < shorter.length; i++) {
      if (shorter[i].value !== longer[i + 2].value) return null;
    }
    return `${op.value} 1`;
  }

  function detectAddedUnitStep(removed, added, lang) {
    if (isCommentLine(removed, lang) || isCommentLine(added, lang)) return null;
    const rTokens = tokenize(removed.replace(STRING_LITERAL_RE, '""'));
    const aTokens = tokenize(added.replace(STRING_LITERAL_RE, '""'));
    const addedStep = insertedUnitStep(rTokens, aTokens);
    if (addedStep && looksLikeBoundExpression(aTokens)) {
      return `Added "${addedStep}" to an index/bound expression on an otherwise unchanged line — off-by-one shape.`;
    }
    const removedStep = insertedUnitStep(aTokens, rTokens);
    if (removedStep && looksLikeBoundExpression(rTokens)) {
      return `Removed "${removedStep}" from an index/bound expression on an otherwise unchanged line — off-by-one shape.`;
    }
    return null;
  }

  // Finds a hunk where one line was edited into an almost-identical line
  // that differs in exactly one token, and that token is a comparison /
  // range operator or an off-by-one-shaped integer literal change.
  // Modeled directly on alacritty#9027 (`..` -> `..=` in a range bound).
  // Also catches the added/removed `± 1` shape (detectAddedUnitStep).
  function detectBoundaryChange(removedLines, addedLines, filePath) {
    const pairs = pairLines(
      removedLines.map((l) => maskVersionLiterals(l, filePath)),
      addedLines.map((l) => maskVersionLiterals(l, filePath)),
      BOUNDARY_PAIR_SIMILARITY
    );
    for (const { removed, added } of pairs) {
      if (removed.trim() === added.trim()) continue;

      const unitStep = detectAddedUnitStep(removed, added, languageOf(filePath));
      if (unitStep) return unitStep;

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

  return {
    detectBoundaryChange,
    maskVersionLiterals,
  };
});
