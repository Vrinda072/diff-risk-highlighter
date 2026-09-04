// Diff Risk Highlighter — background service worker (Milestone 5: optional
// LLM explanations)
//
// This exists for one reason: a content script's fetch() is subject to the
// CSP of the page it's injected into (github.com's, in this case), which
// commonly blocks requests to third-party API hosts. A background service
// worker's fetch() is not — it's an extension-privileged context, and as
// long as the target host is declared in manifest.json's host_permissions,
// the request goes through regardless of GitHub's own CSP.
//
// Everything else — whether to show the button, what to do with the
// result, asking for an API key — lives in content.js. This file only
// ever runs when the user clicks "Explain" on a high-risk hunk; nothing
// here executes otherwise, and the rest of the extension works with zero
// API key configured.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

async function explainHunk({ filePath, reason, addedLines, removedLines }) {
  const { driskhApiKey } = await chrome.storage.local.get('driskhApiKey');
  if (!driskhApiKey) {
    return { error: 'no-api-key' };
  }

  const diffText = [
    ...removedLines.map((l) => `- ${l}`),
    ...addedLines.map((l) => `+ ${l}`),
  ].join('\n');

  const prompt =
    `A static heuristic flagged this diff hunk from "${filePath}" as high risk, ` +
    `because: ${reason}\n\n` +
    '```\n' +
    `${diffText}\n` +
    '```\n\n' +
    'In one plain-English sentence, tell a code reviewer specifically what ' +
    'could go wrong in this hunk. Reference the actual code, not generic ' +
    'advice about the category of bug.';

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': driskhApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return { error: 'network', detail: String(err) };
  }

  if (!response.ok) {
    if (response.status === 401) return { error: 'invalid-api-key' };
    const bodyText = await response.text().catch(() => '');
    return { error: `api-error-${response.status}`, detail: bodyText.slice(0, 300) };
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text?.trim();
  return text ? { explanation: text } : { error: 'empty-response' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'driskh-explain') return false;
  explainHunk(message.hunk)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: 'exception', detail: String(err) }));
  return true; // keep the message channel open for the async sendResponse above
});
