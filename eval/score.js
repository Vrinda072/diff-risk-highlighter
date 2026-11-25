// Scores labelled held-out pull requests: the frozen baseline engine and the
// current one, against GitHub's display order, largest-hunk-first and random.
//
//   node eval/score.js --labels eval/labels/yourname.json [--second eval/labels/other.json] [--k 3]
//
// Only PRs marked "done" are counted. Nothing per-hunk is printed, so a
// partial run does not bias labels still to be made.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { hunksOf } = require('./hunks.js');
const { evaluate, cohensKappa } = require('./metrics.js');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function loadEngines(baselineTag) {
  const engines = {};
  const source = execFileSync('git', ['show', `${baselineTag}:src/risk-engine.js`], { cwd: ROOT, encoding: 'utf8' });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'driskh-baseline-')), 'risk-engine.js');
  fs.writeFileSync(file, source);
  engines[baselineTag] = require(file);
  engines['current'] = require(path.join(ROOT, 'src', 'risk-engine.js'));
  return engines;
}

function labelledPrs(manifest, labelFile, cacheDir, engine) {
  const { labels } = readJson(labelFile);
  const prs = [];
  for (const pr of manifest.pullRequests) {
    const label = labels[pr.id];
    if (!label || !label.done || label.kind === 'exclude') continue;
    const diff = fs.readFileSync(path.join(cacheDir, `${pr.id}.diff`), 'utf8');
    if (crypto.createHash('sha256').update(diff).digest('hex') !== pr.diffSha256) {
      throw new Error(`${pr.id}: cached diff does not match the sealed hash`);
    }
    prs.push({
      id: pr.id,
      kind: label.kind,
      hunks: hunksOf(diff).map((h) => ({ level: engine.assessHunk(h).level, size: h.addedLines.length + h.removedLines.length })),
      fix: new Set(label.kind === 'bugfix' ? label.fix : []),
      review: new Set(label.review),
    });
  }
  return prs;
}

const pct = (x) => (Number.isNaN(x) ? 'n/a' : `${(100 * x).toFixed(0)}%`);

function report(name, result) {
  const { k, hit } = result;
  const lines = [
    `### Engine: ${name}`,
    '',
    `${result.pullRequests} labelled PRs (${result.bugfixWithLabels} bug fixes with a marked fix hunk), ${result.hunks} hunks.`,
    '',
    `| Reading order | fix in first 1 | fix in first ${k} (95% CI) |`,
    '|---|---|---|',
  ];
  for (const [key, label] of [['engine', 'Extension (severity)'], ['display', "GitHub's order"], ['largest', 'Largest hunk first'], ['random', 'Random']]) {
    const top = hit[`${key}@${k}`];
    const ci = top.ci ? ` (${pct(top.ci[0])} to ${pct(top.ci[1])})` : '';
    lines.push(`| ${label} | ${pct(hit[`${key}@1`].rate)} | ${pct(top.rate)}${ci} |`);
  }
  lines.push(
    '',
    `- Fix hunks flagged (medium or high): ${pct(result.fixRecall)}`,
    `- Hunks the reviewer is asked to inspect: ${pct(result.reviewBudget)}`,
    `- Precision of flags against "needs close review": ${pct(result.precision)} (high only: ${pct(result.highPrecision)})`,
    `- Review-worthy hunks that got a flag: ${pct(result.reviewRecall)}`,
    ''
  );
  return lines.join('\n');
}

function agreement(manifest, a, b) {
  const la = readJson(a).labels;
  const lb = readJson(b).labels;
  const pairs = { fix: [[], []], review: [[], []] };
  let shared = 0;
  for (const pr of manifest.pullRequests) {
    if (!la[pr.id]?.done || !lb[pr.id]?.done) continue;
    shared++;
    for (let i = 0; i < pr.hunks; i++) {
      for (const field of ['fix', 'review']) {
        pairs[field][0].push(la[pr.id][field].includes(i));
        pairs[field][1].push(lb[pr.id][field].includes(i));
      }
    }
  }
  return [
    `### Labeller agreement (${shared} PRs labelled by both)`,
    '',
    `- Cohen's kappa, "contains the fix": ${cohensKappa(...pairs.fix).toFixed(2)}`,
    `- Cohen's kappa, "needs close review": ${cohensKappa(...pairs.review).toFixed(2)}`,
    '',
  ].join('\n');
}

function run({ manifestFile, cacheDir, labelFile, secondFile, k, engines }) {
  const manifest = readJson(manifestFile);
  const engineSet = engines || loadEngines(manifest.baselineTag);
  const sections = [];
  let counted = 0;
  for (const [name, engine] of Object.entries(engineSet)) {
    const prs = labelledPrs(manifest, labelFile, cacheDir, engine);
    counted = prs.length;
    if (!counted) throw new Error('no labelled PRs are marked "done" yet');
    sections.push(report(name, evaluate(prs, { k })));
  }
  const head = [`## Held-out results (set sealed ${manifest.sealedOn})`, ''];
  if (counted < 30) head.push(`Pilot-sized: ${counted} PRs. Treat differences smaller than the confidence intervals as noise.`, '');
  if (secondFile) sections.push(agreement(manifest, labelFile, secondFile));
  return head.concat(sections).join('\n');
}

if (require.main === module) {
  const labelFile = arg('labels');
  if (!labelFile) throw new Error('--labels <file exported from the labelling page> is required');
  const text = run({
    manifestFile: arg('manifest', path.join(__dirname, 'heldout.json')),
    cacheDir: arg('cache', path.join(__dirname, 'cache')),
    labelFile,
    secondFile: arg('second'),
    k: Number(arg('k', 3)),
  });
  console.log(text);
  const reports = path.join(__dirname, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'latest.md'), text);
}

module.exports = { run };
