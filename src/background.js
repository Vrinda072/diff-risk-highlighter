// Diff Risk Highlighter: background service worker.
//
// Two jobs:
//   1. Run the optional "Explain" request. It lives here because a content
//      script's fetch() is subject to github.com's CSP, while a service
//      worker's is only limited by manifest host_permissions. The provider
//      logic itself is in explain.js (Ollama, Gemini or Anthropic).
//   2. Toolbar button: flip highlighting on and off.
//
// Nothing here runs a network request unless the user clicks "Explain".

importScripts('explain.js');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'driskh-explain') {
    chrome.storage.local
      .get(['driskhSettings', 'driskhApiKey'])
      .then((stored) => DriskhExplain.explain(DriskhExplain.resolveSettings(stored), message.hunk))
      .then(sendResponse)
      .catch((err) => sendResponse({ error: 'exception', message: 'Explain failed unexpectedly.', detail: String(err) }));
    return true; // keep the channel open for the async sendResponse
  }
  if (message && message.type === 'driskh-open-options') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

// Toolbar button: one click flips highlighting on/off. content.js already
// listens to chrome.storage.onChanged, so every open PR tab updates live.
const ENABLED_KEY = 'driskhEnabled';

function paintBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#6e7681' });
}

chrome.action.onClicked.addListener(async () => {
  const { [ENABLED_KEY]: current = true } = await chrome.storage.local.get(ENABLED_KEY);
  await chrome.storage.local.set({ [ENABLED_KEY]: !current });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[ENABLED_KEY]) paintBadge(changes[ENABLED_KEY].newValue !== false);
});

chrome.storage.local.get(ENABLED_KEY).then(({ [ENABLED_KEY]: v = true }) => paintBadge(v));
