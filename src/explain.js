// "Explain" providers: turns one flagged hunk into a one-sentence explanation
// using Ollama (local, free), Google Gemini (free tier) or Anthropic (paid).
//
// Pure of chrome.* and the DOM on purpose: fetch is injected, so the request
// shapes and error handling are unit-tested in Node (test/explain.test.js).
// background.js loads this with importScripts().

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DriskhExplain = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    provider: '',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    geminiModel: 'gemini-2.5-flash-lite',
    anthropicModel: 'claude-haiku-4-5-20251001',
  };

  const MAX_DIFF_CHARS = 6000;

  function buildPrompt({ filePath, reason, addedLines, removedLines }) {
    let diff = [
      ...(removedLines || []).map((l) => `- ${l}`),
      ...(addedLines || []).map((l) => `+ ${l}`),
    ].join('\n');
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)';
    return (
      `A static heuristic flagged this diff hunk from "${filePath}" as high risk, ` +
      `because: ${reason}\n\n` +
      '```\n' + diff + '\n```\n\n' +
      'In one plain-English sentence, tell a code reviewer specifically what ' +
      'could go wrong in this hunk. Reference the actual code, not generic ' +
      'advice about the category of bug.'
    );
  }

  // Some local models ("thinking" models) emit their reasoning inline.
  function cleanText(text) {
    return String(text || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
  }

  async function readBody(response) {
    try {
      return (await response.text()).slice(0, 400);
    } catch (_) {
      return '';
    }
  }

  function fail(error, message, detail) {
    return { error, message, detail };
  }

  async function viaAnthropic(s, prompt, fetchImpl) {
    if (!s.anthropicKey) return fail('not-configured', 'Add your Anthropic API key in the extension options.');
    let res;
    try {
      res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': s.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: s.anthropicModel,
          max_tokens: 160,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (err) {
      return fail('network', "Couldn't reach api.anthropic.com. Check your connection.", String(err));
    }
    if (!res.ok) {
      if (res.status === 401) return fail('invalid-api-key', 'Anthropic rejected that API key.');
      if (res.status === 429) return fail('rate-limited', 'Anthropic rate limit hit. Try again in a minute.');
      return fail(`api-error-${res.status}`, `Anthropic returned an error (${res.status}).`, await readBody(res));
    }
    const data = await res.json();
    const text = cleanText(data && data.content && data.content[0] && data.content[0].text);
    return text ? { explanation: text } : fail('empty-response', 'Anthropic returned an empty answer.');
  }

  async function viaGemini(s, prompt, fetchImpl) {
    if (!s.geminiKey) return fail('not-configured', 'Add your free Gemini API key in the extension options.');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // Generous limit: models that "think" spend some of it before answering.
          generationConfig: { maxOutputTokens: 512, temperature: 0.2 },
        }),
      });
    } catch (err) {
      return fail('network', "Couldn't reach Google's Gemini API. Check your connection.", String(err));
    }
    if (!res.ok) {
      const body = await readBody(res);
      if (res.status === 401 || res.status === 403 || /API key not valid|API_KEY_INVALID/i.test(body)) {
        return fail('invalid-api-key', 'Gemini rejected that API key.', body);
      }
      if (res.status === 429) return fail('rate-limited', 'Gemini free-tier rate limit hit. Try again in a minute.', body);
      if (res.status === 404) {
        return fail('model-not-found', `Gemini doesn't know the model "${s.geminiModel}". Pick a current one in the options.`, body);
      }
      return fail(`api-error-${res.status}`, `Gemini returned an error (${res.status}).`, body);
    }
    const data = await res.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = cleanText(parts.map((p) => p.text || '').join(''));
    if (text) return { explanation: text };
    const why = data && data.candidates && data.candidates[0] && data.candidates[0].finishReason;
    return fail('empty-response', `Gemini returned no text${why ? ` (${why})` : ''}.`);
  }

  async function viaOllama(s, prompt, fetchImpl) {
    const base = String(s.ollamaUrl || DEFAULTS.ollamaUrl).replace(/\/+$/, '');
    let res;
    try {
      res = await fetchImpl(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: s.ollamaModel,
          stream: false,
          think: false,
          messages: [{ role: 'user', content: prompt }],
          options: { temperature: 0.2, num_predict: 200 },
        }),
      });
    } catch (err) {
      return fail('network', `Can't reach Ollama at ${base}. Is it running?`, String(err));
    }
    if (!res.ok) {
      const body = await readBody(res);
      if (res.status === 403) {
        return fail(
          'forbidden',
          'Ollama refused the request. Restart it with OLLAMA_ORIGINS="chrome-extension://*" (see the extension options).',
          body
        );
      }
      if (res.status === 404 || /not found/i.test(body)) {
        return fail('model-not-found', `Ollama doesn't have "${s.ollamaModel}". Run: ollama pull ${s.ollamaModel}`, body);
      }
      return fail(`api-error-${res.status}`, `Ollama returned an error (${res.status}).`, body);
    }
    const data = await res.json();
    const text = cleanText(data && data.message && data.message.content);
    return text ? { explanation: text } : fail('empty-response', 'Ollama returned an empty answer.');
  }

  // `stored` is whatever is in chrome.storage.local: the new `driskhSettings`
  // object, plus the legacy `driskhApiKey` from when Anthropic was the only
  // option (kept working so nobody has to re-enter it).
  function resolveSettings(stored) {
    const s = { ...DEFAULTS, ...((stored && stored.driskhSettings) || {}) };
    if (!s.provider && stored && stored.driskhApiKey) {
      s.provider = 'anthropic';
      s.anthropicKey = s.anthropicKey || stored.driskhApiKey;
    }
    return s;
  }

  async function explain(settings, hunk, fetchImpl) {
    const s = { ...DEFAULTS, ...settings };
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    if (!s.provider) {
      return fail('not-configured', 'Choose how Explain should work in the extension options (Ollama and Gemini are free).');
    }
    const prompt = buildPrompt(hunk);
    if (s.provider === 'ollama') return viaOllama(s, prompt, doFetch);
    if (s.provider === 'gemini') return viaGemini(s, prompt, doFetch);
    if (s.provider === 'anthropic') return viaAnthropic(s, prompt, doFetch);
    return fail('not-configured', `Unknown provider "${s.provider}". Pick one in the extension options.`);
  }

  return { DEFAULTS, buildPrompt, cleanText, resolveSettings, explain };
});
