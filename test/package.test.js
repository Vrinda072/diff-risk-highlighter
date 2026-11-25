const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { referencedFiles, unloadableFiles, RUNTIME_FILES } = require('../scripts/package.js');

it('every file the extension refers to is in the release', () => {
  assert.deepEqual(referencedFiles().filter((f) => !RUNTIME_FILES.includes(f)), []);
});

// Node and the unit tests were happy with a literal U+FFFF in the engine;
// Chrome refused to load the whole extension.
it('every shipped script has only characters Chrome will load', () => {
  assert.deepEqual(unloadableFiles(RUNTIME_FILES), []);
});

// Chrome runs the content scripts in manifest order in one shared global, with
// no require(). A file listed before something it needs only breaks there.
it('the engine loads in manifest order without require()', () => {
  const sandbox = vm.createContext({});
  sandbox.self = sandbox;
  const { content_scripts: [{ js }] } = require('../manifest.json');
  for (const file of js.filter((f) => f !== 'src/content.js')) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
  }
  const result = sandbox.DiffRiskEngine.assessHunk({ filePath: 'a.c', removedLines: ['  i < len'], addedLines: ['  i <= len'] });
  assert.equal(result.level, 'high');
});
