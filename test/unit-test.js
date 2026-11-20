'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compare } = require('../core/semver');
const { checkForUpdate, repoFromUrl } = require('../core/updates');
const plugins = require('../core/plugins');

(async () => {
  // versions
  assert.strictEqual(compare('1.2.0', '1.1.9'), 1);
  assert.strictEqual(compare('v0.1.0', '0.1.0'), 0);
  assert.strictEqual(compare('0.9.0', '0.10.0'), -1);
  assert.strictEqual(repoFromUrl('git+https://github.com/me/studydeck.git'), 'me/studydeck');
  assert.strictEqual(repoFromUrl('https://github.com/me/studydeck'), 'me/studydeck');

  // update check with a pretend GitHub
  const fake = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  let r = await checkForUpdate({ repo: 'me/studydeck', currentVersion: '0.1.0', fetchFn: fake(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/me/studydeck/releases/v0.2.0' }) });
  assert.ok(r.ok && r.updateAvailable && r.latestVersion === '0.2.0');
  r = await checkForUpdate({ repo: 'me/studydeck', currentVersion: '0.2.0', fetchFn: fake(200, { tag_name: 'v0.2.0' }) });
  assert.ok(r.ok && !r.updateAvailable);
  r = await checkForUpdate({ repo: 'me/studydeck', currentVersion: '0.1.0', fetchFn: fake(404, {}) });
  assert.ok(r.ok && !r.updateAvailable);
  r = await checkForUpdate({ repo: 'me/studydeck', currentVersion: '0.1.0', fetchFn: async () => { throw new Error('offline'); } });
  assert.ok(!r.ok);
  r = await checkForUpdate({ repo: 'YOUR-GITHUB-NAME/studydeck', currentVersion: '0.1.0', fetchFn: fake(200, {}) });
  assert.ok(!r.ok);

  // plugins: the shipped example plus a broken one
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-plugins-'));
  fs.cpSync(path.join(__dirname, '..', 'plugins-example', 'hello'), path.join(tmp, 'hello'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'broken'));
  fs.writeFileSync(path.join(tmp, 'broken', 'plugin.json'), '{ "id": "broken", "name": "Broken", "main": "nope.js" }');
  fs.mkdirSync(path.join(tmp, 'escape'));
  fs.writeFileSync(path.join(tmp, 'escape', 'plugin.json'), '{ "id": "escape", "name": "Escape", "main": "../hello/index.js" }');
  const logs = [];
  const list = plugins.loadAll(tmp, (...a) => logs.push(a.join(' ')));
  const byId = Object.fromEntries(list.map((p) => [p.folder, p]));
  assert.ok(byId.hello.loaded, 'example plugin loads');
  assert.ok(!byId.broken.loaded && /not found/.test(byId.broken.error));
  assert.ok(!byId.escape.loaded && /inside the plugin folder/.test(byId.escape.error));
  await plugins.api.emit('app:ready', {});
  assert.ok(logs.some((l) => /Hello from the example plugin/.test(l)));
  assert.ok(logs.some((l) => /The app is ready/.test(l)));
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('All unit tests passed.');
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
