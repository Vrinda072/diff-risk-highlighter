// Re-measures the memory-safety signal on the pull requests listed in
// memory-set.json: the engine with and without it. Development data, not the
// held-out set. Diffs are downloaded (with `gh`) into eval/cache/memory/ and
// checked against recorded hashes; third-party code isn't committed.
//
//   node eval/memory-signal.js

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { assessHunk } = require('../src/risk-engine.js');
const { parseDiff } = require('../test/helpers/parse-diff.js');

const CACHE = path.join(__dirname, 'cache', 'memory');
const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'memory-set.json'), 'utf8'));
const C_FILE = /\.(c|h|cc|cpp|cxx|hh|hpp|hxx|m|mm)$/i;

function diffOf(pr, changed) {
  const file = path.join(CACHE, `${pr.repo.replace('/', '__')}__${pr.number}.diff`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, execFileSync('gh', ['pr', 'diff', String(pr.number), '--repo', pr.repo], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 90_000 }));
  }
  const text = fs.readFileSync(file, 'utf8');
  if (crypto.createHash('sha256').update(text).digest('hex') !== pr.diffSha256) changed.push(`${pr.repo}#${pr.number}`);
  return parseDiff(text);
}

const isC = (h) => C_FILE.test(h.filePath);
const flagged = (h, disable) => assessHunk(h, { disable }).level !== 'low';
const share = (a, b) => `${a}/${b} (${Math.round((100 * a) / b)}%)`;

fs.mkdirSync(CACHE, { recursive: true });
const changed = [];
const lines = ['| Set | Hunks counted | Flagged without the signal | Flagged with it |', '|---|---|---|---|'];

for (const half of ['design', 'check']) {
  const prs = set.overflowFixes.filter((p) => p.half === half && p.fixHunks);
  const t = { fixes: 0, without: 0, with: 0 };
  for (const pr of prs) {
    diffOf(pr, changed).forEach((h, i) => {
      if (!pr.fixHunks.includes(i) || !isC(h) || /test/i.test(h.filePath)) return;
      t.fixes++;
      if (flagged(h, ['memory'])) t.without++;
      if (flagged(h, [])) t.with++;
    });
  }
  const label = half === 'design' ? 'Fix hunks, design half' : 'Fix hunks, unseen half';
  lines.push(`| ${label} (${prs.length} PRs) | ${t.fixes} | ${share(t.without, t.fixes)} | ${share(t.with, t.fixes)} |`);
}

const t = { hunks: 0, without: 0, with: 0 };
let prs = 0;
for (const pr of set.ordinary) {
  const hunks = diffOf(pr, changed).filter(isC);
  if (hunks.length) prs++;
  for (const h of hunks) {
    t.hunks++;
    if (flagged(h, ['memory'])) t.without++;
    if (flagged(h, [])) t.with++;
  }
}
lines.push(`| All hunks, ordinary C/C++ (${prs} PRs) | ${t.hunks} | ${share(t.without, t.hunks)} | ${share(t.with, t.hunks)} |`);

console.log(lines.join('\n'));
if (changed.length) {
  console.log(`\nWARNING: ${changed.length} diffs differ from the recorded hash: ${changed.join(', ')}`);
  process.exitCode = 1;
}
