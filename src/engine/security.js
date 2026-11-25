// SQL built from strings, and security-sensitive keywords.

(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.security = factory(parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (/** @type {typeof import('./language.js')} */ languageModule) {
  'use strict';

  const { isCommentLine, languageOf } = languageModule;

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
  function hasSqlShape(/** @type {string[]} */ lines, /** @type {Driskh.Language} */ lang) {
    const code = lines.filter((/** @type {string} */ l) => !IMPORT_LINE_RE.test(l) && !isCommentLine(l, lang));
    for (let start = 0; start < code.length; start++) {
      const windowText = code.slice(start, start + SQL_WINDOW_SIZE).join('\n');
      const looksLikeSql =
        SQL_STATEMENT_RE.test(windowText) || (SQL_UPPER_VERB_RE.test(windowText) && SQL_UPPER_CLAUSE_RE.test(windowText));
      if (looksLikeSql && STRING_BUILD_RE.test(windowText)) return true;
    }
    return false;
  }

  function detectSqlInjectionShape(/** @type {string[]} */ removedLines, /** @type {string[]} */ addedLines, /** @type {string} */ filePath) {
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

  function detectSecuritySensitive(/** @type {string[]} */ removedLines, /** @type {string[]} */ addedLines) {
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

  // Package names such as `oauth2-server-bundle` aren't security-sensitive
  // code, so dependency manifests skip the keyword detector.
  const DEPENDENCY_MANIFEST_RE =
    /(^|\/)(package\.json|composer\.json|go\.mod|requirements[\w.-]*\.txt|Cargo\.toml|Gemfile|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?)$/i;

  return {
    DEPENDENCY_MANIFEST_RE,
    detectSecuritySensitive,
    detectSqlInjectionShape,
  };
});
