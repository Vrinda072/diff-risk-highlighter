# Real-PR fixtures

Raw unified diffs (`gh pr diff <n> --repo <owner>/<repo>`) from actual
merged, open-source pull requests, used to calibrate and regression-test
the risk engine against real messiness instead of invented examples.
Each file's respective upstream project's license applies to its
contents (recorded per fixture in `metadata.json`); these are used here
solely as short, unmodified excerpts for software testing purposes.

The first 17 were picked by hand on 2026-08-26. The other 25 were
collected on 2026-09-26 with `scripts/fetch-fixtures.js`, 5 per bug
category, then read and vetted by hand.

## `metadata.json`

One entry per fixture: repo, PR number and URL, title, **category**,
a one-line summary, the upstream license (SPDX id as GitHub reports it),
merge and fetch dates, and **`fixHunks`**. `fixHunks` lists the hunks that
carry the change the category is about, by file path and `@@ … @@` header:
the actual fix, the weakened assertion, the changed signature. It's
empty for categories with no such hunk (`refactor`, `feature`,
`dependency-bump`). For a refactor, *every* hunk should score low.

`fixHunks` is filled in by a person reading the diff, not inferred.
`test/fixtures-metadata.test.js` (part of `npm test`) checks that every
diff has exactly one entry and that every listed fix hunk exists in its
diff.

## Adding fixtures

1. **Search**: writes nothing under `test/`. It searches merged PRs in
   public repos per category and drops PRs over 30 changed files, repos
   under 50 stars, archived repos, forks, and PRs already used here:
   ```bash
   node scripts/fetch-fixtures.js search --out candidates.json --limit 100
   ```
2. **Vet** candidates by reading their diffs. Titles lie: e.g.
   knowm/XChange#2606, titled "no functional change", renames an HTTP
   header, which is a behavior change.
3. **Record** the picks, with their `fixHunks`, in
   `scripts/fixtures-manifest.json`.
4. **Fetch**: downloads new diffs, reuses existing ones (`--refresh` to
   re-download), fails if a listed fix hunk isn't in the diff, and
   rewrites `metadata.json`:
   ```bash
   node scripts/fetch-fixtures.js fetch scripts/fixtures-manifest.json
   ```

## Fixtures by category

### Off-by-one fixes

