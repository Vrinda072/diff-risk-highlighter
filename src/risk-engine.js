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
    '::', '..', '++', '--', '+=', '-=', '*=', '/=', '**', '<<', '>>', '??', '?.',
    ':=', '<-', '|=', '&=', '^=', '%=',
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
  // A line's bigram profile is built once and reused for every comparison.
  function lineProfile(line) {
    const trimmed = line.trim();
    const grams = bigrams(trimmed);
    let total = 0;
    for (const count of grams.values()) total += count;
    return { trimmed, grams, total };
  }

  function profileSimilarity(a, b) {
    if (a.trimmed === b.trimmed) return 1;
    if (a.grams.size === 0 || b.grams.size === 0) return 0;
    let intersection = 0;
    for (const [bg, count] of a.grams) {
      const other = b.grams.get(bg);
      if (other) intersection += Math.min(count, other);
    }
    return (2 * intersection) / (a.total + b.total);
  }

  function lineSimilarity(a, b) {
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
  function exactMatches(removed, added) {
    const positions = new Map();
    added.forEach((line, i) => {
      if (!positions.has(line.trimmed)) positions.set(line.trimmed, []);
      positions.get(line.trimmed).push(i);
    });
    const cursor = new Map();
    return removed.map((line) => {
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
  function pairLines(removedLines, addedLines, threshold) {
    const removed = removedLines.map(lineProfile);
    const added = addedLines.map(lineProfile);
    const large = removed.length * added.length > MAX_EXHAUSTIVE_PAIRS;
    const exact = large ? exactMatches(removed, added) : null;
    const usedAdded = new Array(added.length).fill(false);
    if (large) exact.forEach((i) => i >= 0 && (usedAdded[i] = true));
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

  // Lockfiles and other machine-generated files are near-universally
  // skipped in code review (they're regenerated by tooling, not
  // hand-edited).
  const GENERATED_PATH_PATTERNS = [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/i,
    /(^|\/)(Cargo\.lock|Gemfile\.lock|poetry\.lock|pdm\.lock|uv\.lock|Pipfile\.lock|composer\.lock|flake\.lock|go\.sum|(Gopkg|glide)\.lock|\.terraform\.lock\.hcl)$/i,
    /\.min\.(js|css)$/i,
    /\.(js|css)\.map$/,
    /\.pb\.(go|cc|h)$|_pb2(_grpc)?\.pyi?$|_pb\.js$/, // protobuf codegen
    /\.designer\.(cs|vb)$/,
    /(^|\/)__generated__\//, // Relay/GraphQL codegen
    /(^|\/)(gradlew|mvnw)(\.bat|\.cmd)?$/,
    /\.generated\.\w+$/,
  ];

  // Third-party code checked into the repo — reviewed upstream, not here.
  const VENDORED_PATH_PATTERNS = [
    /(^|\/)(node_modules|bower_components|jspm_packages)\//,
    /(^|\/)[Vv]endor(ed)?\//,
    /(^|\/)(third[-_]?party|3rd[-_]?party)\//i,
    /(^|\/)Godeps\/_workspace\//,
    /(^|\/)(Pods|Carthage\/Build)\//,
    /(^|\/)\.yarn\/(releases|plugins|sdks|unplugged)\//,
  ];

  // Prose, not code. The well-known-filename rule is case-sensitive (as
  // in linguist) and only allows prose extensions, so real code that
  // happens to share a name — security.py, changes.py, news/views.py —
  // is still scanned as code.
  const DOCUMENTATION_PATH_PATTERNS = [
    /^[Dd]ocs?\//,
    /(^|\/)[Dd]ocumentation\//,
    /(^|\/)(CHANGE(S|LOG)?|HISTORY|NEWS|RELEASE[-_]?NOTES|CONTRIBUTING|CODE[-_]OF[-_]CONDUCT|SECURITY|AUTHORS|INSTALL|COPYING|LICEN[CS]E|README)(\.(txt|md|markdown|rst|adoc))?$/,
    /(^|\/)([Rr]eadme|[Ll]icen[cs]e|[Cc]hangelog)(\.txt)?$/,
    /\.(md|markdown|mdx|rst|adoc|asciidoc|org|rdoc|textile)$/i,
  ];

  const FILE_KINDS = { GENERATED: 'generated', VENDORED: 'vendored', DOCUMENTATION: 'documentation', CODE: 'code' };

  function classifyFile(filePath) {
    const p = filePath || '';
    if (GENERATED_PATH_PATTERNS.some((re) => re.test(p))) return FILE_KINDS.GENERATED;
    if (VENDORED_PATH_PATTERNS.some((re) => re.test(p))) return FILE_KINDS.VENDORED;
    if (DOCUMENTATION_PATH_PATTERNS.some((re) => re.test(p))) return FILE_KINDS.DOCUMENTATION;
    return FILE_KINDS.CODE;
  }

  function detectGeneratedFile(filePath) {
    return classifyFile(filePath) === FILE_KINDS.GENERATED;
  }

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
  // Package names such as `oauth2-server-bundle` aren't security-sensitive
  // code, so dependency manifests skip the keyword detector.
  const DEPENDENCY_MANIFEST_RE =
    /(^|\/)(package\.json|composer\.json|go\.mod|requirements[\w.-]*\.txt|Cargo\.toml|Gemfile|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?)$/i;
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

  // What counts is conditionals that disappeared on balance. Comparing only
  // "did a removed line start with `if`" flagged every edited, re-indented or
  // moved condition: 82% of these flags in a 94-PR audit were hunks that added
  // back at least as many conditionals as they removed.
  const countLines = (lines, re) => lines.reduce((n, l) => n + (re.test(l) ? 1 : 0), 0);

  // A condition's text with layout stripped, so re-wrapping isn't a "change".
  const conditionKey = (line) => line.replace(/[\s{}:]+/g, '').replace(/"/g, "'");

  function detectRemovedConditional(removedLines, addedLines) {
    const removed = removedLines.filter((l) => CONDITIONAL_RE.test(l));
    if (removed.length === 0) return null;
    const added = (addedLines || []).filter((l) => CONDITIONAL_RE.test(l));
    const net = removed.length - added.length;

    if (net > 0) {
      // Same severity rule as before for real removals; only edits are softened.
      const substantial = removed.length >= 3 || removedLines.some((l) => EXIT_KEYWORD_RE.test(l));
      return {
        severity: substantial ? LEVELS.HIGH : LEVELS.MEDIUM,
        reason:
          'Removed a conditional branch — confirm it was actually unreachable, not a behavior change.',
      };
    }

    const kept = new Set(added.map(conditionKey));
    if (removed.every((l) => kept.has(conditionKey(l)))) return null;
    return {
      severity: LEVELS.MEDIUM,
      reason: 'Changed a condition — check the new branch logic covers the same cases (or is meant not to).',
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
  // A query on changed lines is recognised two ways: a statement shape in any
  // case (SELECT ... FROM, INSERT INTO, UPDATE x SET, DELETE FROM), or an
  // UPPERCASE verb with an UPPERCASE clause, SQL's usual spelling. The second
  // matters because a diff often changes only some lines of a query: in
  // VIP-portal#698's fix the FROM line is unchanged context, leaving just
  // SELECT and WHERE. Lowercase English ("update", "from") no longer counts,
  // and import and comment lines are ignored: both fired constantly on
  // Python's `from x import y` next to `.update(` and an f-string.
  const SQL_STATEMENT_RE =
    /\bSELECT\b[\s\S]{0,300}?\bFROM\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bUPDATE\s+[\w."`\[\]]+\s+SET\b|\bDELETE\s+FROM\b/i;
  // NOTE: deliberately excludes JOIN — `.join(...)` is common in ordinary code.
  const SQL_UPPER_VERB_RE = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;
  const SQL_UPPER_CLAUSE_RE = /\b(FROM|WHERE|INTO|VALUES)\b/;
  const IMPORT_LINE_RE = /^\s*(import\b|from\s+[\w.]+\s+import\b|export\s+.*\bfrom\s+['"])/;
  const STRING_BUILD_RE = /(\+\s*["'`]|["'`]\s*\+|\.append\(|\.concat\(|f["']|%s|\$\{)/;
  const SQL_WINDOW_SIZE = 6;

  // Real SQL string-building often spans a few lines (one line per clause,
  // joined with `+`), so this can't require everything on one line. A small
  // sliding window is the middle ground: real query construction sits close
  // together; incidental matches scattered across a large hunk mostly don't.
  function hasSqlShape(lines, lang) {
    const code = lines.filter((l) => !IMPORT_LINE_RE.test(l) && !isCommentLine(l, lang));
    for (let start = 0; start < code.length; start++) {
      const windowText = code.slice(start, start + SQL_WINDOW_SIZE).join('\n');
      const looksLikeSql =
        SQL_STATEMENT_RE.test(windowText) || (SQL_UPPER_VERB_RE.test(windowText) && SQL_UPPER_CLAUSE_RE.test(windowText));
      if (looksLikeSql && STRING_BUILD_RE.test(windowText)) return true;
    }
    return false;
  }

  function detectSqlInjectionShape(removedLines, addedLines, filePath) {
    const lang = languageOf(filePath);
    return hasSqlShape(removedLines, lang) || hasSqlShape(addedLines, lang);
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
  //
  // Boundaries use letter-lookarounds rather than \b: \b treats `_` as a word
  // character, so `\bpassword\b` silently missed `verify_password` and
  // `user_password_hash` — most real identifiers. camelCase is split into words
  // first (`checkPassword` -> `check Password`) for the same reason.
  const SECURITY_KEYWORDS_RE =
    /(?<![A-Za-z])(passwords?|passwd|secrets?|jwt|oauth|csrf|xsrf|cors|ssrf|xss|authenticat(?:e|es|ed|ing|ion)|authoriz(?:e|es|ed|ing|ation)|unauthorized|encrypt(?:s|ed|ing|ion)?|decrypt(?:s|ed|ing|ion)?|crypto(?:graph(?:y|ic))?|superuser|privileged?|sanitiz(?:e|es|ed|ing|ation)|content-security-policy|x-content-type-options|set-cookie)(?![A-Za-z])/i;

  function detectSecuritySensitive(removedLines, addedLines) {
    const joined = [...removedLines, ...addedLines].join('\n').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return SECURITY_KEYWORDS_RE.test(joined);
  }

  // ---------------------------------------------------------------------
  // Test files: weakened or removed assertions. A test that stops checking
  // something passes more easily, so the PR looks green for the wrong
  // reason. Calibrated on weaviate#11801, goauthentik#13371 (assertions
  // deleted), google/jaxopt#642 (tolerance raised), elastic/apm-agent-
  // python#2636 (bound dropped), aws/aws-sdk-js-v3#8212 (exact string ->
  // regex). Medium, not high: loosening a flaky test is often the right
  // call — the point is that a reviewer should notice it happened.
  // ---------------------------------------------------------------------

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

  const SYNC_PRIMITIVE_RE =
    /\b(R?Lock|R?Unlock|lock|unlock|try_?lock|TryLock|mutex|Mutex|RWMutex|RwLock|ReentrantLock|synchronized|volatile|atomic(?:_\w+)?|Atomic\w+|lock_guard|unique_lock|scoped_lock|shared_lock|Semaphore|semaphore|withLock\w*|OSAllocatedUnfairLock|NSLock|LockGuarded|select_for_update|pthread_mutex_\w+)\b/g;
  const CONCURRENCY_CONTEXT_RE =
    /\b(thread\w*|Thread\w*|goroutine|go\s+func|async|await|concurrent\w*|Concurrent\w*|parallel\w*|executor|Executor\w*|ThreadPool\w*|worker\w*|multiprocessing|spawn|Task\.Run|DispatchQueue)\b/;
  const CHECK_THEN_ACT_PATTERNS = [
    // Python: if k not in c: ... c[k] = / c.add / c.append / c.setdefault
    { check: /\bif\s+(?:not\s+)?[\w.\[\]'"]+\s+(?:not\s+)?in\s+([\w.]+)\s*:/, act: (c) => new RegExp(`\\b${c}(\\[[^\\]]+\\]\\s*=[^=]|\\.(add|append|setdefault)\\()`) },
    // JS/TS/Java: if (!c.has(k)) / containsKey / contains ... c.set / put / add
    { check: /\bif\s*\(\s*!?\s*([\w.]+)\.(has|containsKey|contains)\(/, act: (c) => new RegExp(`\\b${c}\\.(set|put|add|putIfAbsent)\\(`) },
    // Go: if _, ok := c[k]; !ok { c[k] = v }
    { check: /\bif\s+_,\s*ok\s*:?=\s*([\w.]+)\[/, act: (c) => new RegExp(`\\b${c}\\[[^\\]]+\\]\\s*=[^=]`) },
  ];

  // For finding signals, a "// words" line is skipped in every language.
  const SLASH_PROSE_RE = /^\s*\/\/\s/;

  function codeOnly(lines, lang) {
    return lines.filter((l) => !isCommentLine(l, lang) && !SLASH_PROSE_RE.test(l)).map((l) => l.replace(STRING_LITERAL_RE, '""'));
  }

  // Lock *variables* are usually named for what they are (`_lock`,
  // `self._lock`, `cache_mutex`, `state_mu`), which \block\b can't see past
  // the underscore. Anchored on `_` or `with` so words like block/clock/
  // file_lock_path don't count.
  const LOCK_IDENTIFIER_RE = /(?:^|[^\w])[\w.]*_(?:r?lock|mutex|mu)\b|\bwith\s+[\w.]*[Ll]ock\b/g;

  function countSyncPrimitives(lines, lang) {
    return codeOnly(lines, lang).reduce(
      (n, l) => n + (l.match(SYNC_PRIMITIVE_RE) || []).length + (l.match(LOCK_IDENTIFIER_RE) || []).length,
      0
    );
  }

  function detectConcurrencyRisk(removedLines, addedLines, filePath) {
    const lang = languageOf(filePath);
    const removedSync = countSyncPrimitives(removedLines, lang);
    const addedSync = countSyncPrimitives(addedLines, lang);
    if (removedSync > addedSync) {
      return {
        severity: LEVELS.HIGH,
        reason: 'Removed synchronization (lock/atomic/synchronized) — confirm the shared state it protected is still safe to access concurrently.',
      };
    }

    // The fix side of the same coin: most real race fixes *add* locking or
    // atomicity (nuke, redisearch, spp, pdns fixtures). Medium, not high —
    // new synchronization is usually correct, but it changes what can
    // interleave, so a reviewer should confirm every access path takes it.
    if (addedSync > removedSync) {
      return {
        severity: LEVELS.MEDIUM,
        reason: 'Adds locking/atomicity — usually a concurrency fix; check what can now interleave and that every access path to the shared state takes the same lock.',
      };
    }

    const added = codeOnly(addedLines, lang);
    if (addedSync > 0 || !CONCURRENCY_CONTEXT_RE.test([...removedLines, ...addedLines].join('\n'))) return null;
    for (const { check, act } of CHECK_THEN_ACT_PATTERNS) {
      for (let i = 0; i < added.length; i++) {
        const m = added[i].match(check);
        if (!m) continue;
        const actRe = act(m[1].replace(/[.$]/g, '\\$&'));
        if (added.slice(i, i + 6).some((l) => actRe.test(l))) {
          return {
            severity: LEVELS.MEDIUM,
            reason: `New check-then-act on "${m[1]}" in concurrent code with no lock — another thread/task can change it between the check and the write.`,
          };
        }
      }
    }
    return null;
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

    const fileKind = classifyFile(filePath);
    if (fileKind === FILE_KINDS.GENERATED) {
      return { level: LEVELS.LOW, reason: 'Lockfile/generated file — not worth a line-by-line review.' };
    }
    if (fileKind === FILE_KINDS.VENDORED) {
      return { level: LEVELS.LOW, reason: 'Vendored third-party code — reviewed upstream, not line-by-line here.' };
    }
    // Prose describes code rather than being code: a CHANGELOG entry about
    // an "authorization fix" or a README line mentioning "binver = 1.0.1"
    // isn't a security change or an off-by-one. Confirmed against
    // stellar/passkey-kit#4, where CHANGELOG/README/docs hunks buried the
    // real fix's flags. Docs skip those two detectors and the large-hunk
    // fallback; the structural detectors below still run.
    const isDocumentation = fileKind === FILE_KINDS.DOCUMENTATION;
    const layout = compareLayout(removedLines, addedLines, filePath);
    if (layout === 'formatting') {
      return { level: LEVELS.LOW, reason: 'Formatting-only change — no code semantics affected.' };
    }
    if (layout === 'comments') {
      return { level: LEVELS.LOW, reason: 'Only comments and layout changed — the code itself is the same.' };
    }
    if (detectCommentOnly(removedLines, addedLines, filePath)) {
      return { level: LEVELS.LOW, reason: 'Only comments/docs changed.' };
    }
    const rename = describeRename(removedLines, addedLines, filePath);
    if (rename && rename.proven) {
      return {
        level: LEVELS.LOW,
        reason: 'Structurally identical to the removed code except for renamed identifier(s) — looks like a mechanical rename.',
      };
    }

    const candidates = [];

    if (detectSqlInjectionShape(removedLines, addedLines, filePath)) {
      candidates.push({
        severity: LEVELS.HIGH,
        reason:
          'Touches SQL query construction via string concatenation — check for injection risk and prefer parameterized queries.',
      });
    }

    const boundaryReason = isDocumentation ? null : detectBoundaryChange(removedLines, addedLines, filePath);
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

    // In a test file a security keyword is only a medium nudge, and it must
    // not outrank a more specific finding at the same level (e.g. "skipped
    // test"), so that candidate is pushed after detectWeakenedTest below.
    const securityHit =
      !isDocumentation && !DEPENDENCY_MANIFEST_RE.test(filePath) && detectSecuritySensitive(removedLines, addedLines);
    const securityInTest = securityHit && isTestFile(filePath);
    if (securityHit && !securityInTest) {
      candidates.push({
        severity: LEVELS.HIGH,
        reason:
          'Touches security-sensitive code (auth/session/crypto/headers) — review carefully even if the change looks small.',
      });
    }

    // With only names swapped, every branch keeps its shape.
    const conditional = rename ? null : detectRemovedConditional(removedLines, addedLines);
    if (conditional) {
      candidates.push(conditional);
    }

    const concurrencyRisk = isDocumentation ? null : detectConcurrencyRisk(removedLines, addedLines, filePath);
    if (concurrencyRisk) {
      candidates.push(concurrencyRisk);
    }

    const weakenedTest = detectWeakenedTest(filePath, removedLines, addedLines);
    if (weakenedTest) {
      candidates.push({ severity: LEVELS.MEDIUM, reason: weakenedTest });
    }

    if (securityInTest) {
      candidates.push({
        severity: LEVELS.MEDIUM,
        reason: 'A test touching security-related behavior — check no assertion was weakened or removed.',
      });
    }

    const signatureChange = detectSignatureChange(removedLines, addedLines);
    if (signatureChange) {
      candidates.push({
        severity: LEVELS.MEDIUM,
        reason: `Function signature changed: ${signatureChange.name}(${signatureChange.oldParams}) → ${signatureChange.name}(${signatureChange.newParams}) — check all call sites still pass compatible arguments.`,
      });
    }

    // A long hunk of *code* with no specific red flag is still worth a
    // careful read; a long hunk of prose isn't a risk in itself.
    if (candidates.length === 0 && !isDocumentation && !rename) {
      const totalLines = addedLines.length + removedLines.length;
      if (totalLines > LARGE_HUNK_LINE_THRESHOLD) {
        candidates.push({
          severity: LEVELS.MEDIUM,
          reason: `Large hunk (${totalLines} lines changed) with no specific red flag — still worth a careful read.`,
        });
      }
    }

    if (candidates.length === 0) {
      if (rename) {
        const shown = rename.renames.slice(0, 2).map(([from, to]) => `${from} → ${to}`).join(', ');
        const more = rename.renames.length > 2 ? ', …' : '';
        return {
          level: LEVELS.LOW,
          reason: `Only names changed (${shown}${more}) — no other signal; check it is a rename and not a different variable or call.`,
        };
      }
      return { level: LEVELS.LOW, reason: 'No strong risk signals detected in this hunk.' };
    }

    candidates.sort((a, b) => LEVEL_RANK[b.severity] - LEVEL_RANK[a.severity]);
    const top = candidates[0];
    return { level: top.severity, reason: top.reason };
  }

  return {
    LEVELS,
    FILE_KINDS,
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
