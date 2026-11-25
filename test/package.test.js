const { it } = require('node:test');
const assert = require('node:assert/strict');
const { referencedFiles, unloadableFiles, RUNTIME_FILES } = require('../scripts/package.js');

it('every file the extension refers to is in the release', () => {
  assert.deepEqual(referencedFiles().filter((f) => !RUNTIME_FILES.includes(f)), []);
});

// Node and the unit tests were happy with a literal U+FFFF in the engine;
// Chrome refused to load the whole extension.
it('every shipped script has only characters Chrome will load', () => {
  assert.deepEqual(unloadableFiles(RUNTIME_FILES), []);
});
