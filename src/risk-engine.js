// Diff Risk Highlighter — risk detection engine
//
// Pure, DOM-free scoring: given one hunk's added and removed lines and its
// file path, returns a risk level and a one-line reason a reviewer can act
// on. No parsing/AST — deliberately regex and token heuristics (see README
// "Known Limitations").
//
// This file decides; src/engine/ detects. Order of work for one hunk:
//   1. generated and vendored files are low
//   2. the three "harmless" shortcuts (src/engine/shortcuts.js)
//   3. every detector in DETECTORS; the highest severity wins, and the
//      earlier entry wins a tie
//   4. with no finding, a long hunk of code is still medium
//
// Calibrated against real merged PRs (see test/fixtures/), not invented
// examples — most notably:
//   - psf/requests#4052, django/django#21696  -> signature-change / rename
//   - VIP-portal#698, deltablot/partage#8     -> SQL injection / XSS
//   - django#18925, pandas#66045, numpy#32143 -> "dead code" branch removal
//   - alacritty#9027                          -> a 1-line off-by-one
//   - passcore#150                            -> pure reformatting
//
// No build step: manifest.json lists the files in dependency order, each
// adds itself to a shared global, and Node tests simply require() them.

/**
 * @typedef {{
 *   text: typeof import('./engine/text.js'),
 *   files: typeof import('./engine/files.js'),
 *   shortcuts: typeof import('./engine/shortcuts.js'),
 *   boundary: typeof import('./engine/boundary.js'),
 *   logic: typeof import('./engine/logic.js'),
 *   security: typeof import('./engine/security.js'),
 *   tests: typeof import('./engine/tests.js'),
 *   concurrency: typeof import('./engine/concurrency.js'),
 *   signature: typeof import('./engine/signature.js'),
 * }} DriskhEngineParts
 */

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      text: require('./engine/text.js'),
      files: require('./engine/files.js'),
      shortcuts: require('./engine/shortcuts.js'),
      boundary: require('./engine/boundary.js'),
      logic: require('./engine/logic.js'),
      security: require('./engine/security.js'),
      tests: require('./engine/tests.js'),
      concurrency: require('./engine/concurrency.js'),
      signature: require('./engine/signature.js'),
    });
  } else {
    root.DiffRiskEngine = factory(root.DriskhParts);
  }
})(typeof self !== 'undefined' ? self : this, function (/** @type {DriskhEngineParts} */ parts) {
  'use strict';

  const { LEVELS, LEVEL_RANK, tokenize, lineSimilarity, pairLines } = parts.text;
  const { FILE_KINDS, classifyFile, detectGeneratedFile } = parts.files;
  const { compareLayout, describeRename, detectCommentOnly, detectFormattingOnly, detectPureRename } = parts.shortcuts;
  const { detectBoundaryChange, maskVersionLiterals } = parts.boundary;
  const { detectRemovedConditional, detectRemovedErrorHandling } = parts.logic;
  const { DEPENDENCY_MANIFEST_RE, detectSecuritySensitive, detectSqlInjectionShape } = parts.security;
  const { detectWeakenedTest, isTestFile } = parts.tests;
  const { detectConcurrencyRisk } = parts.concurrency;
  const { detectSignatureChange } = parts.signature;

  const LARGE_HUNK_LINE_THRESHOLD = 40;

  const finding = (/** @type {Driskh.Level} */ severity, /** @type {string} */ reason) => ({ severity, reason });

  const securityApplies = (/** @type {Driskh.HunkContext} */ h) =>
    !h.isDocumentation &&
    !DEPENDENCY_MANIFEST_RE.test(h.filePath) &&
    detectSecuritySensitive(h.removedLines, h.addedLines);

  // One entry per signal. `id` is what eval/ablation.js switches off.
  const DETECTORS = [
    {
      id: 'sql',
      run: (/** @type {Driskh.HunkContext} */ h) =>
        detectSqlInjectionShape(h.removedLines, h.addedLines, h.filePath)
          ? finding(LEVELS.HIGH, 'Touches SQL query construction via string concatenation — check for injection risk and prefer parameterized queries.')
          : null,
    },
    {
      id: 'boundary',
      run: (/** @type {Driskh.HunkContext} */ h) => {
        const reason = h.isDocumentation ? null : detectBoundaryChange(h.removedLines, h.addedLines, h.filePath);
        return reason ? finding(LEVELS.HIGH, reason) : null;
      },
    },
    {
      id: 'error-handling',
      run: (/** @type {Driskh.HunkContext} */ h) =>
        detectRemovedErrorHandling(h.removedLines, h.addedLines)
          ? finding(LEVELS.HIGH, 'Removed exception handling (try/catch/except) — confirm the error path is truly unreachable.')
          : null,
    },
    {
      id: 'security',
      run: (/** @type {Driskh.HunkContext} */ h) =>
        !isTestFile(h.filePath) && securityApplies(h)
          ? finding(LEVELS.HIGH, 'Touches security-sensitive code (auth/session/crypto/headers) — review carefully even if the change looks small.')
          : null,
    },
    {
      id: 'condition',
      // With only names swapped, every branch keeps its shape.
      run: (/** @type {Driskh.HunkContext} */ h) => (h.rename ? null : detectRemovedConditional(h.removedLines, h.addedLines)),
    },
    {
      id: 'concurrency',
      run: (/** @type {Driskh.HunkContext} */ h) => (h.isDocumentation ? null : detectConcurrencyRisk(h.removedLines, h.addedLines, h.filePath)),
    },
    {
      id: 'weakened-test',
      run: (/** @type {Driskh.HunkContext} */ h) => {
        const reason = detectWeakenedTest(h.filePath, h.removedLines, h.addedLines);
        return reason ? finding(LEVELS.MEDIUM, reason) : null;
      },
    },
    {
      // Only a medium nudge in a test, listed after the more specific finding
      // above so that "a test was skipped" wins the tie.
      id: 'security-in-test',
      run: (/** @type {Driskh.HunkContext} */ h) =>
        isTestFile(h.filePath) && securityApplies(h)
          ? finding(LEVELS.MEDIUM, 'A test touching security-related behavior — check no assertion was weakened or removed.')
          : null,
    },
    {
      id: 'signature',
      run: (/** @type {Driskh.HunkContext} */ h) => {
        const change = detectSignatureChange(h.removedLines, h.addedLines);
        return change
          ? finding(LEVELS.MEDIUM, `Function signature changed: ${change.name}(${change.oldParams}) → ${change.name}(${change.newParams}) — check all call sites still pass compatible arguments.`)
          : null;
      },
    },
  ];

  const SHORTCUT_IDS = ['generated', 'vendored', 'formatting', 'comments', 'rename'];
  const DETECTOR_IDS = DETECTORS.map((d) => d.id).concat('large-hunk');

  const low = (/** @type {string} */ reason) => ({ level: LEVELS.LOW, reason });

  /**
   * @param {{filePath?: string, addedLines?: string[], removedLines?: string[]}} hunk
   * @param {{disable?: string[]}} [options] shortcut or detector ids to skip,
   *   used to measure what each one contributes
   * @returns {{level: 'low'|'medium'|'high', reason: string}}
   */
  function assessHunk(hunk, options) {
    const filePath = (hunk && hunk.filePath) || '';
    const addedLines = (hunk && hunk.addedLines) || [];
    const removedLines = (hunk && hunk.removedLines) || [];
    const off = new Set((options && options.disable) || []);

    if (addedLines.length === 0 && removedLines.length === 0) return low('No changes to assess.');

    const fileKind = classifyFile(filePath);
    if (fileKind === FILE_KINDS.GENERATED && !off.has('generated')) {
      return low('Lockfile/generated file — not worth a line-by-line review.');
    }
    if (fileKind === FILE_KINDS.VENDORED && !off.has('vendored')) {
      return low('Vendored third-party code — reviewed upstream, not line-by-line here.');
    }
    // Prose describes code rather than being code: a CHANGELOG entry about
    // an "authorization fix" or a README line mentioning "binver = 1.0.1"
    // isn't a security change or an off-by-one. Confirmed against
    // stellar/passkey-kit#4, where CHANGELOG/README/docs hunks buried the
    // real fix's flags. Docs skip those two detectors and the large-hunk
    // fallback; the structural detectors still run.
    const isDocumentation = fileKind === FILE_KINDS.DOCUMENTATION;

    const layout = compareLayout(removedLines, addedLines, filePath);
    if (layout === 'formatting' && !off.has('formatting')) {
      return low('Formatting-only change — no code semantics affected.');
    }
    if (!off.has('comments')) {
      if (layout === 'comments') return low('Only comments and layout changed — the code itself is the same.');
      if (detectCommentOnly(removedLines, addedLines, filePath)) return low('Only comments/docs changed.');
    }
    const rename = describeRename(removedLines, addedLines, filePath);
    if (rename && rename.proven && !off.has('rename')) {
      return low('Structurally identical to the removed code except for renamed identifier(s) — looks like a mechanical rename.');
    }

    const context = { filePath, addedLines, removedLines, isDocumentation, rename };
    const candidates = [];
    for (const detector of DETECTORS) {
      if (off.has(detector.id)) continue;
      const result = detector.run(context);
      if (result) candidates.push(result);
    }

    // A long hunk of *code* with no specific red flag is still worth a
    // careful read; a long hunk of prose isn't a risk in itself.
    if (candidates.length === 0 && !isDocumentation && !rename && !off.has('large-hunk')) {
      const totalLines = addedLines.length + removedLines.length;
      if (totalLines > LARGE_HUNK_LINE_THRESHOLD) {
        candidates.push(finding(LEVELS.MEDIUM, `Large hunk (${totalLines} lines changed) with no specific red flag — still worth a careful read.`));
      }
    }

    if (candidates.length === 0) {
      if (rename) {
        const shown = rename.renames.slice(0, 2).map(([from, to]) => `${from} → ${to}`).join(', ');
        const more = rename.renames.length > 2 ? ', …' : '';
        return low(`Only names changed (${shown}${more}) — no other signal; check it is a rename and not a different variable or call.`);
      }
      return low('No strong risk signals detected in this hunk.');
    }

    candidates.sort((a, b) => LEVEL_RANK[b.severity] - LEVEL_RANK[a.severity]);
    const top = candidates[0];
    return { level: top.severity, reason: top.reason };
  }

  return {
    LEVELS,
    FILE_KINDS,
    DETECTOR_IDS,
    SHORTCUT_IDS,
    assessHunk,
    classifyFile,
    // Exposed for unit testing individual detectors in isolation.
    _internal: {
      tokenize,
      maskVersionLiterals,
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
