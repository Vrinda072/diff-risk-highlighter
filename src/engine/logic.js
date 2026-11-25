// Removed error handling and removed or changed conditions.

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.logic = factory(parts.text);
  }
})(typeof self !== 'undefined' ? self : this, function (/** @type {typeof import('./text.js')} */ textModule) {
  'use strict';

  const { LEVELS } = textModule;

  const ERROR_HANDLING_RE = /\b(try|catch|except|finally|rescue)\b/g;

  function countMatches(/** @type {string[]} */ lines, /** @type {RegExp} */ re) {
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
  function detectRemovedErrorHandling(/** @type {string[]} */ removedLines, /** @type {string[]} */ addedLines) {
    return countMatches(removedLines, ERROR_HANDLING_RE) > countMatches(addedLines, ERROR_HANDLING_RE);
  }

  const CONDITIONAL_RE = /^[\s})]*\b(if|else if|elif|else|switch|case|match)\b/;
  const EXIT_KEYWORD_RE = /\b(return|raise|throw)\b/;

  // What counts is conditionals that disappeared on balance. Comparing only
  // "did a removed line start with `if`" flagged every edited, re-indented or
  // moved condition: 82% of these flags in a 94-PR audit were hunks that added
  // back at least as many conditionals as they removed.
  const countLines = (/** @type {string[]} */ lines, /** @type {RegExp} */ re) => lines.reduce((/** @type {number} */ n, /** @type {string} */ l) => n + (re.test(l) ? 1 : 0), 0);

  // A condition's text with layout stripped, so re-wrapping isn't a "change".
  const conditionKey = (/** @type {string} */ line) => line.replace(/[\s{}:]+/g, '').replace(/"/g, "'");

  function detectRemovedConditional(/** @type {string[]} */ removedLines, /** @type {string[]} */ addedLines) {
    const removed = removedLines.filter((/** @type {string} */ l) => CONDITIONAL_RE.test(l));
    if (removed.length === 0) return null;
    const added = (addedLines || []).filter((/** @type {string} */ l) => CONDITIONAL_RE.test(l));
    const net = removed.length - added.length;

    if (net > 0) {
      // Same severity rule as before for real removals; only edits are softened.
      const substantial = removed.length >= 3 || removedLines.some((/** @type {string} */ l) => EXIT_KEYWORD_RE.test(l));
      return {
        severity: substantial ? LEVELS.HIGH : LEVELS.MEDIUM,
        reason:
          'Removed a conditional branch — confirm it was actually unreachable, not a behavior change.',
      };
    }

    const kept = new Set(added.map(conditionKey));
    if (removed.every((/** @type {string} */ l) => kept.has(conditionKey(l)))) return null;
    return {
      severity: LEVELS.MEDIUM,
      reason: 'Changed a condition — check the new branch logic covers the same cases (or is meant not to).',
    };
  }

  return {
    detectRemovedConditional,
    detectRemovedErrorHandling,
  };
});
