'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { findUpdate, downloadUpdate } = require('../core/gh-updates');
let passed = 0;
async function ok(n, f) { try { await f(); passed++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n     ' + e.message); process.exitCode = 1; } }
const g = (name) => ({ name, url: 'https://raw.githubusercontent.com/Grid21/StudyDeck/main/Updates/' + name });
const f = (name, ver) => ({ type: 'file', name, size: 5, download_url: 'https://raw.githubusercontent.com/Grid21/StudyDeck/main/Updates/' + name });
const fake = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body, arrayBuffer: async () => Buffer.from(body) });
(async () => {
  const list = [f('StudyDeck-0.5.1.studyupdate'), f('StudyDeck-0.10.0.studyupdate'), f('StudyDeck-0.9.0.studyupdate'), f('README.md'), { type: 'dir', name: 'StudyDeck-9.9.9.studyupdate' }];
  await ok('picks the highest version (0.10.0 beats 0.9.0), ignoring other files', async () => {
    const r = await findUpdate({ currentVersion: '0.5.0', fetchFn: fake(200, list) }); assert.strictEqual(r.updateAvailable, true); assert.strictEqual(r.latestVersion, '0.10.0');
  });
  await ok('says nothing new when up to date, folder missing, or offline', async () => {
    assert.strictEqual((await findUpdate({ currentVersion: '0.10.0', fetchFn: fake(200, list) })).updateAvailable, false);
    assert.strictEqual((await findUpdate({ currentVersion: '0.1.0', fetchFn: fake(404, {}) })).ok, true);
    assert.strictEqual((await findUpdate({ currentVersion: '0.1.0', fetchFn: async () => { throw new Error('offline'); } })).ok, false);
    assert.match((await findUpdate({ currentVersion: '0.1.0', fetchFn: fake(403, {}) })).error, /too many/);
  });
  await ok('downloads from GitHub only', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-')); const dest = path.join(d, 'x.studyupdate');
    await downloadUpdate({ file: g('a.studyupdate'), dest, fetchFn: fake(200, 'hello'), fs }); assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello');
    await assert.rejects(() => downloadUpdate({ file: { url: 'https://evil.example.com/a' }, dest, fetchFn: fake(200, 'x'), fs }), /not a GitHub/);
    await assert.rejects(() => downloadUpdate({ file: { url: 'http://raw.githubusercontent.com/a' }, dest, fetchFn: fake(200, 'x'), fs }), /not a GitHub/);
    await assert.rejects(() => downloadUpdate({ file: g('a.studyupdate'), dest, fetchFn: fake(500, 'x'), fs }), /failed/);
    fs.rmSync(d, { recursive: true, force: true });
  });
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
})();
