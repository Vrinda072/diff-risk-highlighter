// Changed function signatures.

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.signature = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FUNCTION_DECL_RE =
    /\b(?:def|function|fn|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/;

  function extractSignatures(/** @type {string[]} */ lines) {
    const sigs = new Map();
    for (const line of lines) {
      const m = FUNCTION_DECL_RE.exec(line);
      if (m) sigs.set(m[1], m[2].trim());
    }
    return sigs;
  }

  function detectSignatureChange(/** @type {string[]} */ removedLines, /** @type {string[]} */ addedLines) {
    const removedSigs = extractSignatures(removedLines);
    const addedSigs = extractSignatures(addedLines);
    for (const [name, oldParams] of removedSigs) {
      if (addedSigs.has(name) && addedSigs.get(name) !== oldParams) {
        return { name, oldParams, newParams: addedSigs.get(name) };
      }
    }
    return null;
  }

  return {
    detectSignatureChange,
  };
});
