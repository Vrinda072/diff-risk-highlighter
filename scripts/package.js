// Builds dist/diff-risk-highlighter-<version>.zip from an explicit list of the
// files the extension needs at runtime, so tests, fixtures and docs can never
// leak into a release. It refuses to build if the manifest (or a script it
// loads) refers to a file that is not on the list.
//
//   npm run package

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const RUNTIME_FILES = [
  'manifest.json',
  'LICENSE',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'src/engine/text.js',
  'src/engine/language.js',
  'src/engine/files.js',
  'src/engine/shortcuts.js',
  'src/engine/boundary.js',
  'src/engine/logic.js',
  'src/engine/security.js',
  'src/engine/tests.js',
  'src/engine/concurrency.js',
  'src/engine/signature.js',
  'src/risk-engine.js',
  'src/content.js',
  'src/background.js',
  'src/explain.js',
  'src/options.html',
  'src/options.js',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Every file the extension asks for at runtime, resolved from the repo root.
function referencedFiles() {
  const manifest = JSON.parse(read('manifest.json'));
  const refs = new Set([
    manifest.background.service_worker,
    manifest.options_ui.page,
    ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);
  const worker = manifest.background.service_worker;
  for (const m of read(worker).matchAll(/importScripts\(\s*['"]([^'"]+)['"]/g)) {
    refs.add(path.posix.join(path.posix.dirname(worker), m[1]));
  }
  const page = manifest.options_ui.page;
  for (const m of read(page).matchAll(/<(?:script|link)[^>]+(?:src|href)="([^":]+)"/g)) {
    refs.add(path.posix.join(path.posix.dirname(page), m[1]));
  }
  return [...refs];
}

// Chrome refuses to load an extension if a script holds a Unicode
// noncharacter (U+FFFF and friends) or bytes that aren't UTF-8, and says the
// file "isn't UTF-8 encoded". Node runs such a file without complaint.
function unloadableFiles(files) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return files.filter((f) => /\.(js|json|html|css)$/.test(f)).filter((f) => {
    let text;
    try {
      text = decoder.decode(fs.readFileSync(path.join(ROOT, f)));
    } catch (_) {
      return true;
    }
    return Array.from(text).some((c) => {
      const code = c.codePointAt(0);
      return code === 0 || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xfffe) === 0xfffe;
    });
  });
}

function build() {
  const missingOnDisk = RUNTIME_FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missingOnDisk.length) throw new Error('listed but missing: ' + missingOnDisk.join(', '));
  const unlisted = referencedFiles().filter((f) => !RUNTIME_FILES.includes(f));
  if (unlisted.length) throw new Error('referenced by the extension but not packaged: ' + unlisted.join(', '));

  const unloadable = unloadableFiles(RUNTIME_FILES);
  if (unloadable.length) throw new Error('Chrome cannot load: ' + unloadable.join(', '));

  const { version } = JSON.parse(read('manifest.json'));
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const zip = path.join(dist, `diff-risk-highlighter-${version}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-X', '-q', zip, ...RUNTIME_FILES], { cwd: ROOT });
  return { zip, version, files: RUNTIME_FILES };
}

if (require.main === module) {
  const { zip, files } = build();
  console.log(`${path.relative(ROOT, zip)}: ${files.length} files, ${(fs.statSync(zip).size / 1024).toFixed(0)} KB`);
}

module.exports = { build, referencedFiles, unloadableFiles, RUNTIME_FILES };
