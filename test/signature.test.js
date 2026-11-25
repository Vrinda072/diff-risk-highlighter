// Signature changes are compared parameter by parameter, including lists that
// wrap over several lines (the three flask#5818-style hunks in
// test/fixtures/real-prs that a line-by-line match missed).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessHunk } = require('../src/risk-engine.js');
const { _internal } = require('../src/risk-engine.js');

const changes = (filePath, removed, added) => {
  const result = _internal.detectSignatureChange([].concat(removed), [].concat(added), filePath);
  return result ? result.changes.join('; ') : null;
};

describe('signature changes', () => {
  it('reads a parameter list wrapped over several lines', () => {
    const result = assessHunk({
      filePath: 'src/flask/app.py',
      removedLines: ['    def do_teardown_request(self, exc: BaseException | None = None) -> None:'],
      addedLines: ['    def do_teardown_request(', '        self, ctx: AppContext, exc: BaseException | None = None', '    ) -> None:'],
    });
    assert.equal(result.level, 'medium');
    assert.match(result.reason, /signature changed: do_teardown_request — added parameter ctx \(no default; ahead of existing ones/i);
  });

  const cases = [
    ['a gained default', 'a.py', 'def f(url, no_proxy):', 'def f(url, no_proxy=None):', /^no_proxy gained a default \(None\)$/],
    ['a keyword-only addition without calling * a parameter', 'a.py', 'def f(a):', 'def f(a, *, flag=False):', /^added parameter flag \(keyword-only; has a default\)$/],
    ['parameters made keyword-only', 'a.py', 'def f(a, b=1):', 'def f(a, *, b=1):', /^b is now keyword-only/],
    ['a rename that also changes the type', 'a.py', 'def f(app: Flask):', 'def f(ctx: AppContext):', /renamed parameter app → ctx \(app: Flask → ctx: AppContext\)/],
    ['a changed default', 'a.py', 'def f(a, timeout=5):', 'def f(a, timeout=10):', /default of timeout changed \(5 → 10\)/],
    ['a lost default', 'a.py', 'def f(timeout=5):', 'def f(timeout):', /timeout lost its default/],
    ['a changed type', 'a.rs', 'fn f(id: u32) {', 'fn f(id: u64) {', /id: u32 → id: u64/],
    ['reordered parameters', 'a.py', 'def f(src, dst):', 'def f(dst, src):', /reordered parameters \(now dst, src\)/],
    ['a renamed parameter', 'a.py', 'def f(path):', 'def f(name):', /renamed parameter path → name/],
    ['a removed parameter', 'a.js', 'function f(a, b) {', 'function f(a) {', /removed parameter b/],
    ['an optional addition at the end', 'a.py', 'def f(a):', 'def f(a, verbose=False):', /added parameter verbose \(has a default\)$/],
    ['a Go method with a receiver', 'a.go', 'func (s *Server) Run(ctx context.Context) error {', 'func (s *Server) Run(ctx context.Context, port int) error {', /added parameter port/],
    ['a generic Rust function', 'a.rs', 'fn get<T: Clone>(map: HashMap<u8, T>) {', 'fn get<T: Clone>(map: HashMap<u16, T>) {', /map: HashMap<u8, T> → map: HashMap<u16, T>/],
    ['destructured props', 'a.tsx', 'function Footer({ startedAt, model }: Props) {', 'function Footer({ attribution, model }: Props) {', /now takes attribution; no longer takes startedAt/],
    ['a nested call in a default', 'a.py', 'def f(a=make(1, 2), b=0):', 'def f(a=make(1, 3), b=0):', /default of a changed \(make\(1, 2\) → make\(1, 3\)\)/],
  ];
  for (const [name, file, before, after, expected] of cases) {
    it(`describes ${name}`, () => assert.match(changes(file, before, after), expected));
  }

  const unchanged = [
    ['only re-wrapping', 'a.py', ['def f(a, b):'], ['def f(', '    a,', '    b,', '):']],
    ['a trailing comma inside destructured props', 'a.tsx', ['function P({ children, settings, }: Props) {'], ['function P({ children, settings }: Props) {']],
    ['quote style in a default', 'a.py', ['def f(mode="r"):'], ["def f(mode='r'):"]],
    ['a comma inside a string default', 'a.py', ['def f(sep=", "):  # old'], ['def f(sep=", "):  # new']],
    ['a comment inside the list', 'a.py', ['def f(a,  # first', '      b):'], ['def f(a, b):']],
    ['a list cut off by the end of the changed lines', 'a.py', ['def f(a, b):'], ['def f(', '    a,']],
    ['two methods of the same name, each unchanged', 'a.py', ['def get(self):', 'def get(self, key):'], ['def get(self):  # x', 'def get(self, key):']],
  ];
  for (const [name, file, removed, added] of unchanged) {
    it(`ignores ${name}`, () => assert.equal(changes(file, removed, added), null));
  }
});
