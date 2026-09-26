#!/usr/bin/env node
// Collects real-PR calibration fixtures for test/fixtures/real-prs/ using
// the gh CLI (must be installed and authenticated). Two steps, so a human
// always reviews the candidates before anything is written to the repo:
//
//   node scripts/fetch-fixtures.js search [--out candidates.json] [--category <key>] [--limit <n per query>]
//       Searches merged PRs in public repos for each bug category, drops
//       PRs over MAX_CHANGED_FILES files (and ones already used as
//       fixtures), and prints/saves the candidates. Writes nothing under
//       test/.
//
//   node scripts/fetch-fixtures.js fetch <manifest.json> [--refresh]
//       Downloads the diff for every PR in a hand-curated manifest (a JSON
//       array of fixture entries, see FixtureEntry below) into
//       test/fixtures/real-prs/<id>.diff and upserts its metadata into
//       test/fixtures/real-prs/metadata.json. A fixture file that already
//       exists is reused, not re-downloaded, unless --refresh is given, so
//       metadata can be (re)written for existing fixtures without touching
//       their diffs. Checks each entry's fixHunks against the diff and
//       fails loudly if one doesn't exist.
//
// "Which hunks contain the real fix" can't be inferred from a search
// result — it's filled in by a person reading the diff, in the manifest.
//
// FixtureEntry:
//   { id, repo, number, category, summary, fetchedAt?,
//     fixHunks: [{ file, header }]   // header = the hunk's "@@ ... @@" prefix
//   }
// category is one of the CATEGORIES keys below. fixHunks lists the hunks
// that carry the actual change the category is about — the fix, the
// weakened assertion, the changed signature. It's [] when there's no such
// hunk: "refactor" (negatives — every hunk should score low), "feature",
// and "dependency-bump".

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'real-prs');
const METADATA_FILE = path.join(FIXTURES_DIR, 'metadata.json');
const MAX_CHANGED_FILES = 30;
const MIN_STARS = 50; // skip toy/personal repos; real review context matters
const DEFAULT_RESULTS_PER_QUERY = 30;

const CATEGORIES = {
  'off-by-one': {
    label: 'Off-by-one fixes',
    queries: ['"off-by-one" in:title', '"off by one" in:title', '"fencepost" in:title'],
  },
  'race-condition': {
    label: 'Race-condition fixes',
    queries: ['"race condition" in:title fix', '"data race" in:title fix'],
  },
  'auth-security': {
    label: 'Auth/security fixes',
    queries: [
      '"authorization bypass" in:title',
      '"auth bypass" in:title',
      '"privilege escalation" in:title fix',
      '"missing authorization" in:title',
      '"permission check" in:title fix',
    ],
  },
  'weakened-test': {
    label: 'Weakened or removed test assertions',
    queries: [
      '"remove flaky assertion" in:title',
      '"relax assertion" in:title',
      '"loosen" in:title test assertion',
      '"remove assertion" in:title test',
      '"weaken" in:title test',
    ],
  },
  refactor: {
    label: 'Pure refactors/renames (negatives)',
    queries: ['"no functional change" in:title', '"no behavior change" in:title refactor', '"pure refactor" in:title', 'rename in:title "no functional changes"'],
  },
  // Metadata-only categories (no search queries): used by the original 17
  // fixtures, which were picked by hand before this script existed.
  'dead-code-removal': { label: 'Confirmed-dead code removal', queries: [] },
  'signature-change': { label: 'Function signature changes', queries: [] },
  feature: { label: 'Ordinary feature work (smoke test)', queries: [] },
  'dependency-bump': { label: 'Dependency/version bumps', queries: [] },
};

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function readMetadata() {
  return fs.existsSync(METADATA_FILE) ? JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')) : [];
}

// PRs already used as fixtures, from metadata.json plus the links in the
// fixtures README (the original 17 predate metadata.json).
function existingFixturePrs() {
  const seen = new Set(readMetadata().map((m) => `${m.repo}#${m.number}`.toLowerCase()));
  const readme = path.join(FIXTURES_DIR, 'README.md');
  if (fs.existsSync(readme)) {
    for (const m of fs.readFileSync(readme, 'utf8').matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
      seen.add(`${m[1]}#${m[2]}`.toLowerCase());
    }
  }
  return seen;
}

const repoCache = new Map();
function repoInfo(repo) {
  if (!repoCache.has(repo)) {
    const r = ghJson(['api', `repos/${repo}`]);
    repoCache.set(repo, { stars: r.stargazers_count, license: r.license?.spdx_id || null, archived: r.archived, fork: r.fork });
  }
  return repoCache.get(repo);
}

