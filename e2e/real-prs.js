// The live GitHub PR behind each fixture in test/fixtures/real-prs/
// (same list as that directory's README), plus the fixture's expected
// high/medium/low counts computed by running src/risk-engine.js over the
// fixture diff — the same thing test/risk-engine.real-diffs.test.js does.

const fs = require('node:fs');
const path = require('node:path');
const { assessHunk } = require('../src/risk-engine.js');
const { parseDiff } = require('../test/helpers/parse-diff.js');

const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'real-prs');

const REAL_PRS = [
  { fixture: 'vip_sqli.diff', repo: 'virtual-imaging-platform/VIP-portal', number: 698 },
  { fixture: 'partage_xss.diff', repo: 'deltablot/partage', number: 8 },
  { fixture: 'django_deadcode.diff', repo: 'django/django', number: 18925 },
  { fixture: 'pandas_deadcode.diff', repo: 'pandas-dev/pandas', number: 66045 },
  { fixture: 'numpy_unreachable.diff', repo: 'numpy/numpy', number: 32143 },
  { fixture: 'django_rename.diff', repo: 'django/django', number: 21696 },
  { fixture: 'passcore_prettier.diff', repo: 'EastCentralRegionalLibrary/passcore', number: 150 },
  { fixture: 'alacritty_offbyone.diff', repo: 'alacritty/alacritty', number: 9027 },
  { fixture: 'requests_regression.diff', repo: 'psf/requests', number: 4052 },
  { fixture: 'flask_signature.diff', repo: 'pallets/flask', number: 5818 },
  { fixture: 'django_feature.diff', repo: 'django/django', number: 16012 },
  { fixture: 'squarelet_race.diff', repo: 'MuckRock/squarelet', number: 777 },
  { fixture: 'cais_csrf.diff', repo: 'puppe1990/cais', number: 180 },
  { fixture: 'mglet_offbyone.diff', repo: 'kmturbulenz/mglet-base', number: 226 },
  { fixture: 'passkey_authbypass.diff', repo: 'stellar/passkey-kit', number: 4 },
  { fixture: 'stelinter_depbump.diff', repo: 'Firelight-Innovations/STE-Linter', number: 18 },
  { fixture: 'camconf_refactor.diff', repo: 'MarekNajman/Cam-Conf-RPi-Prusa-Connect-Cam', number: 2 },
];

// GitHub's web diff merges two hunks of the same file when exactly one
// unchanged line separates them (like `git diff --inter-hunk-context=1`);
// `gh pr diff`, which produced the fixtures, keeps them separate. Measured
// across all 17 fixtures: every gap of 1 was merged live, every gap of 2+
// was not. Merging here makes the fixture's hunks line up 1:1 with the
// hunks the extension actually sees on the page. Context lines are
// ignored by the engine, so the merged hunk is just the concatenation.
function mergeHunksLikeGitHub(hunks) {
  const merged = [];
  for (const hunk of hunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.filePath === hunk.filePath && hunk.newStart - (prev.newStart + prev.newCount) <= 1) {
      prev.newCount = hunk.newStart + hunk.newCount - prev.newStart;
      prev.addedLines.push(...hunk.addedLines);
      prev.removedLines.push(...hunk.removedLines);
    } else {
      merged.push({ ...hunk, addedLines: [...hunk.addedLines], removedLines: [...hunk.removedLines] });
    }
  }
  return merged;
}

function expectedCounts(fixture) {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf8');
  const counts = { high: 0, medium: 0, low: 0 };
  for (const hunk of mergeHunksLikeGitHub(parseDiff(text))) counts[assessHunk(hunk).level]++;
  return counts;
}

function expectedFileCount(fixture) {
  const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf8');
  return new Set(parseDiff(text).map((hunk) => hunk.filePath)).size;
}

module.exports = { REAL_PRS, expectedCounts, expectedFileCount };
