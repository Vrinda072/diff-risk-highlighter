const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ablate, render, REPORT } = require('../eval/ablation.js');

const result = ablate();

it('docs/ablation.md matches the current engine (node eval/ablation.js --write)', () => {
  assert.equal(fs.readFileSync(REPORT, 'utf8'), render(result));
});

it('no "harmless" shortcut hides a labelled fix hunk', () => {
  for (const { id, without } of result.shortcuts) {
    assert.equal(without.fixesFlagged, result.full.fixesFlagged, `turning off "${id}" reveals a fix hunk it had hidden`);
  }
});
