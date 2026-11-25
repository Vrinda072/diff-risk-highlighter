// Small stand-ins for GitHub's two "Files changed" layouts, using the same
// elements and attributes the content script reads (docs/github-diff-dom.md).
// Each "file" is { path, hunks: [{ removed: [], added: [] }] }.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function classicRow(kind, text) {
  return `<tr><td class="blob-num blob-num-${kind}"></td><td class="blob-num"></td><td class="blob-code blob-code-${kind}"><span class="blob-code-inner">${esc(text)}</span></td></tr>`;
}

function classicFile(file) {
  const hunks = file.hunks
    .map(
      (h, i) =>
        `<tr><td class="blob-num blob-num-expandable" colspan="2"></td><td class="blob-code blob-code-inner blob-code-hunk">@@ -${i * 10 + 1},5 +${i * 10 + 1},5 @@</td></tr>` +
        h.removed.map((l) => classicRow('deletion', l)).join('') +
        h.added.map((l) => classicRow('addition', l)).join('')
    )
    .join('');
  return `<div class="file" data-tagsearch-path="${esc(file.path)}"><div class="file-header" data-path="${esc(file.path)}"></div><table class="diff-table"><tbody>${hunks}</tbody></table></div>`;
}

function reactRow(kind, text) {
  return `<tr class="diff-line-row"><td></td><td></td><td class="diff-text-cell"><code class="diff-text ${kind}"><div class="diff-text-inner">${esc(text)}</div></code></td></tr>`;
}

function reactFile(file) {
  const hunks = file.hunks
    .map(
      (h, i) =>
        `<tr class="diff-line-row"><td class="diff-hunk-cell" colspan="4"><div class="d-flex flex-row"><code class="diff-text-cell hunk"><div class="diff-text-inner">@@ -${i * 10 + 1},5 +${i * 10 + 1},5 @@</div></code></div></td></tr>` +
        h.removed.map((l) => reactRow('deletion', l)).join('') +
        h.added.map((l) => reactRow('addition', l)).join('')
    )
    .join('');
  return `<div><table aria-label="Diff for: ${esc(file.path)}" role="grid"><tbody>${hunks}</tbody></table></div>`;
}

// One high (SQL built by concatenation), one medium (signature), one low (rename).
const SAMPLE_FILES = [
  {
    path: 'src/UserDao.java',
    hunks: [{ removed: ['String q = "SELECT * FROM users WHERE id = ?";'], added: ['String q = "SELECT * FROM users WHERE id = " + id;'] }],
  },
  { path: 'app/utils.py', hunks: [{ removed: ['def get_proxies(url, no_proxy):'], added: ['def get_proxies(url, no_proxy=None):'] }] },
  { path: 'app/names.py', hunks: [{ removed: ['    total = count + 2'], added: ['    total = item_count + 2'] }] },
];

// Appears later, the way GitHub lazy-loads a file.
const LATE_FILE = {
  path: 'src/Retry.java',
  hunks: [{ removed: ['try {', '    send(request);', '} catch (IOException e) { log(e); }'], added: ['send(request);'] }],
};

function pageHtml(layout, files) {
  const body =
    layout === 'classic'
      ? `<div class="pr-toolbar" style="height:40px"></div><div id="files">${files.map(classicFile).join('')}</div>`
      : `<main><div data-testid="progressive-diffs-list">${files.map(reactFile).join('')}</div></main>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${layout} fixture</title></head><body>${body}</body></html>`;
}

module.exports = { classicFile, reactFile, pageHtml, SAMPLE_FILES, LATE_FILE };
