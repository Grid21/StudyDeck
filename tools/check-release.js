'use strict';
// Fails if a file that is supposed to ship is missing.
//   node tools/check-release.js            check
//   node tools/check-release.js --update   rewrite tools/release-files.txt from the files now present
// Files removed on purpose must be listed in tools/removed-files.txt ("path  # reason").
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const listFile = path.join(__dirname, 'release-files.txt');
const removedFile = path.join(__dirname, 'removed-files.txt');
const SKIP = new Set(['node_modules', 'StudyDeck', 'update-files', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

if (process.argv.includes('--update')) {
  const files = walk(root).filter((f) => !/^package-lock\.json$/.test(f)).sort();
  fs.writeFileSync(listFile, files.join('\n') + '\n');
  console.log(`release-files.txt updated (${files.length} files).`);
  process.exit(0);
}

const expected = readList(listFile);
const removed = new Set(readList(removedFile));
const missing = expected.filter((f) => !fs.existsSync(path.join(root, f)) && !removed.has(f));
if (missing.length) {
  console.error('MISSING FILES (add them back, or list them in tools/removed-files.txt with a reason):');
  missing.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log(`check-release: all ${expected.length} expected files are present.`);
