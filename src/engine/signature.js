// Changed function signatures, compared parameter by parameter.
//
// Declarations are read from the lexer's tokens until their brackets close,
// so a parameter list wrapped over several lines is one declaration, and a
// comma or bracket inside a string, default value or generic type doesn't
// split it. Not a parser: only declarations introduced by def, function, fn
// or func, and only when the whole parameter list is among the changed lines.

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.signature = factory(parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (/** @type {typeof import('./language.js')} */ languageModule) {
  'use strict';

  const { languageOf, lex } = languageModule;

  const KEYWORDS = new Set(['def', 'function', 'fn', 'func']);
  const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override', 'final', 'const', 'mut', 'ref', 'out', 'in', 'inout', 'params', 'this']);
  // Languages where a parameter without a default must be passed.
  const DEFAULTS_MATTER = /^(py|pyi|rb|rs|go|swift|kt|php|scala)$/;
  const OPEN = new Set(['(', '[', '{']);
  const CLOSE = new Set([')', ']', '}']);

  /** @typedef {Driskh.Token & {at: number}} Token */
  /** @typedef {{name: string, source: string, key: string, fallback: string | null, props: string[] | null, keywordOnly?: boolean}} Parameter */
  /** @typedef {{name: string, params: Parameter[], source: string}} Declaration */

  /** Index just past the bracket matching tokens[i], or -1 if it never closes. */
  function skipGroup(/** @type {Token[]} */ tokens, /** @type {number} */ i) {
    const open = tokens[i].value;
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
    let depth = 0;
    for (; i < tokens.length; i++) {
      const v = tokens[i].value;
      if (v === open) depth++;
      else if (v === close) depth--;
      else if (close === '>' && v === '>>') depth -= 2;
      if (depth <= 0) return i + 1;
    }
    return -1;
  }

  // Splits a parameter list's tokens at its top-level commas. Angle brackets
  // count only after a name (`Map<K, V>`), not as comparisons in a default.
  function splitParameters(/** @type {Token[]} */ tokens) {
    /** @type {Token[][]} */
    const groups = [[]];
    let depth = 0;
    let angle = 0;
    let inDefault = false;
    tokens.forEach((t, i) => {
      const v = t.value;
      if (OPEN.has(v)) depth++;
      else if (CLOSE.has(v)) depth--;
      else if (!inDefault && v === '<' && i > 0 && tokens[i - 1].type === 'ident') angle++;
      else if (angle && v === '>') angle--;
      else if (angle && v === '>>') angle = Math.max(0, angle - 2);
      else if (v === '=' && !depth && !angle) inDefault = true;
      if (v === ',' && !depth && !angle) {
        groups.push([]);
        inDefault = false;
      } else {
        groups[groups.length - 1].push(t);
      }
    });
    return groups.filter((g) => g.length);
  }

  /** @returns {Parameter} */
  function toParameter(/** @type {Token[]} */ tokens, /** @type {string} */ text, /** @type {Driskh.Language} */ lang) {
    const slice = (/** @type {Token[]} */ part) =>
      part.length ? text.slice(part[0].at, part[part.length - 1].at + part[part.length - 1].value.length).replace(/\s+/g, ' ') : '';
    const normalized = (/** @type {Token} */ t) =>
      lang.sameQuotes && t.type === 'string' ? t.value.replace(/^"([^"'\\]*)"$/, "'$1'") : t.value;

    let depth = 0;
    let equals = -1;
    let colon = -1;
    tokens.forEach((t, i) => {
      if (OPEN.has(t.value) || t.value === '<') depth++;
      else if (CLOSE.has(t.value) || t.value === '>') depth--;
      else if (!depth && t.value === '=' && equals < 0) equals = i;
      else if (!depth && t.value === ':' && colon < 0 && equals < 0) colon = i;
    });
    const head = tokens.slice(0, equals < 0 ? tokens.length : equals);
    const names = (colon < 0 ? head : tokens.slice(0, colon)).filter((t) => t.type === 'ident' && !MODIFIERS.has(t.value));
    const dollar = head.find((t) => t.type === 'ident' && t.value.startsWith('$'));
    // "name: type" names it last before the colon; "name type" names it first.
    const named = dollar || (colon < 0 ? names[0] : names[names.length - 1]) || tokens.find((t) => t.type === 'ident');
    // `{ a, b }: Props` has no name of its own: its entries are what changes.
    const destructured = tokens[0].value === '{';
    const props = destructured
      ? splitParameters(tokens.slice(1, Math.max(1, skipGroup(tokens, 0) - 1))).map((g) => slice(g).replace(/\s*[:=][\s\S]*$/, ''))
      : null;
    // Trailing commas are layout.
    const meaningful = tokens.filter((t, i) => !(t.value === ',' && CLOSE.has(tokens[i + 1]?.value)));

    return {
      name: destructured ? '{props}' : named ? named.value : slice(tokens),
      source: slice(tokens),
      key: meaningful.map(normalized).join(' '),
      props,
      fallback: equals < 0 ? null : slice(tokens.slice(equals + 1)),
    };
  }

  /** @returns {Declaration[]} */
  function declarations(/** @type {string[]} */ lines, /** @type {Driskh.Language} */ lang) {
    const text = lines.join('\n');
    if (!/\b(def|function|fn|func)\b/.test(text)) return [];
    const tokens = /** @type {Token[]} */ (lex(text, lang)).filter((t) => t.type !== 'comment' && t.type !== 'newline');
    const found = [];
    for (let k = 0; k < tokens.length; k++) {
      if (!KEYWORDS.has(tokens[k].value)) continue;
      let i = k + 1;
      if (tokens[k].value === 'func' && tokens[i]?.value === '(') i = skipGroup(tokens, i); // Go receiver
      if (i < 0 || tokens[i]?.type !== 'ident') continue;
      let name = tokens[i++].value;
      while (tokens[i]?.value === '.' && tokens[i + 1]?.type === 'ident') {
        name = tokens[i + 1].value; // Ruby's def self.name
        i += 2;
      }
      if (tokens[i]?.value === '?' || tokens[i]?.value === '!') i++;
      if (tokens[i]?.value === '<' || tokens[i]?.value === '[') i = skipGroup(tokens, i); // generics
      if (i < 0 || tokens[i]?.value !== '(') continue;
      const end = skipGroup(tokens, i);
      if (end < 0) continue; // the list runs past the changed lines
      const inside = tokens.slice(i + 1, end - 1);
      const all = splitParameters(inside).map((g) => toParameter(g, text, lang));
      found.push({ name, params: withoutMarkers(all), source: all.map((p) => p.source).join(', ') });
    }
    return found;
  }

  // Python's bare `*` and `/` are markers, not parameters: everything after a
  // `*` can only be passed by name.
  function withoutMarkers(/** @type {Parameter[]} */ params) {
    let keywordOnly = false;
    return params.filter((p) => {
      if (p.source === '*') keywordOnly = true;
      if (p.source === '*' || p.source === '/') return false;
      p.keywordOnly = keywordOnly;
      return true;
    });
  }

  // What changed between two parameter lists, in a reviewer's words.
  function describeChanges(/** @type {Parameter[]} */ before, /** @type {Parameter[]} */ after, /** @type {Driskh.Language} */ lang) {
    const oldNames = new Map(before.map((p) => [p.name, p]));
    const newNames = new Map(after.map((p) => [p.name, p]));
    const added = after.filter((p) => !oldNames.has(p.name));
    const removed = before.filter((p) => !newNames.has(p.name));
    const changes = [];

    const renamed =
      added.length === 1 && removed.length === 1 && after.indexOf(added[0]) === before.indexOf(removed[0]);
    if (renamed) {
      const detail = removed[0].source === removed[0].name && added[0].source === added[0].name ? '' : ` (${removed[0].source} → ${added[0].source})`;
      changes.push(`renamed parameter ${removed[0].name} → ${added[0].name}${detail}`);
    } else {
      const lastKept = after.reduce((last, p, i) => (oldNames.has(p.name) ? i : last), -1);
      for (const p of added) {
        const notes = [];
        if (p.keywordOnly) notes.push('keyword-only');
        if (p.fallback !== null) notes.push('has a default');
        else if (DEFAULTS_MATTER.test(lang.ext)) notes.push('no default');
        if (!p.keywordOnly && after.indexOf(p) < lastKept) notes.push('ahead of existing ones, so positional arguments shift');
        changes.push(`added parameter ${p.name}${notes.length ? ` (${notes.join('; ')})` : ''}`);
      }
      for (const p of removed) changes.push(`removed parameter ${p.name}`);
    }

    const keptBefore = before.filter((p) => newNames.has(p.name)).map((p) => p.name);
    const keptAfter = after.filter((p) => oldNames.has(p.name)).map((p) => p.name);
    if (keptBefore.join() !== keptAfter.join()) changes.push(`reordered parameters (now ${keptAfter.join(', ')})`);

    for (const p of after) {
      const was = oldNames.get(p.name);
      if (!was) continue;
      if (p.keywordOnly && !was.keywordOnly) changes.push(`${p.name} is now keyword-only, so positional calls break`);
      if (was.key === p.key) continue;
      if (was.props && p.props) {
        const gained = p.props.filter((n) => !was.props?.includes(n));
        const lost = was.props.filter((n) => !p.props?.includes(n));
        if (gained.length) changes.push(`now takes ${gained.join(', ')}`);
        if (lost.length) changes.push(`no longer takes ${lost.join(', ')}`);
        if (!gained.length && !lost.length) changes.push('the types or defaults of its destructured props changed');
        continue;
      }
      if (was.fallback !== null && p.fallback === null) changes.push(`${p.name} lost its default (was ${was.fallback})`);
      else if (was.fallback === null && p.fallback !== null) changes.push(`${p.name} gained a default (${p.fallback})`);
      else if (was.fallback !== null && p.fallback !== null && was.fallback !== p.fallback) {
        changes.push(`default of ${p.name} changed (${was.fallback} → ${p.fallback})`);
      } else changes.push(`${was.source} → ${p.source}`);
    }
    return changes;
  }

  /**
   * The first function declared on both sides whose parameters differ.
   * @returns {{name: string, changes: string[], oldParams: string, newParams: string} | null}
   */
  function detectSignatureChange(
    /** @type {string[]} */ removedLines,
    /** @type {string[]} */ addedLines,
    /** @type {string} */ filePath
  ) {
    const lang = languageOf(filePath || '');
    const unmatched = declarations(addedLines, lang);
    if (!unmatched.length) return null;
    for (const old of declarations(removedLines, lang)) {
      // Same-named declarations (methods of different classes) pair in order.
      const at = unmatched.findIndex((d) => d.name === old.name);
      if (at < 0) continue;
      const [now] = unmatched.splice(at, 1);
      const changes = describeChanges(old.params, now.params, lang);
      if (changes.length) return { name: old.name, changes, oldParams: old.source, newParams: now.source };
    }
    return null;
  }

  return {
    detectSignatureChange,
  };
});
