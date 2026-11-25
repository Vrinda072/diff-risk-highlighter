// The memory-safety signal for C-family code. How well it does on real
// overflow fixes is measured by `node eval/memory-signal.js`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessHunk } = require('../src/risk-engine.js');

const check = (filePath, removedLines, addedLines) => assessHunk({ filePath, removedLines, addedLines });

describe('memory-safety shapes', () => {
  const flagged = [
    ['an unbounded copy made bounded (dlukt/eq2emu)', 'db.cpp', ['  strcpy(host, val);'], ['  strlcpy(host, val, bufSize);'], /raw memory or string call/],
    ['a resized fixed buffer (FRRouting/frr)', 'map.c', ['  char as[10];'], ['  char as[ASN_STRING_MAX_SIZE];'], /fixed-size buffer "as"/],
    ['a new index check (zortos293/Lichii)', 'keys.cpp', [], ['  if (index >= keyblobs.size()) {', '    continue;', '  }'], /bounds check/],
    ['a length check before a table write (xbmc)', 'cc.c', [], ['  if (dec->textlen >= (int)sizeof(dec->text) - 4)', '    break;'], /bounds check/],
  ];
  for (const [name, file, removed, added, reason] of flagged) {
    it(`flags ${name}`, () => {
      const result = check(file, removed, added);
      assert.equal(result.level, 'medium');
      assert.match(result.reason, reason);
    });
  }

  const quiet = [
    ['the same shapes outside C and C++', 'a.js', ['  memcpy(a, b, n);'], ['  memcpy(a, b, m);']],
    ['a line that only moved', 'a.c', ['  memcpy(dst, src, n);', '  count++;'], ['  count++;', '    memcpy(dst, src, n);']],
    ['an array whose contents changed but not its size', 'a.c', ['  static const char *names[3] = {"a", "b", "c"};'], ['  static const char *names[3] = {"a", "x", "c"};']],
    ['member access and templates that only look like comparisons', 'a.cpp', [], ['  if (node->size) use(std::vector<size_t>{});']],
    ['a check mentioned in a comment', 'a.c', [], ['  // if (len > sizeof(buf)) would be wrong here', '  done = 1;']],
  ];
  for (const [name, file, removed, added] of quiet) {
    it(`ignores ${name}`, () => assert.doesNotMatch(check(file, removed, added).reason, /memory|buffer|bounds check/i));
  }
});
