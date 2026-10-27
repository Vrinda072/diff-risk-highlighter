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
      hint.textContent = "(can't reach Ollama right now)";
    }
  }

  async function save() {
    const settings = readForm();
    if (!settings.provider) {
      say('Pick a provider first.', 'err');
      return false;
    }
    await chrome.storage.local.set({ driskhSettings: settings });
    say('Saved.', 'ok');
    return true;
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
  load();
})();
