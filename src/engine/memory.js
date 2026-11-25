// Memory-safety shapes in C-family code: raw copy and allocation calls,
// fixed-size buffers and bounds checks. Medium only: touching these is not
// proof of a bug, but it is where overflows are made and fixed (CWE-787,
// CWE-125, CWE-190). Calibrated on half of 40 merged overflow fixes and
// checked on the other half: node eval/memory-signal.js.

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.memory = factory(parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (/** @type {typeof import('./language.js')} */ languageModule) {
  'use strict';

  const { languageOf, isCommentLine } = languageModule;

  const C_FAMILY_RE = /\.(c|h|cc|cpp|cxx|hh|hpp|hxx|m|mm)$/i;

  const MEMORY_CALL_RE =
    /\b(memcpy|memmove|memset|bzero|strcpy|strncpy|strlcpy|stpcpy|strcat|strncat|strlcat|sprintf|vsprintf|snprintf|vsnprintf|gets|sscanf|[kvg]?malloc|[kv]?[cz]alloc|g_new0?|[kvg]?realloc|reallocarray|alloca|strn?dup)\s*\(/;

  // `char name[SIZE]`: a type word, a name, a non-empty size.
  const BUFFER_RE =
    /^\s*(?:static\s+|const\s+|unsigned\s+|signed\s+|volatile\s+)*(?:char|u?int(?:8|16|32|64)?_t|int|short|long|float|double|wchar_t|BYTE|byte|u8|u16|u32)\b[\s*]+([A-Za-z_]\w*)\s*\[([^\]]+)\]/;

  // A comparison against something that reads like a size or a limit.
  const CHECK_RE = /\b(if|while|for|assert|ASSERT\w*|CHECK\w*)\b[\s\S]*(<=?|>=?)/;
  const LIMIT_RE =
    /\bsizeof\b|\b(SIZE|SSIZE|INT|UINT|LONG)\w*_MAX\b|(\.|->)\s*(size|length|capacity)\s*(\(\s*\))?|\b\w*(len|Len|LEN|length|Length|size|Size|SIZE|capacity|Capacity|remaining)\w*\b|\b(end|limit|bound)\b|_(MAX|LEN|SIZE)\b/;
  // `->`, `<<`, `>>` and template brackets are not comparisons.
  const NOT_COMPARISON_RE = /->|<<=?|>>=?|\b[A-Za-z_][\w:]*<[\w:\s,*&<>]*>/g;

  const squash = (/** @type {string} */ line) => line.replace(/\s+/g, '');

  /** @returns {string | null} what a reviewer should check */
  function detectMemoryRisk(
    /** @type {string} */ filePath,
    /** @type {string[]} */ removedLines,
    /** @type {string[]} */ addedLines
  ) {
    if (!C_FAMILY_RE.test(filePath || '')) return null;
    const lang = languageOf(filePath);
    const code = (/** @type {string[]} */ lines) => lines.filter((l) => !isCommentLine(l, lang));
    const removed = code(removedLines);
    const added = code(addedLines);
    // Lines that only moved or were re-indented aren't changes.
    const before = new Set(removed.map(squash));
    const after = new Set(added.map(squash));
    const gone = removed.filter((l) => !after.has(squash(l)));
    const fresh = added.filter((l) => !before.has(squash(l)));

    const call = [...fresh, ...gone].map((l) => MEMORY_CALL_RE.exec(l)).find(Boolean);
    if (call) {
      return `Changes a raw memory or string call (${call[1]}) — check the size argument and that the destination is large enough.`;
    }

    // Same name and size on both sides means only its contents changed.
    const declared = (/** @type {string} */ line) => {
      const m = BUFFER_RE.exec(line);
      return m ? `${m[1]}[${squash(m[2])}]` : '';
    };
    const sizes = new Set(fresh.map(declared));
    for (const line of gone) {
      const buffer = BUFFER_RE.exec(line);
      if (buffer && !sizes.has(declared(line))) {
        return `Changes the fixed-size buffer "${buffer[1]}" — check every write into it still fits.`;
      }
    }

    const check = fresh.find((l) => {
      const bare = l.replace(NOT_COMPARISON_RE, ' ');
      return CHECK_RE.test(bare) && LIMIT_RE.test(l);
    });
    if (check) {
      return 'Adds or changes a bounds check — confirm the limit is right and that every path to the access goes through it.';
    }
    return null;
  }

  return {
    detectMemoryRisk,
  };
});