| File | Source PR | Why it's here |
|---|---|---|
| `alacritty_offbyone.diff` | [alacritty/alacritty#9027](https://github.com/alacritty/alacritty/pull/9027) | One-line off-by-one fix: `..` → `..=` in a Rust range bound |
| `mglet_offbyone.diff` | [kmturbulenz/mglet-base#226](https://github.com/kmturbulenz/mglet-base/pull/226) | Off-by-one fix in Fortran array indexing via an *added* `- 1` term (not an operator swap). The engine misses this; see README "How risk detection works" |
| `nextjs_offbyone.diff` | [vercel/next.js#93524](https://github.com/vercel/next.js/pull/93524) | Rust inline-string length checks `<` → `<=` (and `>=` → `>`) in 5 places; operator-swap shape |
| `moltenvk_offbyone.diff` | [KhronosGroup/MoltenVK#2602](https://github.com/KhronosGroup/MoltenVK/pull/2602) | Objective-C++ one-liner, `<` → `<=` on a descriptor-count limit |
| `renewables_offbyone.diff` | [microsoft/global-renewables-watch#12](https://github.com/microsoft/global-renewables-watch/pull/12) | Python random-crop bounds gain `+ 1`; added-token shape, like mglet |
| `dill_offbyone.diff` | [uqfoundation/dill#651](https://github.com/uqfoundation/dill/pull/651) | Python `range(1, lbuf)` → `range(1, lbuf+1)`; added-token shape |
| `franzgo_offbyone.diff` | [twmb/franz-go#381](https://github.com/twmb/franz-go/pull/381) | Go: a stray `+ 1` *removed* from a sequence-number calculation |

### Race-condition fixes

| File | Source PR | Why it's here |
|---|---|---|
| `squarelet_race.diff` | [MuckRock/squarelet#777](https://github.com/MuckRock/squarelet/pull/777) | Real race-condition fix, chosen deliberately as a likely **false negative**: the engine has no concurrency-bug heuristic at all |
| `spp_race.diff` | [esrrhs/spp#52](https://github.com/esrrhs/spp/pull/52) | Go: plain read/write → `atomic.LoadInt64`/`StoreInt64` |
| `nats_race.diff` | [nats-io/nats-server#8647](https://github.com/nats-io/nats-server/pull/8647) | Go check-then-act: a map lookup moved inside the existing `RLock` |
| `redisearch_race.diff` | [RediSearch/RediSearch#11547](https://github.com/RediSearch/RediSearch/pull/11547) | C: thread-startup flags `volatile bool` → `atomic_bool` |
| `pdns_race.diff` | [PowerDNS/pdns#18066](https://github.com/PowerDNS/pdns/pull/18066) | C++: shared cookie secrets wrapped in `LockGuarded<>`, every access locked |
| `nuke_race.diff` | [kean/Nuke#998](https://github.com/kean/Nuke/pull/998) | Swift: `nonisolated(unsafe)` property put behind `OSAllocatedUnfairLock`, plus CHANGELOG and test |

### Auth/security fixes

| File | Source PR | Why it's here |
|---|---|---|
| `vip_sqli.diff` | [virtual-imaging-platform/VIP-portal#698](https://github.com/virtual-imaging-platform/VIP-portal/pull/698) | Real SQL-injection fix: string-concatenated query → parameterized query |
| `partage_xss.diff` | [deltablot/partage#8](https://github.com/deltablot/partage/pull/8) | Real XSS fix via response headers; pure-addition hunk + new test file |
| `cais_csrf.diff` | [puppe1990/cais#180](https://github.com/puppe1990/cais/pull/180) | Real CSRF cookie-prefix fix, a category not otherwise represented |
| `passkey_authbypass.diff` | [stellar/passkey-kit#4](https://github.com/stellar/passkey-kit/pull/4) | Real, established-project authorization-bypass fix with a big surface area (CHANGELOG, README, version bumps, contract code, tests). A good stress test for signal-to-noise on a genuinely security-focused PR |
| `openrelik_authbypass.diff` | [openrelik/openrelik-server#229](https://github.com/openrelik/openrelik-server/pull/229) | Python: `if folder_id:` → `is not None`, so `folder_id=0` no longer skips the access check. No security vocabulary on the changed line |
| `arkime_authbypass.diff` | [arkime/arkime#4263](https://github.com/arkime/arkime/pull/4263) | JS one-liner: a route's permission list gains two permissions |
| `orchard_missingauthz.diff` | [OrchardCMS/OrchardCore#19914](https://github.com/OrchardCMS/OrchardCore/pull/19914) | C#: missing `AuthorizeAsync`/`Forbid()` guards added |
| `dolibarr_idor.diff` | [Dolibarr/dolibarr#40406](https://github.com/Dolibarr/dolibarr/pull/40406) | PHP IDOR (a CVE-fix bypass): source object's project authorized before cloning |
| `edubadges_idor.diff` | [edubadges/edubadges-server#386](https://github.com/edubadges/edubadges-server/pull/386) | Django IDOR: lookup scoped to `request.user` + an object-ownership permission class |

### Weakened or removed test assertions

| File | Source PR | Why it's here |
|---|---|---|
| `weaviate_removedassert.diff` | [weaviate/weaviate#11801](https://github.com/weaviate/weaviate/pull/11801) | Go: three `assert.True(...)` lines removed as flaky |
| `authentik_removedassert.diff` | [goauthentik/authentik#13371](https://github.com/goauthentik/authentik/pull/13371) | Python: assertions that a *session key is cleared* removed from an auth-stage test |
| `jaxopt_loosenedassert.diff` | [google/jaxopt#642](https://github.com/google/jaxopt/pull/642) | Python: tolerance loosened `1e-3` → `1.5e-3` |
| `apm_loosenedassert.diff` | [elastic/apm-agent-python#2636](https://github.com/elastic/apm-agent-python/pull/2636) | Python: `0 < x < 1` → `x > 0` (upper bound dropped) |
| `awssdk_loosenedassert.diff` | [aws/aws-sdk-js-v3#8212](https://github.com/aws/aws-sdk-js-v3/pull/8212) | TypeScript: exact path assertion replaced by a regex |

### Pure refactors/renames (negatives: every hunk should be low)

| File | Source PR | Why it's here |
|---|---|---|
| `django_rename.diff` | [django/django#21696](https://github.com/django/django/pull/21696) | `RAISE` → `FETCH_RAISE` renamed across ~15 files/hunks, the "renamed variable that looks like a logic change" edge case |
| `passcore_prettier.diff` | [EastCentralRegionalLibrary/passcore#150](https://github.com/EastCentralRegionalLibrary/passcore/pull/150) | Pure Prettier reformat of TSX, including trailing-comma insertions; a good stress test for "formatting-only" detection |
| `camconf_refactor.diff` | [MarekNajman/Cam-Conf-RPi-Prusa-Connect-Cam#2](https://github.com/MarekNajman/Cam-Conf-RPi-Prusa-Connect-Cam/pull/2) | PR explicitly titled "no functional changes"; tests whether a real refactor gets waved through or over-flagged |
| `qgis_rename.diff` | [qgis/QGIS#39344](https://github.com/qgis/QGIS/pull/39344) | C++ static-variable rename |
| `flutter_rename.diff` | [flutter/devtools#1282](https://github.com/flutter/devtools/pull/1282) | Dart class rename across 7 files |
| `verilator_rename.diff` | [verilator/verilator#4461](https://github.com/verilator/verilator/pull/4461) | C++ field/accessor rename with one line re-wrapped |
| `vespa_rename.diff` | [vespa-engine/vespa#26180](https://github.com/vespa-engine/vespa/pull/26180) | Java method/field renames plus a TODO comment |
| `openroad_rename.diff` | [The-OpenROAD-Project/OpenROAD#8475](https://github.com/The-OpenROAD-Project/OpenROAD/pull/8475) | **Edge case:** "no functional change" rename that also changes a user-visible log string and its golden test output |

### Other categories (original set)

| File | Category | Source PR | Why it's here |
|---|---|---|---|
| `django_deadcode.diff` | dead-code-removal | [django/django#18925](https://github.com/django/django/pull/18925) | Removed a `try`/`except`/`else` block confirmed dead by the author: the exact "removed try/catch that's actually dead code" edge case |
| `pandas_deadcode.diff` | dead-code-removal | [pandas-dev/pandas#66045](https://github.com/pandas-dev/pandas/pull/66045) | Multiple files/hunks removing "genuinely-unreachable" conditional branches |
| `numpy_unreachable.diff` | dead-code-removal | [numpy/numpy#32143](https://github.com/numpy/numpy/pull/32143) | Removed an `if` branch the original author had marked `# TODO: this path can never be reached` |
| `requests_regression.diff` | signature-change | [psf/requests#4052](https://github.com/psf/requests/pull/4052) | Tiny function-signature change: added a default parameter value |
| `flask_signature.diff` | signature-change | [pallets/flask#5818](https://github.com/pallets/flask/pull/5818) | Large, genuinely complex signature-change PR with a deprecation-shim decorator; a stress test, not asserted line-by-line |
| `django_feature.diff` | feature | [django/django#16012](https://github.com/django/django/pull/16012) | Ordinary mixed-signal feature PR, used as a general smoke test |
| `stelinter_depbump.diff` | dependency-bump | [Firelight-Innovations/STE-Linter#18](https://github.com/Firelight-Innovations/STE-Linter/pull/18) | Trivial CI dependency version bump; a sanity check that routine housekeeping doesn't get over-flagged |
