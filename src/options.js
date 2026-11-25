// Options page for "Explain": pick Ollama, Gemini or Anthropic and save the
// settings that explain.js reads. Extension pages can't use inline scripts,
// so this lives in its own file.

(function () {
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['ollamaUrl', 'ollamaModel', 'geminiKey', 'geminiModel', 'anthropicKey', 'anthropicModel'];
  const SAMPLE_HUNK = {
    filePath: 'app/db.py',
    reason: 'Touches SQL query construction via string concatenation.',
    removedLines: ['    cur.execute("SELECT * FROM users WHERE name = ?", (name,))'],
    addedLines: ['    cur.execute("SELECT * FROM users WHERE name = \'" + name + "\'")'],
  };

  const status = $('status');
  function say(text, kind) {
    status.textContent = text;
    status.className = kind || '';
  }

  function selectedProvider() {
    const checked = document.querySelector('input[name="provider"]:checked');
    return checked ? checked.value : '';
  }

  function readForm() {
    const settings = { provider: selectedProvider() };
    for (const id of FIELDS) {
      const v = $(id).value.trim();
      if (v) settings[id] = v;
    }
    return settings;
  }

  function fillForm(s) {
    for (const id of FIELDS) $(id).value = s[id] || '';
    const radio = document.querySelector(`input[name="provider"][value="${s.provider}"]`);
    if (radio) radio.checked = true;
  }

  async function load() {
    const stored = await chrome.storage.local.get(['driskhSettings', 'driskhApiKey']);
    const s = DriskhExplain.resolveSettings(stored);
    fillForm(s);
    refreshOllamaModels();
  }

  async function refreshOllamaModels() {
    const hint = $('ollamaHint');
    const base = ($('ollamaUrl').value.trim() || DriskhExplain.DEFAULTS.ollamaUrl).replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/api/tags`);
      if (res.status === 403) {
        hint.textContent = '(Ollama is running but blocking extensions: see first-time setup)';
        return;
      }
      const data = await res.json();
      const names = (data.models || []).map((m) => m.name);
      $('ollamaModels').replaceChildren(
        ...names.map((n) => Object.assign(document.createElement('option'), { value: n }))
      );
      hint.textContent = names.length ? `(installed: ${names.join(', ')})` : '(no models installed yet)';
    } catch (_) {
      hint.textContent = "(can't reach Ollama: is it running, with OLLAMA_ORIGINS set? See first-time setup)";
    }
  }

  async function save() {
    const settings = readForm();
    if (!settings.provider) {
      say('Pick a provider first.', 'err');
      return false;
    }
    // Must be the first await: Chrome only shows the permission prompt while it
    // can still tie it to this click.
    const origin = DriskhExplain.originFor(settings);
    const granted = origin ? await chrome.permissions.request({ origins: [origin] }).catch(() => false) : true;
    await chrome.storage.local.set({ driskhSettings: settings });
    if (!granted) {
      say('Saved, but access was not allowed, so Explain cannot reach this provider. Press Save again to allow it.', 'err');
      return false;
    }
    say('Saved.', 'ok');
    if (settings.provider === 'ollama') refreshOllamaModels(); // access may have just been granted
    return true;
  }

  // Feedback marked on pull requests. It never leaves the browser unless the
  // user exports it.
  const FEEDBACK_KEY = 'driskhFeedback';

  async function readFeedback() {
    const stored = await chrome.storage.local.get({ [FEEDBACK_KEY]: [] });
    return stored[FEEDBACK_KEY] || [];
  }

  async function showFeedbackCount() {
    const items = await readFeedback();
    const useful = items.filter((f) => f.verdict === 'useful').length;
    $('feedbackCount').textContent = items.length
      ? `${items.length} saved on this computer: ${useful} useful, ${items.length - useful} not useful.`
      : 'Nothing saved yet. Press a HIGH or MEDIUM badge on a pull request to mark it.';
    $('exportFeedback').disabled = $('clearFeedback').disabled = items.length === 0;
  }

  async function exportFeedback() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), feedback: await readFeedback() }, null, 2)], {
      type: 'application/json',
    });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'diff-risk-feedback.json' });
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function clearFeedback() {
    if (!confirm('Delete all saved feedback from this browser?')) return;
    await chrome.storage.local.remove(FEEDBACK_KEY);
    showFeedbackCount();
  }

  async function saveAndTest() {
    if (!(await save())) return;
    const buttons = [$('save'), $('test')];
    buttons.forEach((b) => (b.disabled = true));
    say('Asking the model…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'driskh-explain', hunk: SAMPLE_HUNK });
      if (res && res.explanation) say(`It works: "${res.explanation}"`, 'ok');
      else say((res && res.message) || 'No answer came back.', 'err');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  $('save').addEventListener('click', save);
  $('test').addEventListener('click', saveAndTest);
  $('ollamaUrl').addEventListener('change', refreshOllamaModels);
  $('exportFeedback').addEventListener('click', exportFeedback);
  $('clearFeedback').addEventListener('click', clearFeedback);
  load();
  showFeedbackCount();
})();
