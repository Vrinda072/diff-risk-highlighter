// Removed or added synchronization, and check-then-act.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./text.js'), require('./language.js'));
  } else {
    const parts = root.DriskhParts || (root.DriskhParts = {});
    parts.concurrency = factory(parts.text, parts.language);
  }
})(typeof self !== 'undefined' ? self : this, function (textModule, languageModule) {
  'use strict';

  const { LEVELS, STRING_LITERAL_RE } = textModule;
  const { isCommentLine, languageOf } = languageModule;

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

  return {
    detectConcurrencyRisk,
  };
});
