# Real-PR fixtures

Raw unified diffs (`gh pr diff <n> --repo <owner>/<repo>`) pulled from actual
merged, open-source pull requests on 2026-08-26, used to calibrate and
regression-test the risk engine against real messiness instead of invented
examples. Each file's respective upstream project's license applies to its
contents; these are used here solely as short, unmodified excerpts for
software testing purposes.

| File | Source PR | Why it's here |
|---|---|---|
| `vip_sqli.diff` | [virtual-imaging-platform/VIP-portal#698](https://github.com/virtual-imaging-platform/VIP-portal/pull/698) | Real SQL-injection fix: string-concatenated query → parameterized query |
| `partage_xss.diff` | [deltablot/partage#8](https://github.com/deltablot/partage/pull/8) | Real XSS fix via response headers; pure-addition hunk + new test file |
| `django_deadcode.diff` | [django/django#18925](https://github.com/django/django/pull/18925) | Removed a `try`/`except`/`else` block confirmed dead by the author — the exact "removed try/catch that's actually dead code" edge case |
| `pandas_deadcode.diff` | [pandas-dev/pandas#66045](https://github.com/pandas-dev/pandas/pull/66045) | Multiple files/hunks removing "genuinely-unreachable" conditional branches |
| `numpy_unreachable.diff` | [numpy/numpy#32143](https://github.com/numpy/numpy/pull/32143) | Removed an `if` branch the original author had marked `# TODO: this path can never be reached` |
| `django_rename.diff` | [django/django#21696](https://github.com/django/django/pull/21696) | `RAISE` → `FETCH_RAISE` renamed across ~15 files/hunks — the "renamed variable that looks like a logic change" edge case |
| `passcore_prettier.diff` | [EastCentralRegionalLibrary/passcore#150](https://github.com/EastCentralRegionalLibrary/passcore/pull/150) | Pure Prettier reformat of TSX — includes trailing-comma insertions, a good stress test for "formatting-only" detection |
| `alacritty_offbyone.diff` | [alacritty/alacritty#9027](https://github.com/alacritty/alacritty/pull/9027) | One-line off-by-one fix: `..` → `..=` in a Rust range bound |
| `requests_regression.diff` | [psf/requests#4052](https://github.com/psf/requests/pull/4052) | Tiny function-signature change: added a default parameter value |
| `flask_signature.diff` | [pallets/flask#5818](https://github.com/pallets/flask/pull/5818) | Large, genuinely complex signature-change PR with a deprecation-shim decorator — stress test, not asserted line-by-line |
| `django_feature.diff` | [django/django#16012](https://github.com/django/django/pull/16012) | Ordinary mixed-signal feature PR, used as a general smoke test |
| `squarelet_race.diff` | [MuckRock/squarelet#777](https://github.com/MuckRock/squarelet/pull/777) | Real race-condition fix — chosen deliberately as a likely **false negative**: the engine has no concurrency-bug heuristic at all |
| `cais_csrf.diff` | [puppe1990/cais#180](https://github.com/puppe1990/cais/pull/180) | Real CSRF cookie-prefix fix, a category not otherwise represented |
| `mglet_offbyone.diff` | [kmturbulenz/mglet-base#226](https://github.com/kmturbulenz/mglet-base/pull/226) | Off-by-one fix in Fortran array indexing via an *added* `- 1` term (not an operator swap) — the engine misses this; see README "How risk detection works" |
| `passkey_authbypass.diff` | [stellar/passkey-kit#4](https://github.com/stellar/passkey-kit/pull/4) | Real, established-project authorization-bypass fix with a big surface area (CHANGELOG, README, version bumps, contract code, tests) — good stress test for signal-to-noise on a genuinely security-focused PR |
| `stelinter_depbump.diff` | [Firelight-Innovations/STE-Linter#18](https://github.com/Firelight-Innovations/STE-Linter/pull/18) | Trivial CI dependency version bump — sanity check that routine housekeeping doesn't get over-flagged |
| `camconf_refactor.diff` | [MarekNajman/Cam-Conf-RPi-Prusa-Connect-Cam#2](https://github.com/MarekNajman/Cam-Conf-RPi-Prusa-Connect-Cam/pull/2) | PR explicitly titled "no functional changes" — tests whether a real refactor gets waved through or over-flagged |
