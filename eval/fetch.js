// Re-creates eval/cache/ on a fresh clone and checks every diff against the
// hash recorded when the set was sealed.   node eval/fetch.js [--pilot]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CACHE = path.join(__dirname, 'cache');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'heldout.json'), 'utf8'));
const pilotOnly = process.argv.includes('--pilot');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 90_000 });

fs.mkdirSync(CACHE, { recursive: true });
let ok = 0;
const changed = [];
for (const pr of manifest.pullRequests.filter((p) => !pilotOnly || p.pilot)) {
  const diffFile = path.join(CACHE, `${pr.id}.diff`);
  if (!fs.existsSync(diffFile)) {
    fs.writeFileSync(diffFile, gh(['pr', 'diff', String(pr.number), '--repo', pr.repo]));
    const { body } = JSON.parse(gh(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'body']));
    fs.writeFileSync(path.join(CACHE, `${pr.id}.json`), JSON.stringify({ body: body || '' }));
  }
  if (sha(fs.readFileSync(diffFile, 'utf8')) === pr.diffSha256) ok++;
  else changed.push(`${pr.repo}#${pr.number}`);
}
console.log(`${ok} diffs verified${changed.length ? `, ${changed.length} DIFFER from the sealed hash: ${changed.join(', ')}` : ''}`);
process.exit(changed.length ? 1 : 0);
