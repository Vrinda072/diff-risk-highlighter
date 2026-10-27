// Explain providers (src/explain.js). fetch is faked, so this checks the exact
// request each provider is sent and how every failure is reported, with no
// network and no API keys.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, buildPrompt, cleanText, resolveSettings, explain } = require('../src/explain.js');

const HUNK = {
  filePath: 'app/db.py',
  reason: 'Touches SQL query construction.',
  removedLines: ['cur.execute("SELECT 1")'],
  addedLines: ['cur.execute("SELECT " + x)'],
};

function fakeFetch(status, body, { text } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (text !== undefined ? text : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}
const throwingFetch = () => async () => {
  throw new TypeError('Failed to fetch');
};

describe('settings', () => {
  it('has no provider until the user picks one', async () => {
    const res = await explain({}, HUNK, fakeFetch(200, {}));
    assert.equal(res.error, 'not-configured');
    assert.match(res.message, /options/i);
  });

  it('keeps a legacy driskhApiKey working as the Anthropic provider', () => {
    const s = resolveSettings({ driskhApiKey: 'sk-old' });
    assert.equal(s.provider, 'anthropic');
    assert.equal(s.anthropicKey, 'sk-old');
  });

  it('prefers the new settings object over the legacy key', () => {
    const s = resolveSettings({ driskhApiKey: 'sk-old', driskhSettings: { provider: 'ollama' } });
    assert.equal(s.provider, 'ollama');
  });

  it('rejects an unknown provider instead of guessing', async () => {
    const res = await explain({ provider: 'nope' }, HUNK, fakeFetch(200, {}));
    assert.equal(res.error, 'not-configured');
  });
});

describe('prompt', () => {
  it('names the file, the heuristic reason and both sides of the diff', () => {
    const p = buildPrompt(HUNK);
    assert.match(p, /app\/db\.py/);
    assert.match(p, /Touches SQL query construction/);
    assert.match(p, /- cur\.execute\("SELECT 1"\)/);
    assert.match(p, /\+ cur\.execute\("SELECT " \+ x\)/);
  });

  it('truncates a huge hunk so small local models are not flooded', () => {
    const p = buildPrompt({ ...HUNK, addedLines: Array(2000).fill('x'.repeat(40)) });
    assert.match(p, /\(truncated\)/);
    assert.ok(p.length < 8000);
  });

  it('strips inline <think> blocks that reasoning models emit', () => {
    assert.equal(cleanText('<think>hmm\nlet me see</think>\nThe query is injectable.'), 'The query is injectable.');
  });
});

describe('ollama (free, local)', () => {
  const settings = { provider: 'ollama', ollamaModel: 'qwen3', ollamaUrl: 'http://localhost:11434/' };

  it('posts a non-streaming chat request with thinking off', async () => {
    const f = fakeFetch(200, { message: { content: 'Name is concatenated into SQL.' } });
    const res = await explain(settings, HUNK, f);
    assert.deepEqual(res, { explanation: 'Name is concatenated into SQL.' });
    const [call] = f.calls;
    assert.equal(call.url, 'http://localhost:11434/api/chat'); // trailing slash tolerated
    assert.equal(call.body.model, 'qwen3');
    assert.equal(call.body.stream, false);
    assert.equal(call.body.think, false);
    assert.equal(call.body.messages[0].role, 'user');
    assert.equal(call.init.headers['x-api-key'], undefined, 'no credentials go to a local server');
  });

  it('uses the default address and model when none are saved', async () => {
    const f = fakeFetch(200, { message: { content: 'ok' } });
    await explain({ provider: 'ollama' }, HUNK, f);
    assert.equal(f.calls[0].url, `${DEFAULTS.ollamaUrl}/api/chat`);
    assert.equal(f.calls[0].body.model, DEFAULTS.ollamaModel);
  });

  it('says Ollama is not running when the connection fails', async () => {
    const res = await explain(settings, HUNK, throwingFetch());
    assert.equal(res.error, 'network');
    assert.match(res.message, /Can't reach Ollama/);
  });

  it('explains the OLLAMA_ORIGINS fix on a 403', async () => {
    const res = await explain(settings, HUNK, fakeFetch(403, {}, { text: 'forbidden' }));
    assert.equal(res.error, 'forbidden');
    assert.match(res.message, /OLLAMA_ORIGINS/);
  });

  it('tells you how to pull a missing model', async () => {
    const res = await explain(settings, HUNK, fakeFetch(404, {}, { text: '{"error":"model \\"qwen3\\" not found"}' }));
    assert.equal(res.error, 'model-not-found');
    assert.match(res.message, /ollama pull qwen3/);
  });

  it('reports an empty answer instead of showing a blank note', async () => {
    const res = await explain(settings, HUNK, fakeFetch(200, { message: { content: '<think>only thoughts</think>' } }));
    assert.equal(res.error, 'empty-response');
  });
});

describe('gemini (free tier)', () => {
  const settings = { provider: 'gemini', geminiKey: 'AIzaTEST', geminiModel: 'gemini-2.5-flash-lite' };
  const OK = { candidates: [{ content: { parts: [{ text: 'The ' }, { text: 'name is injectable.' }] } }] };

  it('calls generateContent with the key in a header, never in the URL', async () => {
    const f = fakeFetch(200, OK);
    const res = await explain(settings, HUNK, f);
    assert.deepEqual(res, { explanation: 'The name is injectable.' }); // parts are joined
    const [call] = f.calls;
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    assert.ok(!call.url.includes('AIzaTEST'), 'key must not appear in the URL');
    assert.equal(call.init.headers['x-goog-api-key'], 'AIzaTEST');
    assert.equal(call.body.contents[0].parts[0].text, buildPrompt(HUNK));
    assert.ok(call.body.generationConfig.maxOutputTokens >= 256, 'room for thinking models');
  });

  it('asks for a key when none is saved', async () => {
    const res = await explain({ provider: 'gemini' }, HUNK, fakeFetch(200, OK));
    assert.equal(res.error, 'not-configured');
    assert.match(res.message, /Gemini/);
  });

  it('recognises an invalid key (Google answers 400 with API_KEY_INVALID)', async () => {
    const res = await explain(settings, HUNK, fakeFetch(400, {}, { text: '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid."}}' }));
    assert.equal(res.error, 'invalid-api-key');
  });

  it('reports the free-tier rate limit clearly', async () => {
    const res = await explain(settings, HUNK, fakeFetch(429, {}, { text: 'RESOURCE_EXHAUSTED' }));
    assert.equal(res.error, 'rate-limited');
    assert.match(res.message, /rate limit/i);
  });

  it('points at the options when the model name has been retired', async () => {
    const res = await explain(settings, HUNK, fakeFetch(404, {}, { text: 'models/x is not found' }));
    assert.equal(res.error, 'model-not-found');
    assert.match(res.message, /gemini-2\.5-flash-lite/);
  });

  it('includes the finish reason when the model returns no text', async () => {
    const res = await explain(settings, HUNK, fakeFetch(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }));
    assert.equal(res.error, 'empty-response');
    assert.match(res.message, /MAX_TOKENS/);
  });

  it('survives a network failure', async () => {
    const res = await explain(settings, HUNK, throwingFetch());
    assert.equal(res.error, 'network');
  });
});

describe('anthropic (paid)', () => {
  const settings = { provider: 'anthropic', anthropicKey: 'sk-ant-TEST' };

  it('sends the key and version headers and reads content[0].text', async () => {
    const f = fakeFetch(200, { content: [{ text: 'Injectable.' }] });
    const res = await explain(settings, HUNK, f);
    assert.deepEqual(res, { explanation: 'Injectable.' });
    const [call] = f.calls;
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.init.headers['x-api-key'], 'sk-ant-TEST');
    assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.body.model, DEFAULTS.anthropicModel);
  });

  it('reports a rejected key', async () => {
    const res = await explain(settings, HUNK, fakeFetch(401, {}));
    assert.equal(res.error, 'invalid-api-key');
  });

  it('asks for a key when none is saved', async () => {
    const res = await explain({ provider: 'anthropic' }, HUNK, fakeFetch(200, {}));
    assert.equal(res.error, 'not-configured');
  });
});
