'use strict';
// StudyDeck start-up file. Deliberately tiny and never changed by .studyupdate files.
// It decides whether to run the built-in program or an installed update, and falls back
// to the built-in program if an update did not start properly.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

app.setName('studydeck');
if (process.env.STUDYDECK_USER_DATA) app.setPath('userData', process.env.STUDYDECK_USER_DATA);

const baseRoot = __dirname;
const baseVersion = require('./package.json').version;
const { compare } = require('./core/semver');
const updatesDir = path.join(app.getPath('userData'), 'updates');
const statePath = path.join(updatesDir, 'state.json');
const bootPath = path.join(updatesDir, 'boot.json');
const problemPath = path.join(updatesDir, 'last-problem.txt');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function noteProblem(text) {
  try { fs.mkdirSync(updatesDir, { recursive: true }); fs.writeFileSync(problemPath, `${new Date().toISOString()}  ${text}\n`); } catch { /* ignore */ }
}

function chooseRoot() {
  if (process.argv.includes('--no-updates') || process.env.STUDYDECK_NO_UPDATES) return baseRoot;
  const state = readJson(statePath);
  if (!state || !state.current) {
    // no update in use: clean up update folders left over from earlier
    try { for (const e of fs.readdirSync(updatesDir)) if (e.startsWith('v')) rm(path.join(updatesDir, e)); } catch { /* none */ }
    return baseRoot;
  }
  const boot = readJson(bootPath);
  if (boot && boot.pending && boot.dir === state.current) {
    // the last start of this update never finished loading
    noteProblem(`Update ${state.version} did not start properly, so the built-in version ${baseVersion} was used.`);
    rm(statePath); rm(bootPath);
    return baseRoot;
  }
  const dir = path.join(updatesDir, state.current);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg || pkg.version !== state.version || compare(state.version, baseVersion) <= 0 || !fs.existsSync(path.join(dir, 'app-main.js'))) {
    noteProblem(`The installed update ${state.version} was incomplete or older than the built-in version, so it was ignored.`);
    rm(statePath);
    return baseRoot;
  }
  try { fs.writeFileSync(bootPath, JSON.stringify({ pending: true, dir: state.current })); } catch { /* ignore */ }
  return dir;
}

const root = chooseRoot();
global.studydeckBoot = {
  root, baseRoot, baseVersion, updatesDir, problemPath,
  usingUpdate: root !== baseRoot,
  markOk() { rm(bootPath); }          // called by the program once its window has loaded
};

try {
  require(path.join(root, 'app-main.js'));
} catch (e) {
  if (root === baseRoot) throw e;
  noteProblem(`Update could not be loaded (${e.message}). Went back to the built-in version ${baseVersion}.`);
  rm(statePath); rm(bootPath);
  app.relaunch();
  app.exit(0);
}
