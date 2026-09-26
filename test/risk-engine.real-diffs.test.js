// Calibration / regression pass against real merged PRs (test/fixtures/real-prs).
// Unlike risk-engine.unit.test.js (one heuristic at a time, hand-picked
// lines), this feeds the engine whole real hunks exactly as a unified diff
// produced them — messy formatting, mixed concerns, multiple files per PR —
// and checks that the overall classification lands where a human reviewer
// would expect for the clear-cut cases. Ambiguous/large PRs are only
// smoke-tested (must not throw, must return a valid level) rather than
// asserted line-by-line, since "correct" triage of a 1600-line feature PR
// isn't a single objectively right answer.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assessHunk } = require('../src/risk-engine.js');
const { parseDiff } = require('./helpers/parse-diff.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'real-prs');

function loadHunks(filename) {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf8');
  return parseDiff(text).map((hunk) => ({ ...hunk, ...assessHunk(hunk) }));
}

describe('real PR: VIP-portal#698 (SQL injection fix)', () => {
  it('flags the query-building hunk as high risk, mentioning SQL', () => {
    const hunks = loadHunks('vip_sqli.diff');
    const flagged = hunks.filter((h) => h.level === 'high' && /sql/i.test(h.reason));
    assert.ok(flagged.length >= 1, `expected at least one high-risk SQL hunk, got: ${JSON.stringify(hunks.map((h) => h.level))}`);
  });
});

describe('real PR: partage#8 (XSS fix)', () => {
  it('flags the security-header hunk as high risk', () => {
    const hunks = loadHunks('partage_xss.diff');
    const flagged = hunks.filter((h) => h.level === 'high');
    assert.ok(flagged.length >= 1, `expected at least one high-risk hunk, got: ${JSON.stringify(hunks.map((h) => h.level))}`);
  });
});

describe('real PR: django#18925 (dead try/except removal)', () => {
  it('flags the removed try/except as at least medium risk', () => {
    const hunks = loadHunks('django_deadcode.diff');
    const validatorHunks = hunks.filter((h) => h.filePath.includes('validators.py'));
    assert.ok(validatorHunks.length > 0, 'expected to find validators.py hunks');
    const flagged = validatorHunks.filter((h) => h.level !== 'low');
    assert.ok(
      flagged.length >= 1,
      `expected at least one non-low validators.py hunk, got: ${JSON.stringify(validatorHunks.map((h) => [h.level, h.reason]))}`
    );
  });
});

describe('real PR: numpy#32143 (confirmed-dead branch removal)', () => {
  it('flags the removed if-branch as at least medium risk', () => {
    const hunks = loadHunks('numpy_unreachable.diff');
    const dtypeHunks = hunks.filter((h) => h.filePath.includes('_dtype.py'));
    assert.ok(dtypeHunks.length > 0);
    assert.ok(dtypeHunks.some((h) => h.level !== 'low'));
  });
});

describe('real PR: django#21696 (mechanical rename across 15 files)', () => {
  it('classifies most hunks as low risk (a rename storm should not read as universally dangerous)', () => {
    const hunks = loadHunks('django_rename.diff');
    const lowCount = hunks.filter((h) => h.level === 'low').length;
    const ratio = lowCount / hunks.length;
    assert.ok(
      ratio >= 0.6,
      `expected >=60% of rename-PR hunks to be low risk, got ${lowCount}/${hunks.length} (${JSON.stringify(hunks.map((h) => h.level))})`
    );
  });
});

describe('real PR: passcore#150 (pure Prettier reformat)', () => {
  it('classifies most hunks as low risk despite the diff being large', () => {
    const hunks = loadHunks('passcore_prettier.diff');
    const lowCount = hunks.filter((h) => h.level === 'low').length;
    const ratio = lowCount / hunks.length;
    assert.ok(
      ratio >= 0.5,
      `expected >=50% of pure-reformat hunks to be low risk, got ${lowCount}/${hunks.length}`
    );
  });

  it('REGRESSION: does not call a merely re-indented try/catch a removal of error handling', () => {
    // Caught during calibration: a try/catch/finally block got re-wrapped
    // across more lines (not removed), which made the naive "does
    // removedLines mention try/catch" check fire even though addedLines
    // still had the exact same handling. Fixed by comparing keyword counts
    // on both sides instead of just checking removedLines.
    const hunks = loadHunks('passcore_prettier.diff');
    const changePasswordHunks = hunks.filter((h) => h.filePath.endsWith('ChangePassword.tsx'));
    assert.ok(changePasswordHunks.length > 0);
    for (const h of changePasswordHunks) {
      assert.doesNotMatch(h.reason, /exception handling/i);
    }
  });
});

describe('real PR: alacritty#9027 (one-line off-by-one)', () => {
  it('flags the vi_mode.rs range-operator change as high risk', () => {
    const hunks = loadHunks('alacritty_offbyone.diff');
    const rsHunks = hunks.filter((h) => h.filePath.endsWith('vi_mode.rs'));
    assert.equal(rsHunks.length, 1);
    assert.equal(rsHunks[0].level, 'high');
    assert.match(rsHunks[0].reason, /off-by-one|boundary/i);
  });

  it('does not flag the two CHANGELOG.md hunks as high risk', () => {
    const hunks = loadHunks('alacritty_offbyone.diff');
    const changelogHunks = hunks.filter((h) => h.filePath.endsWith('CHANGELOG.md'));
    assert.ok(changelogHunks.length >= 1);
    assert.ok(changelogHunks.every((h) => h.level === 'low'));
  });
});

describe('real PR: requests#4052 (default-parameter signature change)', () => {
  it('flags the signature change as medium risk', () => {
    const hunks = loadHunks('requests_regression.diff');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].level, 'medium');
    assert.match(hunks[0].reason, /signature changed/i);
  });
});

