// Per-language facts: comments, layout rules and a small lexer.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.language = factory(parts.text);
  }
})(typeof self !== 'undefined' ? self : this, function (textModule) {
  'use strict';

  const { MULTI_CHAR_OPERATORS } = textModule;

  const extensions = (list) => new Set(list.split(' '));
  // Whitespace between tokens and most line breaks don't matter.
  const FREE_LAYOUT = extensions('js jsx mjs cjs ts tsx mts cts java c h cc cpp cxx hh hpp hxx m mm cs go rs swift kt kts scala dart proto groovy gradle php zig sol json sql');
  // Spacing or line breaks can matter, but leading indentation doesn't.
  const LINE_LAYOUT = extensions('rb rake sh bash zsh fish pl pm r ps1 ex exs css scss less html htm xml svg vue svelte tf cmake dockerfile lua md markdown mdx rst txt');
  // "x" and 'x' are the same string.
  const SAME_QUOTES = extensions('js jsx mjs cjs ts tsx mts cts py pyi');
  const C_COMMENTS = extensions('js jsx mjs cjs ts tsx mts cts java c h cc cpp cxx hh hpp hxx m mm cs go rs swift kt kts scala dart proto groovy gradle php zig sol scss less vue svelte json');
  const HASH_COMMENTS = extensions('py pyi rb rake sh bash zsh fish pl pm r ps1 ex exs yml yaml toml tf cmake dockerfile makefile mk nim coffee gd php ini cfg conf properties env gitignore');
  const DASH_COMMENTS = extensions('sql lua hs elm ada');
  const MARKUP_COMMENTS = extensions('html htm xml svg vue svelte md markdown mdx');

  function extensionOf(filePath) {
    const name = (filePath || '').split('/').pop().toLowerCase();
    if (name === 'dockerfile' || name === 'makefile') return name;
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1);
  }

  function languageOf(filePath) {
    const ext = extensionOf(filePath);
    let layout = 'indented'; // unknown languages: assume indentation and spacing matter
    if (ext === 'py' || ext === 'pyi') layout = 'python';
    else if (FREE_LAYOUT.has(ext)) layout = 'free';
    else if (LINE_LAYOUT.has(ext)) layout = 'lines';
    const known = C_COMMENTS.has(ext) || HASH_COMMENTS.has(ext) || DASH_COMMENTS.has(ext) || MARKUP_COMMENTS.has(ext) || ext === 'css';
    return {
      ext,
      layout,
      sameQuotes: SAME_QUOTES.has(ext),
      slash: C_COMMENTS.has(ext) || !known,
      block: C_COMMENTS.has(ext) || ext === 'css' || !known,
      hash: HASH_COMMENTS.has(ext),
      dash: DASH_COMMENTS.has(ext),
      markup: MARKUP_COMMENTS.has(ext) || !known,
      unknown: !known,
    };
  }

  // Is this whole line a comment? When unsure the answer is no: calling code
  // a comment hides a change, while the reverse only costs a closer look.
  function isCommentLine(line, lang) {
    const t = line.trim();
    if (t === '') return false;
    // Comment-shaped lines that the toolchain executes.
    if (/^(#!|\/\/go:|\/\/\s*\+build)/.test(t)) return false;
    if (lang.slash && t.startsWith('//')) return true;
    if (lang.block) {
      const opens = t.startsWith('/*');
      // " * continued text" inside a block comment, but not `*ptr = 0;` or `* {`.
      // In a stylesheet `* { ... }` is also the universal selector.
      const selector = /^(css|scss|less)$/.test(lang.ext) && t.includes('{');
      const continues = t === '*' || t.startsWith('*/') || (/^\*\s/.test(t) && !/[;{]$/.test(t) && !selector);
      if (opens || continues) {
        const close = t.lastIndexOf('*/');
        if (close === -1) return true;
        const rest = t.slice(close + 2).trim();
        return rest === '' || rest.startsWith('//');
      }
    }
    if (lang.hash && t.startsWith('#') && !(lang.ext === 'php' && t.startsWith('#['))) return true;
    if (lang.unknown && /^#(\s|$)/.test(t)) return true;
    if (lang.dash && t.startsWith('--')) return true;
    if (lang.markup && t.startsWith('<!--')) return true;
    if (lang.layout === 'python' && (t.startsWith('"' + '""') || t.startsWith("'''"))) return true;
    return false;
  }

  // A small lexer for comparing two versions of a hunk. Strings are single
  // tokens kept verbatim. Anything it can't close (a string cut off by the
  // hunk boundary) is also kept verbatim to the end of its line, so unclear
  // input never compares as equal by accident.
  const lexerCache = new Map();

  function lexerFor(lang) {
    if (lexerCache.has(lang.ext)) return lexerCache.get(lang.ext);
    const parts = [];
    const add = (type, source) => parts.push(`(?<${type}>${source})`);
    const comments = [];
    if (lang.block) comments.push(String.raw`\/\*[\s\S]*?\*\/`);
    if (lang.slash) comments.push(String.raw`(?<=^|[\s;{}(),])\/\/[^\n]*`);
    if (lang.layout === 'python') comments.push(String.raw`#[^\n]*`);
    else if (lang.hash) comments.push(String.raw`(?<=^|\s)#(?!\[)[^\n]*`);
    if (lang.dash) comments.push(String.raw`--[^\n]*`);
    if (comments.length) add('comment', comments.join('|'));
    const strings = [];
    if (lang.layout === 'python') strings.push(String.raw`""` + String.raw`"[\s\S]*?""` + '"', String.raw`'''[\s\S]*?'''`, '(?:""' + '"|\'\'\')[^\\n]*');
    if (/^[cm]?[jt]sx?$/.test(lang.ext)) {
      // A regex literal, so a quote inside it doesn't open a "string".
      strings.push(String.raw`(?<=[(=,:!&|?;{\[]\s*)\/(?![\/*\s])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\/\\\n\[])+\/[a-z]*`);
    }
    strings.push(String.raw`"(?:[^"\\\n]|\\[\s\S])*"`, String.raw`'(?:[^'\\\n]|\\[\s\S])*'`, '`(?:[^`\\\\]|\\\\[\\s\\S])*`', '["\'`][^\\n]*');
    add('string', strings.join('|'));
    add('newline', String.raw`\n`);
    add('ident', String.raw`[A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*`);
    add('number', String.raw`\d[\w.]*`);
    add('other', MULTI_CHAR_OPERATORS.map((op) => op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + String.raw`|\S`);
    const lexer = { re: new RegExp(parts.join('|'), 'gm'), types: parts.map((part) => part.slice(3, part.indexOf('>'))) };
    lexerCache.set(lang.ext, lexer);
    return lexer;
  }

  function lex(text, lang) {
    const { re, types } = lexerFor(lang);
    re.lastIndex = 0;
    const tokens = [];
    let line = 0;
    let m;
    while ((m = re.exec(text))) {
      const value = m[0];
      let type;
      for (let i = 0; i < types.length && type === undefined; i++) {
        if (m.groups[types[i]] !== undefined) type = types[i];
      }
      tokens.push({ type, value, line });
      for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) line++;
    }
    return tokens;
  }

  // ---------------------------------------------------------------------
  // Safe-transform detectors: hunks that can be shown to keep behavior from
  // the changed lines alone. They short-circuit to LOW before any other
  // check runs, so each one has to say "no" whenever it isn't sure.
  // ---------------------------------------------------------------------

  return {
    isCommentLine,
    languageOf,
    lex,
  };
});
