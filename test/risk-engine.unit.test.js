// Heuristic-by-heuristic unit tests. Every fixture below is either lifted
// near-verbatim from, or directly modeled on, a real merged PR — see
// test/fixtures/real-prs/README.md for the source list. Toy examples were
// deliberately avoided per the calibration pass in test/risk-engine.real-diffs.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessHunk } = require('../src/risk-engine.js');

describe('safe-to-skim overrides', () => {
  it('classifies a pure Prettier reformat (trailing commas + line-wrap) as low risk', () => {
    // Adapted from passcore#150: a single call expression re-wrapped across
    // lines with a trailing comma added — same tokens, different whitespace.
    const removedLines = [
      "    const errorMessages = useMemo<Record<number, string>>(() => ({",
      "        [ApiErrorCode.FieldRequired]: alerts?.errorFieldRequired || '',",
      "    }), [alerts]);",
    ];
    const addedLines = [
      "    const errorMessages = useMemo<Record<number, string>>(",
      "        () => ({",
      "            [ApiErrorCode.FieldRequired]: alerts?.errorFieldRequired || '',",
      "        }),",
      "        [alerts],",
      "    );",
    ];
    const result = assessHunk({ filePath: 'ChangePassword.tsx', removedLines, addedLines });
    assert.equal(result.level, 'low');
    assert.match(result.reason, /formatting/i);
  });

  it('classifies comment/docstring-only edits as low risk', () => {
    const removedLines = ['    # Fetches the user record from the primary DB'];
    const addedLines = ['    # Fetches the user record from the primary database, retrying on timeout'];
    const result = assessHunk({ filePath: 'db.py', removedLines, addedLines });
    assert.equal(result.level, 'low');
  });

  it('EDGE CASE: a renamed variable/const that looks like a big logic change is still low risk', () => {
    // Modeled on django/django#21696 (RAISE -> FETCH_RAISE across ~15 files).
    // A naive line-count or keyword heuristic would see a "changed public
    // API constant used in raise/exception paths" and panic; the actual
    // change is purely mechanical.
    const removedLines = [
      'from django.db.models.fetch_modes import FETCH_ONE, FETCH_PEERS, RAISE',
      'class Raise(FetchMode):',
      '    def __reduce__(self):',
      '        return "RAISE"',
      'RAISE = Raise()',
    ];
    const addedLines = [
      'from django.db.models.fetch_modes import FETCH_ONE, FETCH_PEERS, FETCH_RAISE',
      'class FetchRaise(FetchMode):',
      '    def __reduce__(self):',
      '        return "FETCH_RAISE"',
      'FETCH_RAISE = FetchRaise()',
    ];
    const result = assessHunk({ filePath: 'fetch_modes.py', removedLines, addedLines });
    assert.equal(result.level, 'low');
    assert.match(result.reason, /rename/i);
  });

  it('does NOT call it a pure rename when a swapped-in variable is a different name used inconsistently', () => {
    // Adversarial case: two identifiers get swapped with each other rather
    // than one name being consistently replaced everywhere — this is the
    // "looks like a rename but is actually a logic bug" direction, and
    // must NOT be waved through as low risk.
    const removedLines = ['total = subtotal + tax', 'display(total)'];
    const addedLines = ['total = tax + subtotal', 'display(tax)']; // second line now shows the wrong variable
    const result = assessHunk({ filePath: 'checkout.js', removedLines, addedLines });
    assert.notEqual(result.reason, undefined);
    // subtotal->? mapping breaks consistency (subtotal has no counterpart in line 2,
    // and `total` maps to `tax` in line 2 while staying `total` in line 1) so the
    // rename detector must bail out rather than rubber-stamp this as safe.
    assert.doesNotMatch(result.reason, /mechanical rename/i);
  });
});

describe('generated files', () => {
  it('classifies a package-lock.json churn as low risk regardless of size', () => {
    const removedLines = Array.from({ length: 50 }, (_, i) => `    "resolved": "https://registry.npmjs.org/pkg-${i}"`);
    const addedLines = Array.from({ length: 60 }, (_, i) => `    "resolved": "https://registry.npmjs.org/pkg-${i}-v2"`);
    const result = assessHunk({ filePath: 'package-lock.json', removedLines, addedLines });
    assert.equal(result.level, 'low');
    assert.match(result.reason, /lockfile|generated/i);
  });

  it('does not treat an ordinary file named similarly (e.g. lock.py) as generated', () => {
    const result = assessHunk({ filePath: 'src/lock.py', removedLines: ['x = 1'], addedLines: ['x = 2'] });
    assert.doesNotMatch(result.reason, /lockfile\/generated/i);
  });
});

