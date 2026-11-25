# Changelog

## 1.2.0 (not yet released)

### Fixed
- Behavior changes were dismissed as harmless by the three shortcuts that run
  before every other check. C pointer writes, `#define`s and `#include`s counted
  as comments; Python dedents and edits inside strings counted as formatting;
  `canRead` to `canWrite` counted as a mechanical rename.
- Large hunks no longer freeze the page: line matching anchors on identical
  lines above 40,000 line pairs. Same results on 1,558 real hunks compared.
- Fewer false alarms: edited conditions are medium "changed a condition";
  Python imports and ORM calls no longer look like SQL; `@v3` to `@v4` and
  wildcard version bumps and package names are not flagged.
- `npm test` works on Node 24.
- The options page no longer contacts Ollama unless Ollama is selected.
- Low contrast on three options-page colors.

### Added
- Signature changes are compared parameter by parameter, including wrapped
  lists, and the reason says what changed ("added parameter ctx").
- `docs/ablation.md`: what each detector contributes on the development set.
- A strict TypeScript check of JSDoc types in CI. The engine is split into one
  file per concern.
- The badge is a button that shows its reason, usable by keyboard and screen readers.
- Useful / Not useful feedback, stored locally, exportable.
- The Explain button names the provider; provider access is optional and
  requested only when chosen.
- Offline browser tests, including the packaged ZIP, a weekly live-GitHub run,
  a release workflow and `scripts/measure-live.js`.
- A sealed held-out evaluation with a labelling page and scorer (`eval/`).

## 1.1.0
- Support for GitHub's React "Files changed" layout alongside the classic one.
- Redesigned summary bar and badges with dark mode; toolbar toggle; icons.
- Explain providers: Ollama (local, free), Gemini (free tier) and Anthropic.
