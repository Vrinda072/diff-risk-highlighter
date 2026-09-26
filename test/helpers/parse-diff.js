// Test-only unified-diff parser. NOT shipped in the extension — Milestone 3
// reads hunks straight from GitHub's DOM (see src/content.js), it never sees
// raw diff text. This exists purely so the real-PR fixtures in
// test/fixtures/real-prs/*.diff can be turned into the same
// {filePath, addedLines, removedLines} shape risk-engine.js expects.

function parseDiff(text) {
  const lines = text.split('\n');
  const hunks = [];
  let currentFile = '(unknown)';
  let currentHunk = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      currentFile = '(unknown)';
      currentHunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null') currentFile = path.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null' && currentFile === '(unknown)') {
        currentFile = path.replace(/^a\//, '');
      }
      continue;
    }
    if (line.startsWith('@@')) {
      // newStart/newCount (the "+c,d" range) aren't used by the risk
      // engine — only by e2e/, to merge hunks the way GitHub renders them.
      const range = line.match(/\+(\d+)(?:,(\d+))?/);
      currentHunk = {
        filePath: currentFile,
        newStart: Number(range[1]),
        newCount: range[2] === undefined ? 1 : Number(range[2]),
        addedLines: [],
        removedLines: [],
      };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      currentHunk.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      currentHunk.removedLines.push(line.slice(1));
    }
    // context lines (leading space) and "\ No newline at end of file" are ignored
  }

  return hunks;
}

module.exports = { parseDiff };
