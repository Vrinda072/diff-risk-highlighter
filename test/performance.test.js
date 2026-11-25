// The engine runs on GitHub's main thread, so a slow hunk freezes the tab.
// Before large hunks got windowed line pairing, 3,000 x 3,000 changed lines
// took about 27 s. The budgets here are generous for slow CI machines and
// still catch any return to quadratic behaviour.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assessHunk } = require('../src/risk-engine.js');

const rows = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const line = (i) => `    const value_${i} = compute(a${i}, b${i}) + helper(x[${i}]); // row ${i}`;

function timed(hunk) {
  const start = process.hrtime.bigint();
  const result = assessHunk(hunk);
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

describe('large hunks stay fast', () => {
  it('3,000 x 3,000 similar edits finish well under 2 s', () => {
    const { ms } = timed({ filePath: 'src/a.js', removedLines: rows(3000, line), addedLines: rows(3000, (i) => line(i).replace('compute', 'calc')) });
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });

  it('3,000 x 3,000 unrelated lines finish well under 2 s', () => {
    const { ms } = timed({
      filePath: 'a.js',
      removedLines: rows(3000, (i) => `x${i} = ${'a'.repeat(i % 50)}`),
      addedLines: rows(3000, (i) => `y${i}(${'b'.repeat(i % 40)})`),
    });
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });

  it('a 300k-character minified line stays fast', () => {
    const { ms } = timed({ filePath: 'bundle.js', removedLines: ['x'.repeat(300000)], addedLines: ['y'.repeat(300000)] });
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });
});

describe('large hunks are still judged correctly', () => {
  const body = rows(900, (i) => `    total_${i} += weights[${i}] * scale;`);

  it('finds an off-by-one buried deep in a large rewrite', () => {
    const removed = [...body.slice(0, 700), '    for (let k = 0; k < count; k++) {', ...body.slice(700)];
    const added = [...body.slice(0, 700), '    for (let k = 0; k <= count; k++) {', ...body.slice(700)];
    const { result } = timed({ filePath: 'src/sum.js', removedLines: removed, addedLines: added });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /boundary/i);
  });

  it('still pairs an edited line after 300 new lines push it far down', () => {
    const inserted = rows(300, (i) => `    registerHandler("event_${i}", handlers.on${i});`);
    const removed = [...body.slice(0, 400), '    if (index < items.length) emit(index);', ...body.slice(400)];
    const added = [...inserted, ...body.slice(0, 400), '    if (index <= items.length) emit(index);', ...body.slice(400)];
    const { result } = timed({ filePath: 'src/emit.js', removedLines: removed, addedLines: added });
    assert.equal(result.level, 'high');
    assert.match(result.reason, /boundary/i);
  });
});
