// Seals a held-out set of real pull requests. It never loads the risk engine
// and prints only counts, so nobody learns what is in the set by running it.
//
//   node eval/collect.js --since 2026-11-25
//   node eval/collect.js --since 2026-11-25 --extend   (grow an unlabelled set)
//
// --extend keeps every existing entry and the pilot exactly as they are and
// appends new repositories until the larger quotas are met. Only do that
// before anyone has scored the set.
//
// Rules: popular, recently active repositories (1,000+ stars) that are not in
// eval/seen-repos.json; only PRs merged on or after --since; at most one PR
// per repository; 6-40 hunks (a top-3 metric means nothing on a tiny diff),
// at least one source-code file. Writes eval/heldout.json (committed) and
// caches diffs in eval/cache/ (gitignored: third-party code is not
// redistributed; eval/fetch.js re-downloads it and checks the hashes).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { hunksOf } = require('./hunks.js');

const DIR = __dirname;
const CACHE = path.join(DIR, 'cache');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SINCE = arg('since');
if (!SINCE) throw new Error('--since YYYY-MM-DD is required');

const LANGUAGES = ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'cpp', 'csharp', 'ruby', 'php'];
const EXTEND = process.argv.includes('--extend');
const QUOTA = EXTEND ? { bugfix: 67, ordinary: 33 } : { bugfix: 40, ordinary: 20 };
const PER_LANGUAGE = EXTEND ? { bugfix: 10, ordinary: 5 } : { bugfix: 5, ordinary: 3 };
const PILOT = { bugfix: 8, ordinary: 4 };
const CODE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|scala)$/i;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function gh(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const message = String(e.stderr || e);
      if (attempt < 3 && /rate limit|abuse|403|502|503/i.test(message)) sleep(65_000);
      else throw e;
    }
  }
}

// A deterministic shuffle, so the pilot is a random slice rather than a pick.
let state = 20261125;
const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

function kindOf(title) {
  const noise = /\b(typo|docs?|readme|lint|format|prettier|ci|release|changelog|translation|i18n)\b/i;
  if (noise.test(title)) return null;
  if (/^\s*(fix|bugfix|hotfix)\b|\bfix(es|ed)?\b/i.test(title)) return 'bugfix';
  if (/\b(refactor|rename|clean ?up|bump|upgrade|update dependenc|add support|feat(ure)?)\b/i.test(title)) return 'ordinary';
  return null;
}

function popularRepos(language) {
  const out = gh(['search', 'repos', '--language', language, '--stars', '>=1000', '--updated', `>=${SINCE}`, '--sort', 'updated', '--limit', '60', '--json', 'fullName,stargazersCount']);
  sleep(2500);
  return JSON.parse(out);
}

function main() {
  const seen = new Set(JSON.parse(fs.readFileSync(path.join(DIR, 'seen-repos.json'), 'utf8')).repos);
  fs.mkdirSync(CACHE, { recursive: true });
  const manifestFile = path.join(DIR, 'heldout.json');
  const previous = EXTEND ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const picked = previous ? previous.pullRequests.slice() : [];
  const kept = picked.length;
  const used = new Set(picked.map((p) => p.repo.toLowerCase()));
  const count = (kind, language) => picked.filter((p) => p.kind === kind && (!language || p.language === language)).length;

  for (const language of LANGUAGES) {
    const repos = shuffle(popularRepos(language).filter((r) => !seen.has(r.fullName.toLowerCase())));
    for (const repo of repos) {
      const wants = Object.keys(QUOTA).filter((k) => count(k) < QUOTA[k] && count(k, language) < PER_LANGUAGE[k]);
      if (!wants.length) break;
      if (used.has(repo.fullName.toLowerCase())) continue;
      let prs;
      try {
        prs = JSON.parse(gh(['pr', 'list', '--repo', repo.fullName, '--state', 'merged', '--search', `merged:>=${SINCE}`, '--limit', '15', '--json', 'number,title,body,mergedAt,additions,deletions,changedFiles,headRefOid,url']));
      } catch (_) {
        continue;
      }
      sleep(400);
      for (const pr of shuffle(prs)) {
        const kind = kindOf(pr.title);
        if (!kind || !wants.includes(kind) || pr.mergedAt < SINCE) continue;
        const size = pr.additions + pr.deletions;
        if (pr.changedFiles < 2 || pr.changedFiles > 25 || size < 20 || size > 1200) continue;
        let diff;
        try {
          diff = gh(['pr', 'diff', String(pr.number), '--repo', repo.fullName]);
        } catch (_) {
          continue;
        }
        sleep(600);
        let hunks;
        try {
          hunks = hunksOf(diff);
        } catch (_) {
          continue;
        }
        if (hunks.length < 6 || hunks.length > 40 || !hunks.some((h) => CODE_FILE.test(h.filePath))) continue;
        const id = `${repo.fullName.replace('/', '__')}__${pr.number}`;
        fs.writeFileSync(path.join(CACHE, `${id}.diff`), diff);
        fs.writeFileSync(path.join(CACHE, `${id}.json`), JSON.stringify({ body: pr.body || '' }));
        picked.push({
          id, repo: repo.fullName, number: pr.number, url: pr.url, title: pr.title, kind, language,
          stars: repo.stargazersCount, mergedAt: pr.mergedAt, headSha: pr.headRefOid,
          diffSha256: crypto.createHash('sha256').update(diff).digest('hex'), hunks: hunks.length,
        });
        used.add(repo.fullName.toLowerCase());
        break;
      }
    }
    console.log(`${language.padEnd(11)} bugfix ${count('bugfix')}/${QUOTA.bugfix}  ordinary ${count('ordinary')}/${QUOTA.ordinary}`);
  }

  const fresh = shuffle(picked.splice(kept));
  const pilotLeft = previous ? { bugfix: 0, ordinary: 0 } : { ...PILOT };
  for (const p of fresh) p.pilot = pilotLeft[p.kind] > 0 ? (pilotLeft[p.kind]--, true) : false;
  picked.push(...fresh);

  const today = new Date().toISOString().slice(0, 10);
  const manifest = previous
    ? { ...previous, extendedOn: today, pullRequests: picked }
    : { sealedOn: today, mergedSince: SINCE, baselineTag: 'baseline-1.1.0', pullRequests: picked };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`sealed ${picked.length} pull requests (${count('bugfix')} bugfix, ${count('ordinary')} ordinary) from ${new Set(picked.map((p) => p.repo)).size} repositories`);
}

main();