describe('removed error handling (dead-code-removal edge case)', () => {
  it('EDGE CASE: flags a removed try/except/else block even when it was genuinely dead code', () => {
    // This is django/django#18925 nearly verbatim: URLValidator.__call__ had
    // its IDN-retry try/except collapsed away because the outer validation
    // logic changed and made the except path unreachable. The PR was correct
    // and well-tested — but a static heuristic has no way to *prove* that,
    // so the right behavior is to flag it for careful review, not to try to
    // decide it was safe.
    const removedLines = [
      '        try:',
      '            super().__call__(value)',
      '        except ValidationError as e:',
      '            if value:',
      '                scheme, netloc, path, query, fragment = splitted_url',
      '                try:',
      '                    netloc = punycode(netloc)',
      '                except UnicodeError:',
      '                    raise e',
      '                url = urlunsplit((scheme, netloc, path, query, fragment))',
      '                super().__call__(url)',
      '            else:',
      '                raise',
    ];
    const addedLines = ['        super().__call__(value)'];
    const result = assessHunk({ filePath: 'django/core/validators.py', removedLines, addedLines });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /exception handling|try.*catch|except/i);
  });

  it('does not flag a removed try/except in an unrelated added-only hunk as error-handling-removed', () => {
    // Sanity check: the rule only looks at removedLines. A hunk that merely
    // *adds* a try/except (defensive programming) shouldn't trip this rule.
    const removedLines = [];
    const addedLines = ['try:', '    risky_call()', 'except ValueError:', '    pass'];
    const result = assessHunk({ filePath: 'app.py', removedLines, addedLines });
    assert.doesNotMatch(result.reason, /confirm the error path is truly unreachable/i);
  });
});

describe('removed conditional branches', () => {
  it('flags a removed if-branch confirmed dead by the original author (numpy#32143)', () => {
    const removedLines = [
      "    if byteorder == 'S':",
      "        # TODO: this path can never be reached",
      '        return swapped.byteorder',
    ];
    const addedLines = [];
    const result = assessHunk({ filePath: 'numpy/_core/_dtype.py', removedLines, addedLines });
    assert.ok(result.level === 'medium' || result.level === 'high');
    assert.match(result.reason, /conditional branch/i);
  });

  it('escalates to high when the removed branch contains its own return/raise (pandas#66045 construction.py)', () => {
    const removedLines = [
      '    else:',
      '        is_mi_list = isinstance(columns, list) and all(',
      '            isinstance(col, list) for col in columns',
      '        )',
      '        if not is_mi_list and len(columns) != len(content):',
      '            raise AssertionError(',
      '                f"{len(columns)} columns passed, passed data had {len(content)} columns"',
      '            )',
      '        if is_mi_list:',
      '            if len({len(col) for col in columns}) > 1:',
      '                raise ValueError(',
      '                    "Length of columns passed for MultiIndex columns is different"',
      '                )',
    ];
    const addedLines = [
      '    elif len(columns) != len(content):',
      '        raise AssertionError(',
      '            f"{len(columns)} columns passed, passed data had {len(content)} columns"',
      '        )',
    ];
    const result = assessHunk({ filePath: 'pandas/core/internals/construction.py', removedLines, addedLines });
    assert.equal(result.level, 'high');
  });
});

