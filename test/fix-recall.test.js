// Ratchet over every fixture in test/fixtures/real-prs: how many of the hunks
// that metadata.json names as "the real fix" does the engine flag (non-low),
// and how many hunks that are NOT the fix (and not a documented expected
// flag) does it flag high. The floors/ceilings below are the current
// numbers — raise/lower them deliberately in the same PR as a heuristic
// change, never to make a failing run pass.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assessHunk } = require('../src/risk-engine.js');
const { parseDiff } = require('./helpers/parse-diff.js');

const DIR = path.join(__dirname, 'fixtures', 'real-prs');
const metadata = JSON.parse(fs.readFileSync(path.join(DIR, 'metadata.json'), 'utf8'));
const newStart = (header) => Number(header.match(/\+(\d+)/)[1]);

function score(entry) {
  const hunks = parseDiff(fs.readFileSync(path.join(DIR, entry.fixture), 'utf8'));
  const is = (list, h) => (list || []).some((f) => f.file === h.filePath && newStart(f.header) === h.newStart);
  let fixes = 0, fixesFlagged = 0, noiseHigh = 0;
  for (const h of hunks) {
    const { level } = assessHunk(h);
    if (is(entry.fixHunks, h)) {
      fixes++;
      if (level !== 'low') fixesFlagged++;
    } else if (!is(entry.expectedFlags, h) && level === 'high') {
      noiseHigh++;
    }
  }
  return { fixes, fixesFlagged, noiseHigh };
}

describe('fix recall / noise ratchet over all fixtures', () => {
  const byFixture = Object.fromEntries(metadata.map((m) => [m.fixture, score(m)]));
  const total = Object.values(byFixture).reduce(
    (t, s) => ({ fixes: t.fixes + s.fixes, flagged: t.flagged + s.fixesFlagged, noiseHigh: t.noiseHigh + s.noiseHigh }),
    { fixes: 0, flagged: 0, noiseHigh: 0 }
  );

  it('flags at least 68 of the 84 real-fix hunks', () => {
    assert.ok(total.flagged >= 68, `flagged ${total.flagged}/${total.fixes}`);
  });

  it('keeps high-risk noise (non-fix hunks flagged high) at or below 6', () => {
    assert.ok(total.noiseHigh <= 6, `${total.noiseHigh} non-fix hunks flagged high`);
  });

  // The two fixtures the original 17-PR review found the engine blind to.
  it('catches the authorization fixes that snake_case/camelCase identifiers used to hide (orchard)', () => {
    const s = byFixture['orchard_missingauthz.diff'];
    assert.equal(s.fixesFlagged, s.fixes);
  });

  it('catches race fixes that ADD locking (spp, pdns)', () => {
    assert.equal(byFixture['spp_race.diff'].fixesFlagged, byFixture['spp_race.diff'].fixes);
    assert.ok(byFixture['pdns_race.diff'].fixesFlagged >= 10);
  });

  it('adds no high-risk noise to the security-focused passkey-kit PR', () => {
    assert.equal(byFixture['passkey_authbypass.diff'].noiseHigh, 0);
    assert.equal(byFixture['passkey_authbypass.diff'].fixesFlagged, byFixture['passkey_authbypass.diff'].fixes);
  });
});
