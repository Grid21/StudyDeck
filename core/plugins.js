'use strict';
const fs = require('fs');
const path = require('path');

// StudyDeck plugins are folders holding a plugin.json and a JavaScript file.
// NOTE: a plugin runs with the same power as the app. Only install plugins you trust.

const hooks = {};   // hook name -> [functions]

const api = {
  on(name, fn) { (hooks[name] = hooks[name] || []).push(fn); },
  async emit(name, data) {
    for (const fn of hooks[name] || []) {
      try { await fn(data); } catch (e) { console.error(`[plugin hook ${name}]`, e.message); }
    }
  }
};

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) return { error: 'plugin.json is missing' };
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: 'plugin.json is not valid' }; }
  if (!m.id || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) return { error: 'plugin.json needs an "id" (lowercase letters, numbers, dashes)' };
  if (!m.name) return { error: 'plugin.json needs a "name"' };
  if (!m.main) return { error: 'plugin.json needs a "main" file' };
  const mainPath = path.resolve(dir, m.main);
  if (!mainPath.startsWith(path.resolve(dir) + path.sep)) return { error: '"main" must be inside the plugin folder' };
  if (!fs.existsSync(mainPath)) return { error: `"main" file ${m.main} was not found` };
  return { manifest: m, mainPath };
}

// Loads every plugin folder inside `pluginsDir`. Returns a list for the screen.
function loadAll(pluginsDir, log = console.log) {
  const list = [];
  if (!fs.existsSync(pluginsDir)) return list;
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    const r = readManifest(dir);
    if (r.error) { list.push({ folder: entry.name, name: entry.name, loaded: false, error: r.error }); continue; }
    try {
      const mod = require(r.mainPath);
      if (typeof mod.activate === 'function') mod.activate({ on: api.on, log: (...a) => log(`[${r.manifest.id}]`, ...a) });
      list.push({ folder: entry.name, id: r.manifest.id, name: r.manifest.name, version: r.manifest.version || '', description: r.manifest.description || '', loaded: true });
    } catch (e) {
      list.push({ folder: entry.name, id: r.manifest.id, name: r.manifest.name, loaded: false, error: e.message });
    }
  }
  return list;
}

module.exports = { loadAll, readManifest, api };