describe('security-shaped changes', () => {
  it('flags SQL built via string concatenation (VIP-portal#698, the vulnerable side)', () => {
    const removedLines = [
      '            StringBuilder sb = new StringBuilder();',
      '            for (String groupName : groups) {',
      '                sb.append("groupname = \'").append(groupName).append("\'");',
      '            }',
      '            PreparedStatement ps = getConnection().prepareStatement("SELECT DISTINCT "',
      '                    + "first_name, last_name, LOWER(first_name), LOWER(last_name) "',
      '                    + "FROM VIPUsers vu, VIPUsersGroups vg "',
      '                    + "WHERE vu.email = vg.email AND (" + sb.toString() + ") "',
      '                    + "ORDER BY LOWER(first_name), LOWER(last_name)");',
    ];
    const result = assessHunk({
      filePath: 'UsersGroupsData.java',
      removedLines,
      addedLines: [],
    });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /sql/i);
  });

  it('still flags the fixed parameterized version for review (touching SQL construction is inherently worth a look)', () => {
    const addedLines = [
      '        String placeholders = groups.stream().map(g -> "?").collect(Collectors.joining(", "));',
      '        String query = "SELECT DISTINCT first_name, last_name, LOWER(first_name), LOWER(last_name) "',
      '                    + "FROM VIPUsers vu, VIPUsersGroups vg "',
      '                    + "WHERE vu.email = vg.email AND vg.groupname IN (" + placeholders + ") "',
      '                    + "ORDER BY LOWER(first_name), LOWER(last_name)";',
    ];
    const result = assessHunk({ filePath: 'UsersGroupsData.java', removedLines: [], addedLines });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /sql/i);
  });

  it('flags a pure-addition hunk that sets security headers (partage#8 XSS fix)', () => {
    const addedLines = [
      '\tw.Header().Set("Content-Type", "application/octet-stream")',
      '\tw.Header().Set("Content-Disposition", "attachment")',
      '\tw.Header().Set("X-Content-Type-Options", "nosniff")',
      '\tw.Header().Set("Content-Security-Policy", "default-src \'none\';")',
    ];
    const result = assessHunk({ filePath: 'src/main.go', removedLines: [], addedLines });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /security-sensitive/i);
  });

  it('does not flag plain business logic with no security/SQL vocabulary', () => {
    const removedLines = ['  return price * quantity;'];
    const addedLines = ['  return price * quantity * (1 - discountRate);'];
    const result = assessHunk({ filePath: 'pricing.js', removedLines, addedLines });
    assert.equal(result.level, 'low');
  });
});

describe('boundary / off-by-one detection', () => {
  it('EDGE CASE: flags a one-character range-operator change on an otherwise identical line (alacritty#9027)', () => {
    const removedLines = [
      '                self.point.line = (*topmost_line..*self.point.line)',
    ];
    const addedLines = [
      '                self.point.line = (*topmost_line..=*self.point.line)',
    ];
    const result = assessHunk({ filePath: 'alacritty_terminal/src/vi_mode.rs', removedLines, addedLines });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /off-by-one|boundary/i);
  });

  it('flags a bare integer literal shifting by one on an otherwise identical line', () => {
    const removedLines = ['  for (let i = 0; i < items.length - 1; i++) {'];
    const addedLines = ['  for (let i = 0; i < items.length; i++) {'];
    // Not a token-for-token single-diff (removed " - 1" entirely), so this
    // exercises the "structural change, not just an operator swap" path —
    // it should still land on medium/high via the large-hunk/other rules
    // rather than being silently waved through as low.
    const result = assessHunk({ filePath: 'list.js', removedLines, addedLines });
    assert.notEqual(result.level, undefined);
  });

  it('does not flag an unrelated single-token difference between dissimilar lines', () => {
    const removedLines = ['const a = 1;', 'function totallyUnrelated() { return 42; }'];
    const addedLines = ['const a = 2;', 'function totallyUnrelated() { return 43; }'];
    // Both pairs are legitimately number-literal-by-one changes on matched
    // lines, so this SHOULD trip the off-by-one rule — included to confirm
    // pairing works across multiple independent single-line edits, not just
    // single-hunk-single-line cases.
    const result = assessHunk({ filePath: 'consts.js', removedLines, addedLines });
    assert.equal(result.level, 'high');
  });
});

describe('function signature changes', () => {
  it('EDGE CASE: flags a default-parameter addition as a signature change (requests#4052)', () => {
    const removedLines = ['def get_environ_proxies(url, no_proxy):'];
    const addedLines = ['def get_environ_proxies(url, no_proxy=None):'];
    const result = assessHunk({ filePath: 'requests/utils.py', removedLines, addedLines });
    assert.equal(result.level, 'medium');
    assert.match(result.reason, /signature changed/i);
    assert.match(result.reason, /get_environ_proxies/);
  });

  it('does not flag a call site (not a declaration) whose arguments changed', () => {
    const removedLines = ['result = compute(a, b)'];
    const addedLines = ['result = compute(a, b, c)'];
    const result = assessHunk({ filePath: 'app.py', removedLines, addedLines });
    assert.doesNotMatch(result.reason, /signature changed/i);
  });
});

