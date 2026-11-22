'use strict';
// Tests Discord sign-in and "people you may know" against a PRETEND Discord (a small local server that behaves like
// Discord's OAuth pages). It has NOT been run against the real Discord.
const assert = require('assert');
const { createApp } = require('../server/server');
const { FriendsClient } = require('../core/friends-client');

let passed = 0;
async function ok(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } }
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const { startFakeDiscord } = require('./helpers/fake-discord');

(async () => {
  const fake = await startFakeDiscord(); const seenSecrets = fake.seenSecrets;
  const app = createApp({ dbPath: ':memory:', discord: { clientId: 'app-id', clientSecret: 'shh-secret', redirectUri: 'http://127.0.0.1/cb', apiBase: fake.apiBase, authUrl: 'https://discord.com/oauth2/authorize' } });
  const port = await listen(app.server); const base = `http://127.0.0.1:${port}`;
  const off = createApp({ dbPath: ':memory:' }); const offPort = await listen(off.server);

  // does what the browser does: Discord sends the person back to the server with ?code=...&state=...
  async function discordLogin(code) {
    const c = new FriendsClient({ baseUrl: base });
    const poll = require('crypto').randomBytes(32).toString('hex');
    const s = await c.discordStart(poll); assert.ok(s.ok, JSON.stringify(s));
    const u = new URL(s.url); const state = u.searchParams.get('state');
    assert.strictEqual(u.origin + u.pathname, 'https://discord.com/oauth2/authorize');
    assert.strictEqual(u.searchParams.get('scope'), 'identify guilds'); assert.strictEqual(u.searchParams.get('client_id'), 'app-id');
    assert.deepStrictEqual(await c.discordPoll(poll), { ok: true, pending: true });
    const page = await fetch(`${base}/discord/callback?code=${code}&state=${state}`); const html = await page.text();
    return { c, poll, state, status: page.status, html };
  }

  await ok('Discord is off unless the server is set up', async () => {
    assert.strictEqual((await new FriendsClient({ baseUrl: base }).discordConfig()).enabled, true);
    assert.strictEqual((await new FriendsClient({ baseUrl: `http://127.0.0.1:${offPort}` }).discordConfig()).enabled, false);
    assert.strictEqual((await new FriendsClient({ baseUrl: `http://127.0.0.1:${offPort}` }).discordStart('a'.repeat(64))).status, 404);
  });

  const users = {};
  await ok('sign in with Discord creates an account and gives a token once', async () => {
    for (const [name, code] of [['ann', 'code-ann'], ['ben', 'code-ben'], ['cat', 'code-cat'], ['dan', 'code-dan']]) {
      const r = await discordLogin(code);
      assert.strictEqual(r.status, 200); assert.match(r.html, /signed in/i);
      const p = await r.c.discordPoll(r.poll); assert.ok(p.ok && p.token, JSON.stringify(p));
      assert.strictEqual((await r.c.discordPoll(r.poll)).status, 404, 'the token can only be collected once');
      const me = await r.c.me(); assert.ok(me.discord.linked && me.discoverable === false);
      users[name] = r.c;
    }
    const again = await discordLogin('code-ann'); await again.c.discordPoll(again.poll);
    assert.strictEqual((await again.c.me()).username, (await users.ann.me()).username, 'same Discord person = same account');
    assert.ok(!seenSecrets.includes(undefined) && seenSecrets.every((s) => s === 'shh-secret'));
  });

  await ok('bad or reused sign-in links are refused', async () => {
    const r = await discordLogin('code-bad'); assert.strictEqual(r.status, 400); assert.match(r.html, /failed/i);
    assert.strictEqual((await fetch(`${base}/discord/callback?code=code-ann&state=${'0'.repeat(48)}`)).status, 400);
    const used = await discordLogin('code-ben');
    assert.strictEqual((await fetch(`${base}/discord/callback?code=code-ben&state=${used.state}`)).status, 400, 'a state can be used once');
    assert.strictEqual((await new FriendsClient({ baseUrl: base }).discordPoll('f'.repeat(64))).status, 404);
  });

  await ok('a Discord-only account cannot be entered with a password', async () => {
    const un = (await users.ann.me()).username;
    assert.strictEqual((await new FriendsClient({ baseUrl: base }).login(un, '')).status, 401);
    assert.strictEqual((await new FriendsClient({ baseUrl: base }).login(un, 'password-1')).status, 401);
  });

  await ok('nobody is suggested until BOTH people switch "let people find me" on', async () => {
    assert.deepStrictEqual((await users.ann.discordSuggestions()).suggestions, []);
    await users.ann.setDiscoverable(true);
    assert.deepStrictEqual((await users.ann.discordSuggestions()).suggestions, []);   // ben has not agreed yet
    await users.ben.setDiscoverable(true); await users.cat.setDiscoverable(true);
    const s = (await users.ann.discordSuggestions()).suggestions;
    assert.deepStrictEqual(s.map((x) => x.discordName).sort(), ['ben.s', 'cat']);     // dan shares no server and has not agreed
    assert.strictEqual(s.find((x) => x.discordName === 'ben.s').sharedServers, 1);
    assert.ok(!JSON.stringify(s).includes('secret server name') && !JSON.stringify(s).includes('5000002'), 'no server names or ids are shown');
    assert.strictEqual((await users.dan.discordSuggestions()).enabled, false);
  });

  await ok('suggested people can be added, and then stop being suggested', async () => {
    const s = (await users.ann.discordSuggestions()).suggestions.find((x) => x.discordName === 'ben.s');
    assert.ok((await users.ann.request(s.username)).ok);
    assert.ok(!(await users.ann.discordSuggestions()).suggestions.some((x) => x.discordName === 'ben.s'));
    const inc = (await users.ben.friends()).incoming; assert.strictEqual(inc.length, 1);
    assert.ok((await users.ben.respond(inc[0].id, true)).ok);
  });

  await ok('adding by Discord username only works for people who agreed', async () => {
    assert.ok((await users.ann.request('cat')).ok);                                       // cat agreed
    assert.strictEqual((await users.ann.request('dan')).status, 404);                     // dan did not
    await users.cat.setDiscoverable(false);
    assert.strictEqual((await users.ben.request('CAT')).status, 404);                     // cat changed her mind
    assert.strictEqual((await new FriendsClient({ baseUrl: base, token: users.dan.token }).setDiscoverable(true)).ok, true);
  });

  await ok('a Discord account can be deleted by typing DELETE', async () => {
    assert.strictEqual((await users.dan.deleteAccount('', 'nope')).status, 400);
    assert.ok((await users.dan.deleteAccount('', 'DELETE')).ok);
    assert.strictEqual((await users.dan.me()).status, 401);
    assert.strictEqual(app.db.prepare("SELECT COUNT(*) n FROM user_guilds WHERE user_id NOT IN (SELECT id FROM users)").get().n, 0);
  });

  await app.close(); await off.close(); await fake.close();
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
})();
