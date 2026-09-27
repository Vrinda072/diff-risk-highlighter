// Keeps test/fixtures/real-prs/metadata.json honest: every fixture diff has
// exactly one metadata entry and vice versa, every category is a known one,
// and every hunk listed as "the real fix" actually exists in its diff. Says
// nothing about how the engine scores them — see the fixtures README.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CATEGORIES, hunkHeaders } = require('../scripts/fetch-fixtures.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'real-prs');
const metadata = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'metadata.json'), 'utf8'));
const NO_FIX_CATEGORIES = new Set(['refactor', 'feature', 'dependency-bump']);

describe('real-PR fixture metadata', () => {
  it('has exactly one entry per fixture diff', () => {
    const diffs = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.diff')).sort();
    const entries = metadata.map((m) => m.fixture).sort();
    assert.deepEqual(entries, [...new Set(entries)], 'duplicate metadata entries');
    assert.deepEqual(entries, diffs);
  });

  for (const m of metadata) {
    it(`${m.fixture}: valid category and fix hunks`, () => {
      assert.ok(CATEGORIES[m.category], `unknown category "${m.category}"`);
      assert.match(m.url, new RegExp(`^https://github\\.com/${m.repo}/pull/${m.number}$`));

      if (NO_FIX_CATEGORIES.has(m.category)) {
        assert.deepEqual(m.fixHunks, [], `${m.category} fixtures have no fix hunk`);
      } else {
        assert.ok(m.fixHunks.length > 0, `${m.category} fixtures must name their fix hunk(s)`);
      }

      const headers = hunkHeaders(fs.readFileSync(path.join(FIXTURES_DIR, m.fixture), 'utf8'));
      for (const hunk of [...m.fixHunks, ...(m.expectedFlags || [])]) {
        assert.ok(
          headers.some((h) => h.file === hunk.file && h.header === hunk.header),
          `hunk ${hunk.file} ${hunk.header} not in ${m.fixture}`
        );
      }
      for (const flag of m.expectedFlags || []) {
        assert.ok(flag.why, `expectedFlags entry ${flag.file} ${flag.header} needs a "why"`);
        assert.ok(
          !m.fixHunks.some((f) => f.file === flag.file && f.header === flag.header),
          `${flag.file} ${flag.header} is listed as both a fix hunk and an expected flag`
        );
      }
    });
  }
});