function search(categoryKeys, outFile, resultsPerQuery) {
  const already = existingFixturePrs();
  const candidates = [];

  for (const key of categoryKeys) {
    const { label, queries } = CATEGORIES[key];
    const seen = new Set();
    let kept = 0;
    let skipped = { tooManyFiles: 0, lowStars: 0, alreadyFixture: 0, other: 0 };

    for (const query of queries) {
      const results = ghJson([
        'search', 'prs', ...splitQuery(query),
        '--merged', '--visibility', 'public', '--sort', 'created', '--order', 'desc',
        '--limit', String(resultsPerQuery), '--json', 'repository,number,title,url',
      ]);
      for (const r of results) {
        const repo = r.repository.nameWithOwner;
        const id = `${repo}#${r.number}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (already.has(id.toLowerCase())) { skipped.alreadyFixture++; continue; }

        let info;
        let pr;
        try {
          info = repoInfo(repo);
          pr = ghJson(['pr', 'view', String(r.number), '--repo', repo, '--json', 'changedFiles,additions,deletions,mergedAt']);
        } catch {
          skipped.other++;
          continue;
        }
        if (info.archived || info.fork) { skipped.other++; continue; }
        if (info.stars < MIN_STARS) { skipped.lowStars++; continue; }
        if (pr.changedFiles > MAX_CHANGED_FILES) { skipped.tooManyFiles++; continue; }

        candidates.push({
          category: key,
          repo,
          number: r.number,
          title: r.title,
          url: r.url,
          stars: info.stars,
          license: info.license,
          changedFiles: pr.changedFiles,
          additions: pr.additions,
          deletions: pr.deletions,
          mergedAt: pr.mergedAt,
        });
        kept++;
      }
    }
    console.error(`${label}: ${kept} candidates (skipped: ${JSON.stringify(skipped)})`);
  }

  if (outFile) fs.writeFileSync(outFile, JSON.stringify(candidates, null, 2) + '\n');
  for (const c of candidates) {
    console.log(
      [c.category, `${c.repo}#${c.number}`, `${c.changedFiles}f +${c.additions}/-${c.deletions}`, `★${c.stars}`, c.license || 'no-license', c.title].join('\t')
    );
  }
}

// `gh search prs` takes the query as separate args; keep quoted phrases whole.
function splitQuery(q) {
  return (q.match(/"[^"]*"|\S+/g) || []);
}

function hunkHeaders(diffText) {
  const out = [];
  let file = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) file = null;
    else if (line.startsWith('+++ ') && line.slice(4).trim() !== '/dev/null') file = line.slice(4).trim().replace(/^b\//, '');
    else if (line.startsWith('--- ') && file === null && line.slice(4).trim() !== '/dev/null') file = line.slice(4).trim().replace(/^a\//, '');
    else if (line.startsWith('@@')) out.push({ file, header: line.match(/^@@[^@]*@@/)[0] });
  }
  return out;
}

function fetchFixtures(manifestFile, { refresh = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const metadata = readMetadata();

  for (const entry of manifest) {
    const { id, repo, number, category, summary, fixHunks = [] } = entry;
    const previous = metadata.find((m) => m.fixture === `${id}.diff`);
    if (!CATEGORIES[category]) throw new Error(`${id}: unknown category "${category}"`);

    const pr = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'title,url,changedFiles,mergedAt,state']);
    if (pr.state !== 'MERGED') throw new Error(`${id}: ${repo}#${number} is not merged`);
    if (pr.changedFiles > MAX_CHANGED_FILES) throw new Error(`${id}: ${pr.changedFiles} files > ${MAX_CHANGED_FILES}`);

    const diffFile = path.join(FIXTURES_DIR, `${id}.diff`);
    const reuse = fs.existsSync(diffFile) && !refresh;
    const diff = reuse ? fs.readFileSync(diffFile, 'utf8') : gh(['pr', 'diff', String(number), '--repo', repo]);
    const headers = hunkHeaders(diff);
    for (const fix of fixHunks) {
      if (!headers.some((h) => h.file === fix.file && h.header === fix.header)) {
        throw new Error(`${id}: fix hunk ${fix.file} ${fix.header} not found in the diff`);
      }
    }

    if (!reuse) fs.writeFileSync(diffFile, diff);
    const record = {
      fixture: `${id}.diff`,
      repo,
      number,
      url: pr.url,
      title: pr.title,
      category,
      summary,
      license: repoInfo(repo).license,
      mergedAt: pr.mergedAt,
      // When the diff was pulled from GitHub: an explicit manifest value, else
      // the existing record's date for a reused file, else today.
      fetchedAt: entry.fetchedAt || (reuse && previous?.fetchedAt) || new Date().toISOString().slice(0, 10),
      fixHunks,
    };
    const i = metadata.findIndex((m) => m.fixture === record.fixture);
    if (i === -1) metadata.push(record);
    else metadata[i] = record;
    console.log(`${reuse ? 'kept' : 'saved'} ${id}.diff (${headers.length} hunks, ${fixHunks.length} fix hunk(s))`);
  }

  metadata.sort((a, b) => a.category.localeCompare(b.category) || a.fixture.localeCompare(b.fixture));
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2) + '\n');
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };

  if (command === 'search') {
    const only = flag('--category');
    if (only && !CATEGORIES[only]) throw new Error(`unknown category "${only}"; one of: ${Object.keys(CATEGORIES).join(', ')}`);
    const searchable = Object.keys(CATEGORIES).filter((key) => CATEGORIES[key].queries.length > 0);
    search(only ? [only] : searchable, flag('--out'), Number(flag('--limit') || DEFAULT_RESULTS_PER_QUERY));
  } else if (command === 'fetch' && rest[0]) {
    fetchFixtures(rest[0], { refresh: rest.includes("--refresh") });
  } else {
    console.error('usage: node scripts/fetch-fixtures.js search [--out candidates.json] [--category <key>] [--limit <n per query>]\n       node scripts/fetch-fixtures.js fetch <manifest.json> [--refresh]');
    process.exit(1);
  }
}

// Runs as a CLI; when require()d (by test/fixtures-metadata.test.js) it
// only exposes the category list and the hunk-header parser.
if (require.main === module) main();

module.exports = { CATEGORIES, hunkHeaders };
