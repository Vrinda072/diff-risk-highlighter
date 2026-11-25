# Privacy

Diff Risk Highlighter has no server, no account, no analytics and no tracking.

## What it reads
The diff text of GitHub pull request pages you open (`github.com/*/*/pull/*`).
Scoring happens in your browser.

## What it stores
In `chrome.storage.local`, on your computer only:
- whether highlighting is on;
- your Explain settings, including any API key you enter;
- flags you mark *Useful* or *Not useful*: the pull request path, file, the
  reason, your answer and up to 60 added and 60 removed lines of that hunk
  (500 entries at most). Export and clear them from the extension options.

## What it sends, and when
Nothing, unless you use Explain:
- Clicking **Explain** sends that hunk (file path, the reason it was flagged and
  its changed lines, cut off at 6,000 characters) to the provider you chose:
  Ollama on your own computer, Google (Gemini) or Anthropic.
- **Save and test** on the options page sends a short built-in sample, not your code.
- While Ollama is the selected provider, the options page asks your local Ollama
  which models are installed.

Google's free Gemini tier may use what you send to improve Google's products;
don't use it for private code. Each provider's own privacy terms apply to what
you send it.

## Permissions
- `storage`: the items listed above.
- Running on GitHub pull request pages: to read and mark the diff.
- Access to `api.anthropic.com`, `generativelanguage.googleapis.com` or your
  local Ollama is **optional**. It is not granted at install; Chrome asks when
  you save that provider.

## Removing your data
Use **Clear** for feedback, or remove the extension, which deletes everything it stored.