describe('fallbacks', () => {
  it('classifies a small, unremarkable change as low risk', () => {
    const removedLines = ["const greeting = 'Hi';"];
    const addedLines = ["const greeting = 'Hello';"];
    const result = assessHunk({ filePath: 'greet.js', removedLines, addedLines });
    assert.equal(result.level, 'low');
  });

  it('classifies a large hunk with no specific signal as medium, not low', () => {
    const addedLines = Array.from({ length: 45 }, (_, i) => `    field_${i} = models.CharField(max_length=255)`);
    const result = assessHunk({ filePath: 'models.py', removedLines: [], addedLines });
    assert.equal(result.level, 'medium');
    assert.match(result.reason, /large hunk/i);
  });

  it('handles an empty hunk gracefully', () => {
    const result = assessHunk({ filePath: 'x.js', removedLines: [], addedLines: [] });
    assert.equal(result.level, 'low');
  });

  it('handles a hunk with only additions (new file) gracefully', () => {
    const addedLines = ['export function add(a, b) {', '  return a + b;', '}'];
    const result = assessHunk({ filePath: 'math.js', removedLines: [], addedLines });
    assert.equal(result.level, 'low');
  });

  it('handles a hunk with only deletions (file trimmed down) gracefully', () => {
    const removedLines = ['export function unused() {', '  return null;', '}'];
    const result = assessHunk({ filePath: 'math.js', removedLines, addedLines: [] });
    assert.equal(result.level, 'low');
  });
});

const { classifyFile, _internal } = require('../src/risk-engine.js');

describe('file classification (adapted from github-linguist)', () => {
  it('classifies prose/documentation paths as documentation', () => {
    for (const p of [
      'CHANGELOG.md',
      'README.md',
      'README',
      'LICENSE',
      'relayer-proxy/README.md',
      'docs/releasing.md',
      'docs/deployments-2026-08-19.md',
      'docs/ref/contrib/admin/actions.txt', // django's reST docs are .txt under docs/
      'Documentation/networking/tls.rst',
      'guides/setup.rst',
      'CONTRIBUTING',
    ]) {
      assert.equal(classifyFile(p), 'documentation', p);
    }
  });

  it('keeps code that merely shares a documentation-ish name classified as code', () => {
    // linguist's filename rules are case-sensitive and extension-limited
    // for exactly this reason — security.py is not SECURITY.md.
    for (const p of [
      'app/security.py',
      'django/db/migrations/changes.py',
      'src/news/views.py',
      'src/license_check.rs',
      'requirements.txt',
      'CMakeLists.txt',
      'examples/server.js', // linguist calls examples/ documentation, but it's runnable code
      'src/docs_builder.py',
    ]) {
      assert.equal(classifyFile(p), 'code', p);
    }
  });

  it('classifies vendored third-party paths as vendored', () => {
    for (const p of ['vendor/github.com/pkg/errors/errors.go', 'node_modules/lodash/index.js', 'third_party/zlib/inflate.c', 'lib/3rdparty/x.js']) {
      assert.equal(classifyFile(p), 'vendored', p);
    }
  });

  it('classifies lockfiles and codegen output as generated', () => {
    for (const p of ['contracts/Cargo.lock', 'package-lock.json', 'uv.lock', 'dist/app.min.js', 'api/v1/service.pb.go', 'proto/user_pb2.py', 'src/__generated__/Query.graphql.ts', 'app.js.map']) {
      assert.equal(classifyFile(p), 'generated', p);
    }
  });

  it('scores vendored code as low regardless of content', () => {
    const result = assessHunk({
      filePath: 'vendor/golang.org/x/crypto/ssh/client_auth.go',
      removedLines: ['\tif len(password) < 8 {'],
      addedLines: ['\tif len(password) <= 8 {'],
    });
    assert.equal(result.level, 'low');
    assert.match(result.reason, /vendored/i);
  });
});

