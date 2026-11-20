'use strict';
// The .studyupdate file format: reading, checking and installing updates from a local file.
// A .studyupdate is a zip holding  update.json  and  files/<path>  entries.
// Plain Node.js, no Electron code in here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fflate = require('./vendor/fflate.js');
const { compare, parse } = require('./semver');

const FORMAT = 1;
const MAX_FILES = 200;
const MAX_TOTAL = 30 * 1024 * 1024;          // 30 MB of unpacked files
const MAX_FILE = 8 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.js', '.json', '.html', '.css', '.png', '.svg']);
const ALLOWED_ROOT_FILES = new Set(['app-main.js', 'preload.js', 'package.json']);
const ALLOWED_DIRS = ['core/', 'renderer/', 'plugins-example/'];
// copied from the built-in program into a new update folder before the update's own files go on top
const BASE_ENTRIES = ['app-main.js', 'preload.js', 'package.json', 'core', 'renderer', 'plugins-example'];

class UpdateError extends Error {}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function pathProblem(p) {
  if (typeof p !== 'string' || !p) return 'empty path';
  if (p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return 'unsafe path';
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return 'unsafe path';
  if (!ALLOWED_EXT.has(path.extname(p).toLowerCase())) return 'file type not allowed';
  if (!(ALLOWED_ROOT_FILES.has(p) || ALLOWED_DIRS.some((d) => p.startsWith(d)))) return 'folder not allowed';
  return null;
}

// Reads and checks a .studyupdate file. Returns { manifest, files: Map(path -> Buffer) }. Writes nothing.
function readUpdate(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { throw new UpdateError('The update file could not be opened.'); }
  let entries;
  try {
    entries = fflate.unzipSync(new Uint8Array(bytes), {
      filter: (f) => {
        if (f.originalSize > MAX_FILE) throw new UpdateError('The update contains a file that is too large.');
        return true;
      }
    });
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError('This is not a valid .studyupdate file.');
  }
  if (!entries['update.json']) throw new UpdateError('This is not a StudyDeck update (update.json is missing).');
  let m;
  try { m = JSON.parse(Buffer.from(entries['update.json']).toString('utf8')); } catch { throw new UpdateError('update.json is damaged.'); }
  if (m.app !== 'studydeck') throw new UpdateError('This update is not for StudyDeck.');
  if (m.format !== FORMAT) throw new UpdateError('This update was made for a different version of the update format.');
  if (!parse(m.version)) throw new UpdateError('The update has no valid version number.');
  if (!Array.isArray(m.files) || m.files.length === 0) throw new UpdateError('The update contains no files.');
  if (m.files.length > MAX_FILES) throw new UpdateError('The update contains too many files.');

  const files = new Map();
  let total = 0;
  for (const f of m.files) {
    const bad = pathProblem(f && f.path);
    if (bad) throw new UpdateError(`The update lists "${f && f.path}" (${bad}).`);
    const data = entries['files/' + f.path];
    if (!data) throw new UpdateError(`The update is missing the file "${f.path}".`);
    const buf = Buffer.from(data);
    if (sha256(buf) !== f.sha256) throw new UpdateError(`The file "${f.path}" is damaged (checksum does not match).`);
    total += buf.length;
    if (total > MAX_TOTAL) throw new UpdateError('The update is too large.');
    if (files.has(f.path)) throw new UpdateError(`The file "${f.path}" is listed twice.`);
    files.set(f.path, buf);
  }
  for (const n of Object.keys(entries)) {
    if (n === 'update.json' || n.endsWith('/')) continue;
    if (!n.startsWith('files/') || !files.has(n.slice(6))) throw new UpdateError(`The update contains an unlisted file "${n}".`);
  }
  if (!files.has('app-main.js')) throw new UpdateError('The update does not contain app-main.js.');
  const pk = files.get('package.json');
  if (!pk) throw new UpdateError('The update does not contain package.json.');
  let pv; try { pv = JSON.parse(pk.toString('utf8')).version; } catch { pv = null; }
  if (pv !== m.version) throw new UpdateError('The version inside the update does not match its label.');
  return {
    manifest: { version: m.version, notes: String(m.notes || ''), requiresBase: m.requiresBase ? String(m.requiresBase) : '0.0.0', date: m.date || '' },
    files
  };
}

// ---- where updates live -------------------------------------------------------------------
function statePath(updatesDir) { return path.join(updatesDir, 'state.json'); }
function readState(updatesDir) {
  try { return JSON.parse(fs.readFileSync(statePath(updatesDir), 'utf8')); } catch { return null; }
}
function writeState(updatesDir, state) {
  fs.mkdirSync(updatesDir, { recursive: true });
  const tmp = statePath(updatesDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(updatesDir));
}

// Installs an update. It is used the next time the app starts.
//   baseRoot    folder of the built-in program   baseVersion   its version   runningVersion   version running now
function installUpdate(file, { baseRoot, baseVersion, runningVersion, updatesDir }) {
  const { manifest, files } = readUpdate(file);
  if (compare(manifest.requiresBase, baseVersion) > 0) {
    throw new UpdateError(`This update needs the full program version ${manifest.requiresBase} or newer (you have ${baseVersion}). Rebuild or reinstall the program first.`);
  }
  if (compare(manifest.version, runningVersion) <= 0) {
    throw new UpdateError(`You already have version ${runningVersion}. This update is version ${manifest.version}.`);
  }
  const dirName = `v${manifest.version}-${Date.now()}`;
  const dir = path.join(updatesDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const e of BASE_ENTRIES) {
      const src = path.join(baseRoot, e);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, e), { recursive: true });
    }
    for (const [p, buf] of files) {
      const dest = path.join(dir, ...p.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    if (!fs.existsSync(path.join(dir, 'app-main.js'))) throw new UpdateError('The update could not be put together.');
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e instanceof UpdateError ? e : new UpdateError('The update could not be installed: ' + e.message);
  }
  const old = readState(updatesDir);
  writeState(updatesDir, { current: dirName, version: manifest.version, installedAt: Date.now(), notes: manifest.notes, previous: old ? old.current : null });
  // keep only the new folder and the one before it
  for (const e of fs.readdirSync(updatesDir)) {
    if (e === dirName || (old && e === old.current) || !e.startsWith('v')) continue;
    fs.rmSync(path.join(updatesDir, e), { recursive: true, force: true });
  }
  return manifest;
}

// Goes back to the built-in version from the next start. (Old update folders are cleaned up
// at that start, because files that are in use right now should not be deleted.)
function removeUpdates(updatesDir) {
  fs.rmSync(statePath(updatesDir), { force: true });
  fs.rmSync(path.join(updatesDir, 'boot.json'), { force: true });
}

module.exports = { readUpdate, installUpdate, removeUpdates, readState, writeState, pathProblem, UpdateError, sha256, FORMAT, ALLOWED_EXT, ALLOWED_ROOT_FILES, ALLOWED_DIRS, MAX_FILES };
