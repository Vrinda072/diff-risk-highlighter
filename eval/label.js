// Builds an offline labelling page for the held-out set. The page shows each
// PR's hunks in GitHub's order and deliberately nothing from the engine.
//
//   node eval/label.js --name yourname [--pilot]
//
// Open the file it prints, label, then press "Export labels" and save the file
// into eval/labels/.

const fs = require('node:fs');
const path = require('node:path');
const { hunksOf } = require('./hunks.js');

const CACHE = path.join(__dirname, 'cache');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const labeler = (arg('name') || '').replace(/[^a-z0-9_-]/gi, '');
if (!labeler) throw new Error('--name <your name> is required');
const pilot = process.argv.includes('--pilot');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'heldout.json'), 'utf8'));
const prs = manifest.pullRequests
  .filter((p) => !pilot || p.pilot)
  .map((p) => {
    const diffFile = path.join(CACHE, `${p.id}.diff`);
    if (!fs.existsSync(diffFile)) throw new Error(`missing ${p.id}: run node eval/fetch.js first`);
    return {
      id: p.id, repo: p.repo, number: p.number, url: p.url, title: p.title, kind: p.kind,
      body: JSON.parse(fs.readFileSync(path.join(CACHE, `${p.id}.json`), 'utf8')).body.slice(0, 4000),
      hunks: hunksOf(fs.readFileSync(diffFile, 'utf8')).map((h) => ({ file: h.filePath, header: h.header, text: h.text })),
    };
  });

// All PR content is data inside a JSON block and is rendered with textContent,
// so nothing in a diff or description can run as markup.
const data = JSON.stringify({ labeler, sealedOn: manifest.sealedOn, prs }).replace(/</g, '\\u003c');

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Held-out labelling</title><style>
:root{color-scheme:light dark}body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:16px 16px 80px}
header{position:sticky;top:0;background:Canvas;padding:10px 0;border-bottom:1px solid GrayText;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:1}
button,select{font:inherit;padding:4px 12px}.pr{border:1px solid GrayText;border-radius:8px;margin:20px 0;padding:12px}
.pr.done{opacity:.6}.file{font:600 12px ui-monospace,monospace;margin-top:14px}
pre{margin:4px 0;font:12px/1.45 ui-monospace,monospace;overflow-x:auto;border:1px solid #8884;border-radius:6px;padding:6px;max-height:420px}
pre span{display:block;white-space:pre}.add{background:#2ea04333}.del{background:#f8514933}.marks{display:flex;gap:20px;flex-wrap:wrap}
details pre{white-space:pre-wrap}label{cursor:pointer}</style></head><body>
<header><strong>Held-out labelling</strong><span id="progress"></span><button id="export">Export labels</button><label>Resume from a file <input type="file" id="import" accept=".json"></label></header>
<p>Read the whole PR, then mark hunks in the order shown. <b>Contains the fix</b>: the change that actually repairs the bug (not tests, docs or clean-up). <b>Needs close review</b>: you would not approve the PR without reading this hunk carefully. Do not run the extension on these PRs. See eval/LABELING.md.</p>
<main id="list"></main>
<script type="application/json" id="data">${data}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const KEY = 'driskh-labels-' + D.labeler + '-' + D.sealedOn;
let labels = {};
try { labels = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
const entry = (p) => labels[p.id] || (labels[p.id] = { kind: p.kind, fix: [], review: [], done: false, note: '' });
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(labels)); } catch (e) {} progress(); };
const progress = () => { document.getElementById('progress').textContent = D.prs.filter((p) => labels[p.id] && labels[p.id].done).length + ' / ' + D.prs.length + ' done'; };
const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; };
function box(text, checked, onchange) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => { onchange(input.checked); save(); });
  return el('label', {}, input, ' ' + text);
}
const toggle = (list, i, on) => { const at = list.indexOf(i); if (on && at < 0) list.push(i); if (!on && at >= 0) list.splice(at, 1); };
function render() {
  const list = document.getElementById('list');
  list.replaceChildren();
  D.prs.forEach((p, n) => {
    const e = entry(p);
    const card = el('section', { className: 'pr' + (e.done ? ' done' : '') });
    card.append(el('h3', {}, (n + 1) + '. ' + p.title));
    card.append(el('a', { href: p.url, target: '_blank', rel: 'noreferrer' }, p.repo + ' #' + p.number));
    const kind = el('select', {});
    [['bugfix', 'bug fix'], ['ordinary', 'ordinary change'], ['exclude', "can't judge: exclude"]].forEach(([v, t]) => kind.append(el('option', { value: v, selected: e.kind === v }, t)));
    kind.addEventListener('change', () => { e.kind = kind.value; save(); render(); });
    card.append(el('div', {}, 'This PR is a ', kind));
    card.append(el('details', {}, el('summary', {}, 'Description'), el('pre', {}, p.body || '(none)')));
    p.hunks.forEach((h, i) => {
      card.append(el('div', { className: 'file' }, 'hunk ' + (i + 1) + ' of ' + p.hunks.length + ' — ' + h.file));
      const pre = el('pre', {}, el('span', {}, h.header));
      h.text.split('\\n').forEach((line) => pre.append(el('span', { className: line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '' }, line || ' ')));
      card.append(pre);
      const marks = el('div', { className: 'marks' });
      if (e.kind === 'bugfix') marks.append(box('Contains the fix', e.fix.includes(i), (on) => toggle(e.fix, i, on)));
      marks.append(box('Needs close review', e.review.includes(i), (on) => toggle(e.review, i, on)));
      card.append(marks);
    });
    const note = el('input', { type: 'text', value: e.note, placeholder: 'note (optional)', size: 60 });
    note.addEventListener('change', () => { e.note = note.value; save(); });
    card.append(el('p', {}, note));
    card.append(box('Done with this PR', e.done, (on) => { e.done = on; card.classList.toggle('done', on); }));
    list.append(card);
  });
  progress();
}
document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ labeler: D.labeler, sealedOn: D.sealedOn, labels }, null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'labels-' + D.labeler + '.json' });
  a.click(); URL.revokeObjectURL(a.href);
});
document.getElementById('import').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  labels = JSON.parse(await file.text()).labels; save(); render();
});
render();
</script></body></html>`;

const out = path.join(CACHE, `label-${labeler}${pilot ? '-pilot' : ''}.html`);
fs.writeFileSync(out, page);
console.log(`${prs.length} pull requests -> ${out}`);
