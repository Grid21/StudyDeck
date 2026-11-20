'use strict';
// Builds a .studyupdate file from the files in this folder.
//   node tools/make-update.js --notes "What changed" [--out <folder>]
// The version number comes from package.json. Only code files travel in a .studyupdate
// (.js .json .html .css .png .svg inside core/, renderer/, plugins-example/ and the three root files).
// .bat / .sh scripts, main.js and new npm packages need the source zip instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fflate = require('../core/vendor/fflate.js');
const updatepkg = require('../core/updatepkg');

const root = path.join(__dirname, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : ''; };
const notes = arg('--notes');
const outDir = path.resolve(arg('--out') || root);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const list = [];
const add = (rel) => { if (!updatepkg.pathProblem(rel)) list.push(rel); };
function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel); else add(rel);
  }
}
for (const f of ['app-main.js', 'preload.js', 'package.json']) add(f);
for (const d of ['core', 'renderer', 'plugins-example']) walk(d);

const zip = {}; const files = [];
for (const rel of list.sort()) {
  const buf = fs.readFileSync(path.join(root, rel));
  files.push({ path: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  zip['files/' + rel] = new Uint8Array(buf);
}
zip['update.json'] = new TextEncoder().encode(JSON.stringify({ app: 'studydeck', format: updatepkg.FORMAT, version: pkg.version, notes, files }, null, 2));
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `StudyDeck-${pkg.version}.studyupdate`);
fs.writeFileSync(out, fflate.zipSync(zip, { level: 9 }));
console.log(`${out}  (${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
