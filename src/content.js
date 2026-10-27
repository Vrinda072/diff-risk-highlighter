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
    const box = document.querySelector(`#${SUMMARY_BAR_ID} .driskh-toggle-input`);
    if (box) box.checked = enabled; // also reached via the toolbar button, not just the switch
    if (persist && chrome?.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: enabled });
    }
    if (enabled) runProcessPage();
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

  let nextHunkId = 0;

  function markHunk(hunk, result) {
    if (hunk.headerRow.dataset.driskhProcessed) return; // idempotent across rescans
    hunk.headerRow.dataset.driskhProcessed = 'true';
    hunk.headerRow.dataset.driskhLevel = result.level;
    hunk.headerRow.dataset.driskhReason = result.reason;
    hunk.headerRow.dataset.driskhFile = hunk.filePath;

    if (result.level === 'low') return;

    hunk.headerRow.id = `driskh-hunk-${nextHunkId++}`;

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
  // background.js for the full reasoning). Which provider answers (Ollama,
  // Gemini, Anthropic) is chosen on the extension's options page.
  const NEEDS_SETUP = new Set(['not-configured', 'no-api-key', 'invalid-api-key']);

  function showExplainError(button, message) {
    let note = button.parentElement && button.parentElement.querySelector('.driskh-explain-error');
    if (!note) {
      note = document.createElement('span');
      note.className = 'driskh-explanation driskh-explain-error';
      button.after(note);
    }
    note.textContent = message;
  }

  function requestExplanation(hunk, result, button) {
    button.disabled = true;
    button.textContent = 'Thinking…';
    button.title = '';
    button.parentElement?.querySelector('.driskh-explain-error')?.remove();

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
          showExplainError(button, 'Could not reach the extension. Try reloading it from chrome://extensions.');
          return;
        }

        if (response.error) {
          resetExplainButton(button, response.detail || response.message);
          showExplainError(button, response.message || `Explanation failed (${response.error}).`);
          if (NEEDS_SETUP.has(response.error)) chrome.runtime.sendMessage({ type: 'driskh-open-options' });
          return;
        }

        button.parentElement?.querySelector('.driskh-explain-error')?.remove();
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

  const renderedHtml = new WeakMap();

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

    const MAX_VISIBLE_LINKS = 8;
    // Two high hunks in one file would otherwise read identically ("context.rs",
    // "context.rs"), so repeats get a position suffix: "context.rs (1/2)".
    const labelTotals = {};
    highLinks.forEach((l) => { labelTotals[l.label] = (labelTotals[l.label] || 0) + 1; });
    const labelSeen = {};
    highLinks.forEach((l) => {
      if (labelTotals[l.label] > 1) {
        labelSeen[l.label] = (labelSeen[l.label] || 0) + 1;
        l.label = `${l.label} (${labelSeen[l.label]}/${labelTotals[l.label]})`;
      }
    });
    const visibleLinks = highLinks.slice(0, MAX_VISIBLE_LINKS);
    const overflow = highLinks.length - visibleLinks.length;
    const total = headerRows.length;

    const pill = (level, n) =>
      `<span class="driskh-pill driskh-pill--${level} driskh-count driskh-count--${level}${n === 0 ? ' driskh-pill--zero' : ''}"><b>${n}</b> ${level}</span>`;

    const meterHtml = ['high', 'medium', 'low']
      .filter((level) => counts[level] > 0)
      .map((level) => `<i class="driskh-meter-seg driskh-meter-seg--${level}" style="flex:${counts[level]}"></i>`)
      .join('');

    const statsHtml =
      total > 0
        ? `
      <span class="driskh-summary-counts">
        ${pill('high', counts.high)}${pill('medium', counts.medium)}${pill('low', counts.low)}
      </span>
      <span class="driskh-total">${total} hunk${total === 1 ? '' : 's'} scanned</span>
      <span class="driskh-meter" role="img" aria-label="${counts.high} high, ${counts.medium} medium, ${counts.low} low risk hunks of ${total}">${meterHtml}</span>
      ${
        visibleLinks.length > 0
          ? `<span class="driskh-summary-jumps"><span class="driskh-jump-label">Jump to</span>
              ${visibleLinks
                .map(
                  (l) =>
                    `<button type="button" class="driskh-jump-chip" data-driskh-target="${l.id}" title="${escapeHtml(l.reason)}">${escapeHtml(l.label)}</button>`
                )
                .join('')}
              ${overflow > 0 ? `<span class="driskh-jump-overflow">+${overflow} more</span>` : ''}
            </span>`
          : `<span class="driskh-summary-clear">Nothing here looks high-risk</span>`
      }`
        : `<span class="driskh-summary-counts driskh-summary-counts--empty">Scanning hunks…</span>`;

    const nextHtml = `
      <span class="driskh-brand"><span class="driskh-brand-dot"></span>Diff Risk</span>
      ${statsHtml}
      <label class="driskh-switch" title="Show or hide risk highlighting">
        <input type="checkbox" class="driskh-toggle-input" />
        <span class="driskh-switch-track"></span>
        <span class="driskh-switch-label">Highlight</span>
      </label>
    `;

    // Rewriting innerHTML unconditionally would re-fire on every call even
    // when nothing actually changed (e.g. a rescan triggered by an
    // unrelated part of the page mutating) — skip the write, and the
    // reflow/paint that comes with it, when the content is identical.
    // Cached on the element, not in a closure: if React unmounts and
    // remounts the page, getOrCreateSummaryBar() makes a fresh, empty bar
    // and a closure-level cache would wrongly say "already rendered".
    //
    // The switch's checked state is deliberately NOT part of that HTML: if it
    // were, flipping it would change the HTML, re-render the bar, and replace
    // the very checkbox the user just clicked (dropping keyboard focus).
    // It's synced as a property instead.
    const syncToggle = () => {
      const box = bar.querySelector('.driskh-toggle-input');
      if (box) box.checked = enabled;
    };
    if (renderedHtml.get(bar) === nextHtml) {
      syncToggle();
      return;
    }
    renderedHtml.set(bar, nextHtml);
    bar.innerHTML = nextHtml;
    syncToggle();

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
    // Colors come from GitHub's own Primer CSS variables (so light, dark and
    // high-contrast themes all just work), with the light-theme hex as a
    // fallback if a variable is ever renamed.
    style.textContent = `
      :root {
        --driskh-high: var(--fgColor-danger, #cf222e);
        --driskh-high-bg: var(--bgColor-danger-muted, #ffebe9);
        --driskh-high-solid: var(--bgColor-danger-emphasis, #cf222e);
        --driskh-med: var(--fgColor-attention, #9a6700);
        --driskh-med-bg: var(--bgColor-attention-muted, #fff8c5);
        --driskh-med-solid: var(--bgColor-attention-emphasis, #bf8700);
        --driskh-low-solid: var(--borderColor-default, #d1d9e0);
        --driskh-muted: var(--fgColor-muted, #59636e);
      }

      /* left-edge stripe on every row of a flagged hunk (inset shadow, so it
         never changes layout) */
      .driskh-edge-high { box-shadow: inset 4px 0 0 0 var(--driskh-high-solid); }
      .driskh-edge-medium { box-shadow: inset 4px 0 0 0 var(--driskh-med-solid); }

      /* badge + explain button live in the hunk header's flex row */
      .driskh-badge {
        display: inline-flex;
        align-items: center;
        align-self: center;
        gap: 5px;
        margin-left: 10px;
        padding: 1px 8px 1px 6px;
        border-radius: 2em;
        font: 600 11px/18px var(--fontStack-system, -apple-system, 'Segoe UI', sans-serif);
        letter-spacing: 0.03em;
        cursor: default;
        white-space: nowrap;
      }
      .driskh-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
      .driskh-badge--high { background: var(--driskh-high-bg); color: var(--driskh-high); }
      .driskh-badge--medium { background: var(--driskh-med-bg); color: var(--driskh-med); }

      .driskh-explain-btn {
        align-self: center;
        margin-left: 8px;
        padding: 0 9px;
        border-radius: 2em;
        border: 1px solid var(--borderColor-default, #d1d9e0);
        background: var(--bgColor-default, #fff);
        color: var(--driskh-muted);
        font: 500 11px/18px var(--fontStack-system, -apple-system, 'Segoe UI', sans-serif);
        cursor: pointer;
        white-space: nowrap;
      }
      .driskh-explain-btn:hover:not(:disabled) { background: var(--bgColor-neutral-muted, #eaeef2); color: var(--fgColor-default, #1f2328); }
      .driskh-explain-btn:disabled { cursor: progress; opacity: 0.7; }
      .driskh-explanation {
        align-self: center;
        margin-left: 10px;
        max-width: 70ch;
        font: italic 12px/1.4 var(--fontStack-system, -apple-system, 'Segoe UI', sans-serif);
        color: var(--driskh-muted);
        white-space: normal;
      }

      .driskh-explain-error { color: var(--driskh-high); font-style: normal; }

      /* summary bar */
      #${SUMMARY_BAR_ID} {
        position: sticky;
        z-index: 10;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        margin-bottom: 12px;
        padding: 8px 14px;
        border: 1px solid var(--borderColor-default, #d1d9e0);
        border-radius: 8px;
        background: var(--bgColor-muted, #f6f8fa);
        color: var(--fgColor-default, #1f2328);
        font: 12px/1.4 var(--fontStack-system, -apple-system, 'Segoe UI', sans-serif);
        box-shadow: 0 1px 0 rgba(31, 35, 40, 0.04);
      }
      .driskh-brand { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13px; }
      .driskh-brand-dot {
        width: 10px; height: 10px; border-radius: 3px;
        background: linear-gradient(135deg, var(--driskh-high-solid) 0 50%, var(--driskh-med-solid) 50% 100%);
      }
      .driskh-summary-counts { display: inline-flex; gap: 6px; }
      .driskh-summary-counts--empty, .driskh-summary-clear, .driskh-total { color: var(--driskh-muted); }
      .driskh-pill {
        display: inline-flex; align-items: baseline; gap: 4px;
        padding: 1px 9px; border-radius: 2em; font-weight: 500;
      }
      .driskh-pill b { font-weight: 700; }
      .driskh-pill--high { background: var(--driskh-high-bg); color: var(--driskh-high); }
      .driskh-pill--medium { background: var(--driskh-med-bg); color: var(--driskh-med); }
      .driskh-pill--low { background: var(--bgColor-neutral-muted, #eaeef2); color: var(--driskh-muted); }
      .driskh-pill--zero { opacity: 0.55; }

      .driskh-meter {
        display: inline-flex; width: 72px; height: 8px; gap: 2px;
        border-radius: 4px; overflow: hidden;
      }
      .driskh-meter-seg { display: block; min-width: 4px; border-radius: 2px; }
      .driskh-meter-seg--high { background: var(--driskh-high-solid); }
      .driskh-meter-seg--medium { background: var(--driskh-med-solid); }
      .driskh-meter-seg--low { background: var(--driskh-low-solid); }

      .driskh-summary-jumps { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 5px; }
      .driskh-jump-label { color: var(--driskh-muted); }
      .driskh-jump-chip {
        padding: 0 8px; border-radius: 2em; cursor: pointer;
        border: 1px solid var(--driskh-high-solid);
        background: var(--driskh-high-bg); color: var(--driskh-high);
        font: 500 11px/18px var(--fontStack-monospace, ui-monospace, monospace);
      }
      .driskh-jump-chip:hover { background: var(--driskh-high-solid); color: var(--fgColor-onEmphasis, #fff); }
      .driskh-jump-overflow { color: var(--driskh-muted); }
      .driskh-jump-chip:focus-visible, .driskh-explain-btn:focus-visible,
      .driskh-switch input:focus-visible + .driskh-switch-track {
        outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: 2px;
      }

      /* toggle switch */
      .driskh-switch {
        margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
        color: var(--driskh-muted); cursor: pointer; user-select: none; -webkit-user-select: none;
      }
      .driskh-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
      .driskh-switch-track {
        position: relative; width: 28px; height: 16px; border-radius: 8px;
        background: var(--driskh-low-solid); transition: background 0.15s;
      }
      .driskh-switch-track::after {
        content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
        border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3);
        transition: transform 0.15s;
      }
      .driskh-switch input:checked + .driskh-switch-track { background: var(--bgColor-success-emphasis, #1f883d); }
      .driskh-switch input:checked + .driskh-switch-track::after { transform: translateX(12px); }

      /* Disabled: hide markers without discarding the data-driskh-* attributes,
         so re-enabling is instant (no re-scan) */
      html.driskh-disabled .driskh-edge-high,
      html.driskh-disabled .driskh-edge-medium { box-shadow: none; }
      html.driskh-disabled .driskh-badge,
      html.driskh-disabled .driskh-explain-btn,
      html.driskh-disabled .driskh-explanation,
      html.driskh-disabled .driskh-summary-counts,
      html.driskh-disabled .driskh-total,
      html.driskh-disabled .driskh-meter,
      html.driskh-disabled .driskh-summary-jumps,
      html.driskh-disabled .driskh-summary-clear { display: none; }
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

  function assessAndMark(hunk) {
    // GitHub emits a trailing "expand to end of file" boundary row after a
    // file's last hunk: same boundary cell, but no @@ header and no lines
    // under it. Counting it as a scanned hunk inflated the summary ("2 hunks"
    // on a 1-hunk PR). Requires zero rows so a real hunk is never skipped.
    if (hunk.rows.length === 0 && hunk.addedLines.length === 0 && hunk.removedLines.length === 0) {
      hunk.headerRow.dataset.driskhProcessed = 'true';
      return;
    }
    const result = DiffRiskEngine.assessHunk({
      filePath: hunk.filePath,
      addedLines: hunk.addedLines,
      removedLines: hunk.removedLines,
    });
    markHunk(hunk, result);
  }

  function processPage() {
    if (!isFilesChangedPage()) {
      // GitHub navigates between PR tabs without a full reload, and the
      // bar's parent can outlive the Files tab — don't leave it behind.
      document.getElementById(SUMMARY_BAR_ID)?.remove();
      return;
    }

    // Classic server-rendered table (see extractHunksFromFile) and
    // GitHub's React rewrite (see extractHunksFromNewDiffTable) use
    // disjoint selectors, so both are scanned unconditionally — whichever
    // one the current session actually renders is the one that matches.
    const newTables = document.querySelectorAll('table[aria-label^="Diff for: "]');
    const fileEls = document.querySelectorAll('.file[data-tagsearch-path]');
    if (newTables.length === 0 && fileEls.length === 0) return; // still loading

    injectStylesOnce();

    if (enabled) {
      for (const table of newTables) {
        const currentHunkCount = table.querySelectorAll('td.diff-hunk-cell').length;
        const lastHunkCount = Number(table.dataset.driskhHunkCount || 0);
        if (currentHunkCount === lastHunkCount) continue; // nothing new since last scan
        table.dataset.driskhHunkCount = String(currentHunkCount);

        const filePath =
          (table.getAttribute('aria-label') || '').replace(/^Diff for:\s*/, '') || '(unknown path)';
        for (const hunk of extractHunksFromNewDiffTable(table, filePath)) {
          if (hunk.headerRow.dataset.driskhProcessed) continue;
          assessAndMark(hunk);
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
          assessAndMark(hunk);
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

  // Read the saved on/off state only now that `observer` and `scheduleScan`
  // exist — setEnabled() calls runProcessPage(), which needs both.
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

  document.addEventListener('turbo:load', scheduleScan);
  document.addEventListener('turbo:frame-load', scheduleScan);

  observer.observe(document.documentElement, { childList: true, subtree: true });

  scheduleScan();
})();
