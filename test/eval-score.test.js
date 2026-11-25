// End to end through eval/score.js on a throwaway "held-out set" built from a
// development fixture, so the pipeline is tested without ever touching the
// sealed set.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('../eval/score.js');
const { hunksOf } = require('../eval/hunks.js');
const engine = require('../src/risk-engine.js');

describe('eval/score.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-score-'));
  const diff = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-prs', 'vip_sqli.diff'), 'utf8');
  const hunks = hunksOf(diff);
  const fixIndex = hunks.findIndex((h) => engine.assessHunk(h).level === 'high');
  const manifest = {
    sealedOn: '2000-01-01',
    baselineTag: 'unused-here',
    pullRequests: [{ id: 'dev__x__1', hunks: hunks.length, diffSha256: crypto.createHash('sha256').update(diff).digest('hex') }],
  };
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  write('dev__x__1.diff', diff);
  const manifestFile = write('manifest.json', manifest);
  const labels = (done) => write(`labels-${done}.json`, { labels: { dev__x__1: { kind: 'bugfix', fix: [fixIndex], review: [], done } } });
  const options = { manifestFile, cacheDir: dir, k: 1, engines: { current: engine } };

  it('reports the reading-order table and warns that a tiny run is pilot-sized', () => {
    const text = run({ ...options, labelFile: labels(true) });
    assert.match(text, /\| Extension \(severity\) \| 100% \| 100%/);
    assert.match(text, /\| Random \|/);
    assert.match(text, /Pilot-sized: 1 PRs/);
    assert.match(text, /Fix hunks flagged \(medium or high\): 100%/);
  });

  it('refuses to produce numbers when nothing is marked done', () => {
    assert.throws(() => run({ ...options, labelFile: labels(false) }), /marked "done"/);
  });

  it('refuses a cached diff that no longer matches the sealed hash', () => {
    const labelFile = labels(true);
    write('dev__x__1.diff', diff + '\n+tampered');
    assert.throws(() => run({ ...options, labelFile }), /sealed hash/);
    write('dev__x__1.diff', diff);
  });
});
