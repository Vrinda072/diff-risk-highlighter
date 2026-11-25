// The three checks that can call a hunk harmless: formatting, comments, rename.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'), require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.shortcuts = factory(parts.text, parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (textModule, languageModule) {
  'use strict';

  const { isKeyword } = textModule;
  const { isCommentLine, languageOf, lex } = languageModule;

  const OPENERS = { ')': '(', ']': '[', '}': '{' };

  // Drops cosmetic trailing commas (see passcore#150 fixture). `(x,)` is
  // kept unless it is a call: in Python and Rust that comma makes a tuple.
  function dropTrailingCommas(tokens) {
    const code = tokens.filter((t) => t.type !== 'comment' && t.type !== 'newline');
    const drop = new Set();
    const stack = [];
    code.forEach((token, i) => {
      const v = token.value;
      if (v === '(' || v === '[' || v === '{') {
        stack.push({ open: v, at: i, commas: 0 });
      } else if (v === ',') {
        if (stack.length) stack[stack.length - 1].commas++;
        if (code[i + 1] && OPENERS[code[i + 1].value] && code[i + 1].value !== ')') drop.add(token);
      } else if (OPENERS[v]) {
        const group = stack.pop();
        const previous = code[i - 1];
        if (v !== ')' || !previous || previous.value !== ',') return;
        const before = group && code[group.at - 1];
        const isCall = before && (before.type === 'ident' || before.value === ')' || before.value === ']');
        if (!group || group.commas > 1 || isCall) drop.add(previous);
      }
    });
    return tokens.filter((t) => !drop.has(t));
  }

  function normalizeQuotes(value) {
    const m = /^"([^"'$`\\\n]*)"$/.exec(value);
    return m ? `'${m[1]}'` : value;
  }

  // A line break right after these ends the statement in JavaScript and
  // friends, so `return value` and `return` / `value` differ.
  const ENDS_STATEMENT = new Set(['return', 'break', 'continue', 'throw', 'yield']);

  // What the code means (as far as layout goes) and what its comments say.
  function layoutSignature(lines, lang) {
    if (lang.layout === 'lines' || lang.layout === 'indented') {
      const kept = lines.map((l) => (lang.layout === 'lines' ? l.trim() : l.trimEnd())).filter((l) => l.trim() !== '');
      return { code: kept.join('\n'), comments: '' };
    }

    const tokens = dropTrailingCommas(lex(lines.join('\n'), lang));
    const comments = tokens
      .filter((t) => t.type === 'comment')
      .map((t) => t.value.replace(/^(\/\/+|\/\*+|#+|--+)|\*+\/$/g, '').replace(/^\s*\*+(?=\s|$)/gm, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = (t) => (lang.sameQuotes && t.type === 'string' ? normalizeQuotes(t.value) : t.value);
    const code = [];

    if (lang.layout === 'python') {
      // Indentation of every logical line (breaks inside brackets don't count).
      let depth = 0;
      let startOfLine = true;
      let previous = null;
      for (const t of tokens) {
        if (t.type === 'comment') continue;
        if (t.type === 'newline') {
          if (depth === 0 && previous !== '\\') startOfLine = true;
          continue;
        }
        if (startOfLine) {
          code.push('\n' + lines[t.line].match(/^\s*/)[0] + '|');
          startOfLine = false;
        }
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
        else if (OPENERS[t.value]) depth = Math.max(0, depth - 1);
        previous = t.value;
        if (t.value !== '\\') code.push(text(t));
      }
    } else {
      tokens.forEach((t, i) => {
        if (t.type === 'comment' || t.type === 'newline') return;
        code.push(text(t));
        const next = tokens[i + 1];
        if (ENDS_STATEMENT.has(t.value) && (!next || next.type === 'newline' || next.type === 'comment')) code.push('<end>');
      });
    }
    return { code: code.join('\u0000'), comments };
  }

  // 'formatting': only layout differs. 'comments': the code is the same but
  // comment text changed too. null: anything else.
  function compareLayout(removedLines, addedLines, filePath) {
    if (removedLines.length === 0 || addedLines.length === 0) return null;
    const lang = languageOf(filePath);
    const before = layoutSignature(removedLines, lang);
    const after = layoutSignature(addedLines, lang);
    if (before.code === '' || before.code !== after.code) return null;
    return before.comments === after.comments ? 'formatting' : 'comments';
  }

  function detectFormattingOnly(removedLines, addedLines, filePath) {
    return compareLayout(removedLines, addedLines, filePath) === 'formatting';
  }

  // ---------------------------------------------------------------------
  // File classification: path-only rules adapted from github-linguist
  // (lib/linguist/generated.rb, vendor.yml, documentation.yml), which is
  // what GitHub itself uses to decide which files are generated, vendored
  // or documentation. Adapted, not copied wholesale:
  //   - generated.rb also sniffs file *contents* (e.g. "Code generated ...
  //     DO NOT EDIT" headers); a hunk only carries a few lines from the
  //     middle of a file, so only its path-based rules are used here.
  //   - vendor.yml's long tail of individual library filenames (jquery,
  //     bootstrap, ...) is left out; the directory conventions cover the
  //     cases that show up in PR review.
  //   - documentation.yml's examples/ demos/ samples/ directories are left
  //     out: linguist excludes them from language stats, but they hold
  //     runnable code, and the point here is to stop scanning *prose*.
  //   - Prose extensions (*.md, *.rst, ...) come from linguist's "prose"
  //     language type rather than documentation.yml, which only matches
  //     paths. Bare *.txt isn't included (requirements.txt,
  //     CMakeLists.txt, ...), except under a docs directory.
  // ---------------------------------------------------------------------

  function detectCommentOnly(removedLines, addedLines, filePath) {
    const lang = languageOf(filePath);
    const all = [...removedLines, ...addedLines].filter((l) => l.trim() !== '');
    if (all.length === 0) return false;
    return all.every((l) => isCommentLine(l, lang));
  }

  const DECLARED_NAME_RE =
    /(?:\b(?:def|class|function|fn|func|struct|enum|trait|interface|type|const|let|var|val|record|module)\s+(?:mut\s+|\*\s*)?|\bfunc\s+\([^)]*\)\s*)([A-Za-z_$][\w$]*)/g;
  // Python module constant: `RAISE = Raise()` at column 0.
  const PY_CONSTANT_RE = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/;

  // The names a line defines, as opposed to merely uses.
  function declaredNames(line, lang) {
    const names = new Set(Array.from(line.matchAll(DECLARED_NAME_RE), (m) => m[1]));
    const constant = lang.layout === 'python' && PY_CONSTANT_RE.exec(line);
    if (constant) names.add(constant[1]);
    return names;
  }

  // If every difference is one identifier consistently swapped for another,
  // returns the swaps. `proven` means each swapped name is also declared on
  // a changed line, so it is a rename. A swap only at places that *use* a
  // name looks the same as calling something else (`canRead` -> `canWrite`),
  // which no reading of the hunk alone can rule out.
  function describeRename(removedLines, addedLines, filePath) {
    if (removedLines.length === 0 || removedLines.length !== addedLines.length) return null;
    const lang = languageOf(filePath);
    const mapping = new Map();
    const reverseMapping = new Map();
    const unchanged = new Set();
    const strings = [];

    // A rename keeps line order, so the nth removed line pairs with the nth added.
    for (let line = 0; line < removedLines.length; line++) {
      const removed = removedLines[line];
      const added = addedLines[line];
      if ((lang.layout === 'python' || lang.layout === 'indented') && removed.match(/^\s*/)[0] !== added.match(/^\s*/)[0]) {
        return null;
      }
      const code = (l) => lex(l, lang).filter((t) => t.type !== 'comment');
      const rTokens = code(removed);
      const aTokens = code(added);
      if (rTokens.length !== aTokens.length) return null;

      for (let i = 0; i < rTokens.length; i++) {
        const rt = rTokens[i];
        const at = aTokens[i];
        if (rt.type !== at.type) return null;
        if (rt.value === at.value) {
          if (rt.type === 'ident') unchanged.add(rt.value);
          continue;
        }
        if (rt.type === 'string') {
          strings.push([rt.value.slice(1, -1), at.value.slice(1, -1)]);
          continue;
        }
        if (rt.type !== 'ident') return null; // punctuation/operator/number changed -> real edit
        if (isKeyword(rt.value) || isKeyword(at.value)) return null;
        if (mapping.has(rt.value) && mapping.get(rt.value) !== at.value) return null;
        if (reverseMapping.has(at.value) && reverseMapping.get(at.value) !== rt.value) return null;
        mapping.set(rt.value, at.value);
        reverseMapping.set(at.value, rt.value);
      }
    }

    if (mapping.size === 0) return null;
    // A name kept in one place and swapped in another isn't a rename.
    for (const [from, to] of mapping) {
      if (unchanged.has(from) || unchanged.has(to)) return null;
    }
    // A string may only change if it spells out a renamed name ("RAISE").
    if (!strings.every(([from, to]) => mapping.get(from) === to)) return null;

    const renames = [...mapping];
    const declared = removedLines.map((l, i) => [declaredNames(l, lang), declaredNames(addedLines[i], lang)]);
    const proven = renames.every(([from, to]) => declared.some(([before, after]) => before.has(from) && after.has(to)));
    return { proven, renames };
  }

  function detectPureRename(removedLines, addedLines, filePath) {
    const rename = describeRename(removedLines, addedLines, filePath);
    return Boolean(rename && rename.proven);
  }

  // ---------------------------------------------------------------------

  return {
    compareLayout,
    describeRename,
    detectCommentOnly,
    detectFormattingOnly,
    detectPureRename,
  };
});