describe('smoke tests on large/complex real PRs (no crashes, valid output shape)', () => {
  const smokeFixtures = ['flask_signature.diff', 'django_feature.diff', 'pandas_deadcode.diff'];

  for (const fixture of smokeFixtures) {
    it(`processes every hunk in ${fixture} without throwing and returns a valid level`, () => {
      const hunks = loadHunks(fixture);
      assert.ok(hunks.length > 0, `expected ${fixture} to contain at least one hunk`);
      for (const h of hunks) {
        assert.ok(['low', 'medium', 'high'].includes(h.level), `invalid level "${h.level}" for ${h.filePath}`);
        assert.equal(typeof h.reason, 'string');
        assert.ok(h.reason.length > 0);
      }

      // Not asserted, just surfaced: a distribution summary makes it easy to
      // eyeball whether the engine's calls look sane for a real, messy PR
      // when running `node --test` with a reporter that shows console output.
      const counts = hunks.reduce((acc, h) => ((acc[h.level] = (acc[h.level] || 0) + 1), acc), {});
      console.log(`  [${fixture}] ${hunks.length} hunks -> ${JSON.stringify(counts)}`);
    });
  }

  it('REGRESSION: does not mistake Django admin test fixtures for SQL injection', () => {
    // Caught during calibration: the original SQL-injection heuristic
    // treated any co-occurrence of a SQL verb (SELECT/INSERT/UPDATE/DELETE)
    // and a "clause" word ANYWHERE in a hunk as query construction. A
    // 299-line Django admin test hunk full of `.join(`, f-strings, HTML
    // <select> markup, and phrases like "Delete selected model actions"
    // tripped it constantly — none of that is SQL. Fixed by requiring
    // verb+clause+string-concatenation to co-occur within a small sliding
    // window of lines, which real query-building diffs satisfy and
    // incidental scattered keywords don't.
    const hunks = loadHunks('django_feature.diff');
    const falsePositives = hunks.filter((h) => /sql/i.test(h.reason));
    assert.equal(
      falsePositives.length,
      0,
      `expected no SQL-injection flags in this feature PR, got: ${JSON.stringify(falsePositives.map((h) => h.filePath))}`
    );
  });

  it('REGRESSION: does not flag every hunk in django.contrib.admin as security-sensitive just because it is the admin app', () => {
    // Caught during calibration: a bare "admin" keyword matched constantly
    // across a PR that touches django.contrib.admin (the file path/module
    // name, not a security signal). Fixed by dropping "admin" from the
    // security-keyword list entirely.
    const hunks = loadHunks('django_feature.diff');
    const highCount = hunks.filter((h) => h.level === 'high').length;
    assert.ok(
      highCount <= 3,
      `expected only a handful of genuinely high-risk hunks in an ordinary feature PR, got ${highCount}/${hunks.length}`
    );
  });
});

describe('real PR: passkey-kit#4 (authorization-bypass fix buried in prose and version bumps)', () => {
  // Before: 15 high hunks, of which only context.rs/lib.rs were the actual
  // fix — the rest were CHANGELOG/README/docs prose describing the fix and
  // version bumps ("0.16.2" → "0.16.3") scored as off-by-one changes.
  const hunks = loadHunks('passkey_authbypass.diff');

  it('flags the actual fix (context.rs, lib.rs) as high', () => {
    const fix = hunks.filter((h) => /^contracts\/smart-wallet\/src\/(context|lib)\.rs$/.test(h.filePath) && h.level === 'high');
    assert.ok(fix.some((h) => h.filePath.endsWith('context.rs')), 'expected a high-risk context.rs hunk');
    assert.ok(fix.some((h) => h.filePath.endsWith('lib.rs')), 'expected a high-risk lib.rs hunk');
  });

  it('scores every prose hunk (CHANGELOG, READMEs, docs/) as low', () => {
    const prose = hunks.filter((h) => /(^|\/)(CHANGELOG|README)\.md$|^docs\//.test(h.filePath));
    assert.ok(prose.length >= 8, `expected the fixture's prose hunks, got ${prose.length}`);
    for (const h of prose) assert.equal(h.level, 'low', `${h.filePath}: ${h.reason}`);
  });

  it('scores every version-field hunk as low', () => {
    // package.json ×2, src/version.ts ("0.16.2" → "0.16.3" style bumps, all
    // previously high), plus contracts/smart-wallet/Cargo.toml and the
    // Cargo.lock entry for it (both already low before).
    const bumps = hunks.filter(
      (h) => !/\.md$/.test(h.filePath) && [...h.removedLines, ...h.addedLines].every((l) => /version/i.test(l))
    );
    assert.deepEqual(bumps.map((h) => h.filePath).sort(), [
      'contracts/Cargo.lock',
      'contracts/smart-wallet/Cargo.toml',
      'package.json',
      'packages/passkey-kit-sdk/package.json',
      'src/version.ts',
    ]);
    for (const h of bumps) assert.equal(h.level, 'low', `${h.filePath}: ${h.reason}`);
  });
});