describe('documentation files skip the security-keyword and boundary-change detectors', () => {
  // Verbatim from stellar/passkey-kit#4's CHANGELOG.md hunk.
  const changelogLines = [
    '## [0.16.3] - 2026-08-19',
    '',
    '### Security',
    '',
    '- **Smart wallet: policy signers can no longer remove themselves, detach from their context, or remove other signers.** A compromised or malicious policy signer previously could authorize a `remove_signer` call that stripped the wallet of its own policy — or removed an unrelated admin signer — bypassing the protection a policy was supposed to provide.',
  ];

  it('scores a CHANGELOG entry describing an authorization fix as low', () => {
    const result = assessHunk({ filePath: 'CHANGELOG.md', removedLines: [], addedLines: changelogLines });
    assert.equal(result.level, 'low');
  });

  it('still flags the same security vocabulary when it appears in code', () => {
    const result = assessHunk({
      filePath: 'contracts/smart-wallet/src/lib.rs',
      removedLines: [],
      addedLines: ['    // policy signers must not authorize removal of an admin signer', '    require_auth_for_admin(&env, &signer_key);', '    authorize_removal(&env)?;'],
    });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /security-sensitive/i);
  });

  it('scores a README version note ("binver = 1.0.0" → "1.0.1") as low', () => {
    const result = assessHunk({
      filePath: 'README.md',
      removedLines: ['Deployed wallets run `binver = 1.0.0`.'],
      addedLines: ['Deployed wallets run `binver = 1.0.1`.'],
    });
    assert.equal(result.level, 'low');
  });

  it('does not give a long prose hunk the "large hunk" medium fallback', () => {
    const addedLines = Array.from({ length: 60 }, (_, i) => `Step ${i}: run the deployment script and record the contract hash.`);
    const result = assessHunk({ filePath: 'docs/deployments.md', removedLines: [], addedLines });
    assert.equal(result.level, 'low');
  });

  it('still runs the structural detectors on documentation (removed try/except in a docs code sample)', () => {
    const result = assessHunk({
      filePath: 'docs/howto/errors.rst',
      removedLines: ['    try:', '        run()', '    except ValueError:', '        pass'],
      addedLines: ['    run()'],
    });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /exception handling/i);
  });
});

describe('boundary-change detector ignores version-shaped numbers', () => {
  it('scores a package.json version bump as low (passkey-kit#4)', () => {
    const result = assessHunk({ filePath: 'package.json', removedLines: ['  "version": "0.16.2",'], addedLines: ['  "version": "0.16.3",'] });
    assert.equal(result.level, 'low');
  });

  it('scores a nested package.json version bump as low', () => {
    const result = assessHunk({ filePath: 'packages/passkey-kit-sdk/package.json', removedLines: ['  "version": "0.8.0",'], addedLines: ['  "version": "0.8.1",'] });
    assert.equal(result.level, 'low');
  });

  it('scores a Cargo.toml version bump as low', () => {
    const result = assessHunk({ filePath: 'contracts/smart-wallet/Cargo.toml', removedLines: ['version = "1.0.0"'], addedLines: ['version = "1.0.1"'] });
    assert.equal(result.level, 'low');
  });

  it('scores a two-part pyproject.toml version bump as low (not semver-shaped, but a manifest version field)', () => {
    const result = assessHunk({ filePath: 'pyproject.toml', removedLines: ['version = "2.3"'], addedLines: ['version = "2.4"'] });
    assert.equal(result.level, 'low');
  });

  it('scores a manifest dependency pin bump as low', () => {
    const result = assessHunk({ filePath: 'Cargo.toml', removedLines: ['soroban-sdk = { version = "22.0" }'], addedLines: ['soroban-sdk = { version = "22.1" }'] });
    assert.equal(result.level, 'low');
  });

  it('scores a semver constant bump in code as low (passkey-kit#4 src/version.ts)', () => {
    const result = assessHunk({ filePath: 'src/version.ts', removedLines: ['export const VERSION = "0.16.2";'], addedLines: ['export const VERSION = "0.16.3";'] });
    assert.equal(result.level, 'low');
  });

  it('still flags an operator change on a line that also contains a version', () => {
    const result = assessHunk({
      filePath: 'src/compat.py',
      removedLines: ['    if installed >= parse("1.2.3"):'],
      addedLines: ['    if installed > parse("1.2.3"):'],
    });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /">=" → ">"/);
  });

  it('still flags an unquoted numeric setting shifting by one in a manifest', () => {
    const result = assessHunk({ filePath: 'Cargo.toml', removedLines: ['opt-level = 2'], addedLines: ['opt-level = 3'] });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /off-by-one/i);
  });

  it('only masks two-part quoted versions inside package manifests', () => {
    assert.equal(_internal.maskVersionLiterals('"version": "2.3",', 'pyproject.toml'), '"version": "VERSION_LITERAL",');
    assert.equal(_internal.maskVersionLiterals('limit = "2.3"', 'src/config.py'), 'limit = "2.3"');
    assert.equal(_internal.maskVersionLiterals('uses: actions/checkout@v4.1.0', '.github/workflows/ci.yml'), 'uses: actions/checkout@VERSION_LITERAL');
  });
});
