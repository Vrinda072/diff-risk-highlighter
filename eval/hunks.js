// One list of hunks per diff, in the order GitHub shows them: the engine's
// input (added/removed lines) plus the raw text a human labels. Built on the
// same parser the tests use so both always agree on hunk numbering.

const { parseDiff } = require('../test/helpers/parse-diff.js');

function rawHunks(diffText) {
  const out = [];
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) current = null;
    else if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      out.push(current);
    } else if (current && /^[ +\-\\]/.test(line)) current.lines.push(line);
  }
  return out;
}

function hunksOf(diffText) {
  const parsed = parseDiff(diffText);
  const raw = rawHunks(diffText);
  if (parsed.length !== raw.length) throw new Error(`hunk count mismatch: ${parsed.length} vs ${raw.length}`);
  return parsed.map((h, i) => ({ ...h, index: i, header: raw[i].header, text: raw[i].lines.join('\n') }));
}

module.exports = { hunksOf };
