// Diff Risk Highlighter — content script (through Milestone 5: optional
// LLM explanations)
//
// GitHub's PR tabs (Conversation / Files changed / Commits) may be a full
// page reload or a Turbo-morphed SPA transition depending on session state
// (see docs/github-diff-dom.md — only tested logged-out so far, where it
// was a full reload). Rather than assume one or the other, the manifest
// matches any `/pull/*` URL so a full reload always re-injects and
// re-runs this script, AND this script listens for Turbo's navigation
// events in case a logged-in session morphs the DOM instead without
// re-injecting anything.
//
// See docs/github-diff-dom.md for the selectors relied on below.

(function () {
  // /files is the classic (server-rendered table) UI; /changes is GitHub's
  // React rewrite of the same tab, rolled out platform-wide some time
  // between 2026-08-26 and 2026-09-23 (confirmed live against two
  // unrelated repos — see docs/github-diff-dom.md). /files still
  // client-redirects to /changes today, but matching both means this
  // doesn't silently stop working again if that redirect is ever removed
  // or a session lands on the classic UI for any reason.
  const FILES_TAB_PATH = /\/pull\/\d+\/(files|changes)(\/|$)/;

  function isFilesChangedPage() {
    return FILES_TAB_PATH.test(location.pathname);
  }

  // -----------------------------------------------------------------------
  // Enable/disable toggle, persisted via chrome.storage so it survives the
  // full-page-reload navigation confirmed in Milestone 1 (an in-memory-only
  // flag would reset on every PR tab switch).
  // -----------------------------------------------------------------------

  const STORAGE_KEY = 'driskhEnabled';
  let enabled = true; // optimistic default until storage responds, so the
  // very first paint isn't stuck in a disabled state on a slow read

  function setEnabled(next, { persist = true } = {}) {
    enabled = next;
    document.documentElement.classList.toggle('driskh-disabled', !enabled);
    if (persist && chrome?.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: enabled });
    }
    if (enabled) runProcessPage();
  }

  if (chrome?.storage?.local) {
    chrome.storage.local.get({ [STORAGE_KEY]: true }, (result) => {
      setEnabled(result[STORAGE_KEY], { persist: false });
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        setEnabled(changes[STORAGE_KEY].newValue, { persist: false });
      }
    });
  }

  // -----------------------------------------------------------------------
  // Hunk extraction
  // -----------------------------------------------------------------------

  // A hunk boundary ("@@ -a,b +c,d @@ ...") row is identified by its
  // td.blob-code-hunk cell; it's *not* a standalone row — it shares a <tr>
  // with an expand-up/expand-down link cell (or, for a wholly new/deleted
  // file, a pair of non-expandable line-number cells instead — same
  // td.blob-code-hunk marker either way). `data-hunk` on later rows marks
  // group membership, not a boundary, and is not used here (see
  // docs/github-diff-dom.md for the full writeup).
  //
  // `hunkCell` is carried on each hunk alongside `headerRow` so markHunk
  // can append a badge/button without needing to know which DOM shape
  // (classic table vs. the newer React grid below) produced this hunk.
  function extractHunksFromFile(fileEl, table) {
    const header = fileEl.querySelector('.file-header');
    const filePath =
      header?.dataset.path || fileEl.dataset.tagsearchPath || '(unknown path)';

    const hunks = [];
    let current = null;

    for (const row of table.querySelectorAll('tr')) {
      const hunkCell = row.querySelector('td.blob-code-hunk');
      if (hunkCell) {
        current = { filePath, headerRow: row, hunkCell, rows: [], addedLines: [], removedLines: [] };
        hunks.push(current);
        continue;
      }
      if (!current) continue; // stray row before any hunk boundary (shouldn't normally happen)

      current.rows.push(row);
      const addInner = row.querySelector('td.blob-code-addition .blob-code-inner');
      if (addInner) current.addedLines.push(addInner.textContent);
      const delInner = row.querySelector('td.blob-code-deletion .blob-code-inner');
      if (delInner) current.removedLines.push(delInner.textContent);
    }

    return hunks;
  }

  // GitHub's React rewrite of Files Changed (confirmed live 2026-09-23 —
  // see docs/github-diff-dom.md for the full DOM capture). Structurally
  // simpler than it first looks: despite the "grid" framing, every line —
  // boundary, context, addition, or deletion — is still exactly one
  // <tr class="diff-line-row">, in the same top-to-bottom order a classic
  // unified diff would produce. Only the selectors changed:
  //   - hunk boundary:  td.diff-hunk-cell        (was td.blob-code-hunk)
  //   - added line:     code.diff-text.addition  (was td.blob-code-addition)
  //   - removed line:   code.diff-text.deletion  (was td.blob-code-deletion)
  //   - line text:      .diff-text-inner         (was .blob-code-inner)
  // The badge/button is appended into the hunk's own flex row (alongside
  // GitHub's expand-up/down button) rather than the <td> directly, so it
  // lays out inline with the existing controls instead of wrapping onto
  // its own line below them.
  function extractHunksFromNewDiffTable(table, filePath) {
    const hunks = [];
    let current = null;

    for (const row of table.querySelectorAll('tr.diff-line-row')) {
      const hunkTd = row.querySelector('td.diff-hunk-cell');
      if (hunkTd) {
        const hunkCell = hunkTd.querySelector('div.d-flex.flex-row') || hunkTd;
        current = { filePath, headerRow: row, hunkCell, rows: [], addedLines: [], removedLines: [] };
        hunks.push(current);
        continue;
      }
      if (!current) continue;

      current.rows.push(row);
      const addInner = row.querySelector('td.diff-text-cell code.diff-text.addition .diff-text-inner');
      if (addInner) current.addedLines.push(addInner.textContent);
      const delInner = row.querySelector('td.diff-text-cell code.diff-text.deletion .diff-text-inner');
      if (delInner) current.removedLines.push(delInner.textContent);
    }

    return hunks;
  }

  // -----------------------------------------------------------------------
  // Visual markers: colored left edge (inset box-shadow, so it never
  // changes row width/layout) + a small badge on the hunk's own header
  // row. Low-risk hunks are left untouched — the point is to draw the eye
  // to the few hunks that need it, not to paint every row a color.
  // -----------------------------------------------------------------------

  function markHunk(hunk, result, hunkIndex) {
    if (hunk.headerRow.dataset.driskhProcessed) return; // idempotent across rescans
    hunk.headerRow.dataset.driskhProcessed = 'true';
    hunk.headerRow.dataset.driskhLevel = result.level;
    hunk.headerRow.dataset.driskhReason = result.reason;
    hunk.headerRow.dataset.driskhFile = hunk.filePath;

    if (result.level === 'low') return;

    const hunkId = `driskh-hunk-${hunkIndex}`;
    hunk.headerRow.id = hunkId;

    const markClass = `driskh-edge-${result.level}`;
    hunk.headerRow.children[0] && hunk.headerRow.children[0].classList.add(markClass);
    for (const row of hunk.rows) {
      if (row.children[0]) row.children[0].classList.add(markClass);
    }

    const hunkCell = hunk.hunkCell;
    if (hunkCell && !hunkCell.querySelector('.driskh-badge')) {
      const badge = document.createElement('span');
      badge.className = `driskh-badge driskh-badge--${result.level}`;
      badge.textContent = result.level.toUpperCase();
      badge.title = result.reason;
      hunkCell.appendChild(badge);

      // Milestone 5: fully optional, opt-in, high-risk-only. Nothing here
      // runs — and no network request happens anywhere — unless the user
      // clicks this button.
      if (result.level === 'high') {
        const explainBtn = document.createElement('button');
        explainBtn.type = 'button';
        explainBtn.className = 'driskh-explain-btn';
        explainBtn.textContent = 'Explain';
        explainBtn.addEventListener('click', () =>
          requestExplanation(hunk, result, explainBtn)
        );
        hunkCell.appendChild(explainBtn);
      }
    }
  }

  // Talks to src/background.js via chrome.runtime.sendMessage rather than
  // fetching directly, because a content script's fetch is subject to
  // GitHub's own CSP — a background service worker's isn't (see
  // background.js for the full reasoning).
  function requestExplanation(hunk, result, button) {
    button.disabled = true;
    button.textContent = 'Thinking…';
    button.title = '';

    chrome.runtime.sendMessage(
      {
        type: 'driskh-explain',
        hunk: {
          filePath: hunk.filePath,
          reason: result.reason,
          addedLines: hunk.addedLines,
          removedLines: hunk.removedLines,
        },
      },
      (response) => {
        if (chrome.runtime.lastError || !response) {
          resetExplainButton(button, 'Could not reach the extension background page.');
          return;
        }

        if (response.error === 'no-api-key' || response.error === 'invalid-api-key') {
          const promptText =
            response.error === 'invalid-api-key'
              ? 'That API key was rejected by Anthropic. Enter a valid Anthropic API key:'
              : 'Enter your Anthropic API key to enable one-sentence AI explanations ' +
                'for high-risk hunks.\n\nStored only in this browser ' +
                '(chrome.storage.local) and sent only to api.anthropic.com when you ' +
                'click "Explain" — never anywhere else. Everything else in this ' +
                'extension works fully without one.';
          const key = window.prompt(promptText);
          if (!key || !key.trim()) {
            resetExplainButton(button);
            return;
          }
          chrome.storage.local.set({ driskhApiKey: key.trim() }, () => {
            requestExplanation(hunk, result, button); // retry once with the new key
          });
          return;
        }

        if (response.error) {
          resetExplainButton(button, `Explanation failed (${response.error}).`);
          return;
        }

        const note = document.createElement('span');
        note.className = 'driskh-explanation';
        note.textContent = `💡 ${response.explanation}`;
        button.replaceWith(note);
      }
    );
  }

  function resetExplainButton(button, title) {
    button.disabled = false;
    button.textContent = 'Explain';
    if (title) button.title = title;
  }

  // -----------------------------------------------------------------------
  // Sticky summary bar
  // -----------------------------------------------------------------------

  const SUMMARY_BAR_ID = 'driskh-summary-bar';

  function getOrCreateSummaryBar() {
    let bar = document.getElementById(SUMMARY_BAR_ID);
    if (bar) return bar;

    // #files is the classic UI's file-list container; the React rewrite
    // (see extractHunksFromNewDiffTable above) has no such element, so
    // fall back to its one page-wide diffs-list container instead.
    const anchor =
      document.getElementById('files') ||
      document.querySelector('[data-testid="progressive-diffs-list"]');
    if (!anchor || !anchor.parentElement) return null;

    bar = document.createElement('div');
    bar.id = SUMMARY_BAR_ID;
    // Sticks at the same offset as GitHub's own per-file sticky headers
    // (measured, not hardcoded, so it keeps working if GitHub's toolbar
    // height changes). It can cosmetically overlap the currently-stuck
    // file header for the height of this bar during scroll — a documented
    // tradeoff, not a layout break (see README Known Limitations). The
    // React rewrite has no .pr-toolbar at all, so this degrades to a
    // plain top:0 stick there rather than failing.
    const toolbar = document.querySelector('.pr-toolbar');
    const top = toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0;
    bar.style.top = `${top}px`;

    anchor.parentElement.insertBefore(bar, anchor);
    return bar;
  }

  let lastSummaryHtml = null;

  function renderSummaryBar() {
    const headerRows = document.querySelectorAll('tr[data-driskh-level]');

    // Even with nothing scanned yet (or highlighting off), keep a minimal
    // bar around so the toggle stays reachable — this is the one thing
    // that should never be skipped for performance, since it's how the
    // user gets back to "on".
    const bar = getOrCreateSummaryBar();
    if (!bar) return;

    const counts = { high: 0, medium: 0, low: 0 };
    const highLinks = [];
    headerRows.forEach((row, i) => {
      const level = row.dataset.driskhLevel;
      counts[level] = (counts[level] || 0) + 1;
      if (level === 'high') {
        const label = row.dataset.driskhFile.split('/').pop();
        highLinks.push({ id: row.id || `driskh-hunk-${i}`, label, reason: row.dataset.driskhReason });
      }
    });

    const MAX_VISIBLE_LINKS = 12;
    const visibleLinks = highLinks.slice(0, MAX_VISIBLE_LINKS);
    const overflow = highLinks.length - visibleLinks.length;

    const statsHtml =
      headerRows.length > 0
        ? `
      <span class="driskh-summary-counts">
        <strong>${headerRows.length}</strong> hunk${headerRows.length === 1 ? '' : 's'} scanned —
        <span class="driskh-count driskh-count--high">${counts.high} high</span>,
        <span class="driskh-count driskh-count--medium">${counts.medium} medium</span>,
        <span class="driskh-count driskh-count--low">${counts.low} low</span>
      </span>
      ${
        visibleLinks.length > 0
          ? `<span class="driskh-summary-jumps">Jump to high risk:
              ${visibleLinks
                .map(
                  (l) =>
                    `<button type="button" class="driskh-jump-chip" data-driskh-target="${l.id}" title="${escapeHtml(l.reason)}">${escapeHtml(l.label)}</button>`
                )
                .join('')}
              ${overflow > 0 ? `<span class="driskh-jump-overflow">+${overflow} more</span>` : ''}
            </span>`
          : ''
      }`
        : `<span class="driskh-summary-counts driskh-summary-counts--empty">Diff Risk Highlighter</span>`;

    const nextHtml = `
      ${statsHtml}
      <label class="driskh-toggle">
        <input type="checkbox" class="driskh-toggle-input" ${enabled ? 'checked' : ''} />
        Highlighting
      </label>
    `;

    // Rewriting innerHTML unconditionally would re-fire on every call even
    // when nothing actually changed (e.g. a rescan triggered by an
    // unrelated part of the page mutating) — skip the write, and the
    // reflow/paint that comes with it, when the content is identical.
    if (nextHtml === lastSummaryHtml) return;
    lastSummaryHtml = nextHtml;
    bar.innerHTML = nextHtml;

    if (!bar.dataset.driskhClickBound) {
      bar.dataset.driskhClickBound = 'true';
      bar.addEventListener('click', (e) => {
        const chip = e.target.closest('.driskh-jump-chip');
        if (!chip) return;
        const target = document.getElementById(chip.dataset.driskhTarget);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      bar.addEventListener('change', (e) => {
        if (e.target.classList.contains('driskh-toggle-input')) {
          setEnabled(e.target.checked);
        }
      });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Orchestration
  // -----------------------------------------------------------------------

  function injectStylesOnce() {
    if (document.getElementById('driskh-styles')) return;
    const style = document.createElement('style');
    style.id = 'driskh-styles';
    style.textContent = `
      .driskh-edge-high { box-shadow: inset 3px 0 0 0 #cf222e; }
      .driskh-edge-medium { box-shadow: inset 3px 0 0 0 #9a6700; }
      .driskh-badge {
        display: inline-block;
        margin-left: 8px;
        padding: 0 6px;
        border-radius: 2em;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        vertical-align: middle;
        cursor: default;
      }
      .driskh-badge--high { background: #ffebe9; color: #cf222e; }
      .driskh-badge--medium { background: #fff8c5; color: #7d5b00; }
      .driskh-explain-btn {
        margin-left: 8px;
        font-size: 11px;
        padding: 0 7px;
        border-radius: 2em;
        border: 1px solid #57606a;
        background: transparent;
        color: #57606a;
        cursor: pointer;
        vertical-align: middle;
      }
      .driskh-explain-btn:hover:not(:disabled) { background: #57606a; color: #fff; }
      .driskh-explain-btn:disabled { cursor: default; opacity: 0.7; }
      .driskh-explanation {
        margin-left: 8px;
        font-style: italic;
        color: #57606a;
      }
      #${SUMMARY_BAR_ID} {
        position: sticky;
        z-index: 10;
        background: var(--bgColor-muted, #f6f8fa);
        border: 1px solid var(--borderColor-default, #d1d9e0);
        border-radius: 6px;
        padding: 8px 12px;
        margin-bottom: 12px;
        font-size: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        align-items: center;
      }
      .driskh-summary-counts--empty { color: #57606a; }
      .driskh-count--high { color: #cf222e; font-weight: 600; }
      .driskh-count--medium { color: #9a6700; font-weight: 600; }
      .driskh-count--low { color: #57606a; }
      .driskh-summary-jumps { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; }
      .driskh-jump-chip {
        font-size: 11px;
        padding: 1px 8px;
        border-radius: 2em;
        border: 1px solid #cf222e;
        background: #ffebe9;
        color: #cf222e;
        cursor: pointer;
      }
      .driskh-jump-chip:hover { background: #cf222e; color: #fff; }
      .driskh-jump-overflow { font-size: 11px; color: #57606a; }
      .driskh-toggle {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #57606a;
        cursor: pointer;
        -webkit-user-select: none;
        user-select: none;
      }
      .driskh-toggle-input { margin: 0; cursor: pointer; }

      /* Disabled: hide markers/badges/stats without discarding the
         underlying data-driskh-* attributes, so re-enabling is instant
         (no re-scan needed) rather than re-running every heuristic. */
      html.driskh-disabled .driskh-edge-high,
      html.driskh-disabled .driskh-edge-medium { box-shadow: none; }
      html.driskh-disabled .driskh-badge,
      html.driskh-disabled .driskh-explain-btn,
      html.driskh-disabled .driskh-explanation { display: none; }
      html.driskh-disabled .driskh-summary-counts,
      html.driskh-disabled .driskh-summary-jumps { display: none; }
    `;
    document.head.appendChild(style);
  }

  // Cheap early-exit: counting hunk-header cells is far cheaper than
  // walking every row, so a file whose count hasn't changed since its
  // last scan is skipped entirely. This matters at scale (100+ files) and
  // especially for individual huge files (thousands of rows) that are
  // otherwise re-walked on every unrelated DOM mutation.
  function countHunkHeaders(table) {
    return table.querySelectorAll('td.blob-code-hunk').length;
  }

  function assessAndMark(hunk, hunkIndex) {
    const result = DiffRiskEngine.assessHunk({
      filePath: hunk.filePath,
      addedLines: hunk.addedLines,
      removedLines: hunk.removedLines,
    });
    markHunk(hunk, result, hunkIndex);
  }

  function processPage() {
    if (!isFilesChangedPage()) return;

    // Classic server-rendered table (see extractHunksFromFile) and
    // GitHub's React rewrite (see extractHunksFromNewDiffTable) use
    // disjoint selectors, so both are scanned unconditionally — whichever
    // one the current session actually renders is the one that matches.
    const newTables = document.querySelectorAll('table[aria-label^="Diff for: "]');
    const fileEls = document.querySelectorAll('.file[data-tagsearch-path]');
    if (newTables.length === 0 && fileEls.length === 0) return; // still loading

    injectStylesOnce();

    if (enabled) {
      let hunkIndex = document.querySelectorAll('tr[data-driskh-processed]').length;

      for (const table of newTables) {
        const currentHunkCount = table.querySelectorAll('td.diff-hunk-cell').length;
        const lastHunkCount = Number(table.dataset.driskhHunkCount || 0);
        if (currentHunkCount === lastHunkCount) continue; // nothing new since last scan
        table.dataset.driskhHunkCount = String(currentHunkCount);

        const filePath =
          (table.getAttribute('aria-label') || '').replace(/^Diff for:\s*/, '') || '(unknown path)';
        for (const hunk of extractHunksFromNewDiffTable(table, filePath)) {
          if (hunk.headerRow.dataset.driskhProcessed) continue;
          assessAndMark(hunk, hunkIndex++);
        }
      }

      for (const fileEl of fileEls) {
        const table = fileEl.querySelector('table.diff-table');
        if (!table) continue; // binary file, or diff collapsed behind "Load diff"/lazy-loaded fragment

        const currentHunkCount = countHunkHeaders(table);
        const lastHunkCount = Number(fileEl.dataset.driskhHunkCount || 0);
        if (currentHunkCount === lastHunkCount) continue; // nothing new since last scan
        fileEl.dataset.driskhHunkCount = String(currentHunkCount);

        for (const hunk of extractHunksFromFile(fileEl, table)) {
          if (hunk.headerRow.dataset.driskhProcessed) continue;
          assessAndMark(hunk, hunkIndex++);
        }
      }
    }

    renderSummaryBar();
  }

  // Also catches GitHub's own lazy-loaded diff content: large/collapsed
  // files load their table via an <include-fragment> that swaps in real
  // markup later (on "Load diff" click, or automatically for some files)
  // — confirmed live against a real PR where a 2,848-line deletion loaded
  // this way and was correctly picked up on the next scheduled scan.
  const observer = new MutationObserver(scheduleScan);

  // processPage's own writes (badges, dataset flags, the summary bar)
  // are themselves childList/subtree mutations, so the observer above
  // would otherwise react to its own output — confirmed live: without
  // this guard, an idle PR page with nothing actually changing still
  // ran dozens of scans in a few seconds, forever, because rewriting the
  // summary bar's innerHTML re-triggered the very observer watching for
  // that rewrite. Disconnecting for the duration of our own synchronous
  // write (and reconnecting right after — nothing else can run in
  // between, JS is single-threaded) breaks the self-triggering loop
  // without missing any genuine external mutation.
  function runProcessPage() {
    observer.disconnect();
    try {
      processPage();
    } finally {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      runProcessPage();
    }, 150);
  }

  document.addEventListener('turbo:load', scheduleScan);
  document.addEventListener('turbo:frame-load', scheduleScan);

  observer.observe(document.documentElement, { childList: true, subtree: true });

  scheduleScan();
})();
