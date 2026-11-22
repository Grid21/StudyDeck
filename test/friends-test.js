'use strict';
// Tests the friends server and client together with several pretend users. Plain Node, no Electron.
const assert = require('assert');
const { createApp } = require('../server/server');
const { FriendsClient, checkServerUrl } = require('../core/friends-client');

let passed = 0;
async function ok(name, fn) { try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } }

(async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const client = () => new FriendsClient({ baseUrl: base });
  const today = new Date().toISOString().slice(0, 10);
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const [alice, bob, carol] = [client(), client(), client()];

  await ok('server address rules', () => {
    assert.ok(checkServerUrl('https://friends.example.com').ok);
    assert.ok(checkServerUrl('http://localhost:8787').ok);
    assert.ok(!checkServerUrl('http://friends.example.com').ok);
    assert.ok(!checkServerUrl('nonsense').ok);
  });

  await ok('register, login, wrong password, taken name, weak input', async () => {
    assert.ok((await alice.register('alice', 'password-1', 'Alice')).ok);
    assert.ok((await bob.register('bob_k', 'password-2', 'Bob')).ok);
    assert.ok((await carol.register('carol', 'password-3', 'Carol')).ok);
    assert.strictEqual((await client().register('ALICE', 'password-x', '')).status, 409);
    assert.strictEqual((await client().register('x', 'password-x', '')).status, 400);
    assert.strictEqual((await client().register('newuser', 'short', '')).status, 400);
    assert.strictEqual((await client().login('alice', 'wrong')).status, 401);
    assert.strictEqual((await client().login('nobody', 'wrong')).status, 401);
    assert.ok((await client().login('alice', 'password-1')).ok);
    assert.strictEqual((await client().friends()).status, 401);
  });

  let aliceCode, bobCode;
  await ok('friend codes, requests and accepting', async () => {
    aliceCode = (await alice.me()).friendCode; bobCode = (await bob.me()).friendCode;
    assert.match(aliceCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.strictEqual((await alice.request('ZZZZ-9999')).status, 404);
    assert.strictEqual((await alice.request(aliceCode)).status, 400);
    const rq = await alice.request(bobCode.toLowerCase().replace('-', '')); assert.ok(rq.ok && rq.status === 'pending');   // lower case, no dash
    assert.strictEqual((await alice.request('bob_k')).status, 409);                                           // duplicate
    const bl = await bob.friends(); assert.strictEqual(bl.incoming.length, 1); assert.strictEqual(bl.incoming[0].username, 'alice');
    assert.strictEqual((await carol.respond(bl.incoming[0].id, true)).status, 404);                           // not hers to accept
    assert.ok((await bob.respond(bl.incoming[0].id, true)).ok);
    assert.strictEqual((await alice.friends()).friends.length, 1);
  });

  await ok('shared subjects: friends see totals only for what is shared', async () => {
    const days = [{ day: today, subject: 'Korean', reviews: 40, correct: 30, minutes: 12 }, { day: day(2), subject: 'Korean', reviews: 20, correct: 20, minutes: 5 },
      { day: today, subject: 'Secret', reviews: 99, correct: 99, minutes: 99 }];
    assert.ok((await alice.pushProgress({ shares: ['Korean'], days, streak: 5 })).ok);      // "Secret" is not shared, so it is ignored
    assert.ok((await bob.pushProgress({ shares: ['Korean', 'Math'], days: [{ day: today, subject: 'Korean', reviews: 50, correct: 40, minutes: 10 }, { day: today, subject: 'Math', reviews: 7, correct: 7, minutes: 1 }], streak: 2 })).ok);
    const list = await bob.friends(); const a = list.friends[0];
    assert.strictEqual(a.todayReviews, 40); assert.strictEqual(a.weekReviews, 60); assert.strictEqual(a.streak, 5); assert.deepStrictEqual(a.subjects, ['Korean']);
    const cmp = await alice.compare('Korean');
    assert.deepStrictEqual(cmp.members.map((m) => m.username), ['alice', 'bob_k']);            // alice 60 > bob 50 this week
  });

  await ok('comparison order, privacy from strangers, unsharing erases', async () => {
    const cmp = await alice.compare('Korean');
    assert.strictEqual(cmp.members[0].weekReviews >= cmp.members[1].weekReviews, true);
    assert.deepStrictEqual((await carol.compare('Korean')).members, []);                        // carol is nobody's friend
    assert.strictEqual((await carol.friends()).friends.length, 0);
    assert.ok((await bob.compare('Math')).members.length === 1);
    assert.ok((await bob.pushProgress({ shares: ['Korean'], days: [], streak: 2 })).ok);         // bob stops sharing Math
    const subs = (await bob.subjects()).subjects.map((s) => s.subject);
    assert.ok(!subs.includes('Math'));
    const row = app.db.prepare("SELECT COUNT(*) n FROM progress WHERE subject='Math'").get(); assert.strictEqual(row.n, 0);
  });

  await ok('bad data is clamped or rejected, big bodies refused', async () => {
    assert.ok((await alice.pushProgress({ shares: ['Korean'], days: [{ day: 'nope', subject: 'Korean', reviews: 1 }, { day: today, subject: 'Korean', reviews: -5, correct: 'x', minutes: 1e9 }], streak: -3 })).ok);
    const res = await fetch(base + '/api/progress', { method: 'POST', headers: { Authorization: 'Bearer ' + alice.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(300000) }) });
    assert.strictEqual(res.status, 413);
    assert.strictEqual((await fetch(base + '/api/nothing')).status, 404);
  });

  await ok('remove friend, logout, delete account', async () => {
    const rm = await alice.remove('bob_k'); assert.ok(rm.ok, JSON.stringify(rm));
    assert.strictEqual((await bob.friends()).friends.length, 0);
    assert.ok((await carol.logout()).ok); assert.strictEqual((await carol.me()).status, 401);
    const c2 = client(); await c2.login('carol', 'password-3');
    assert.strictEqual((await c2.deleteAccount('wrong')).status, 401);
    assert.ok((await c2.deleteAccount('password-3')).ok);
    assert.strictEqual((await client().login('carol', 'password-3')).status, 401);
  });

  await ok('too many sign-in tries are slowed down', async () => {
    let last; for (let i = 0; i < 25; i++) last = await client().login('alice', 'bad' + i);
    assert.strictEqual(last.status, 429);
  });

  await app.close();
  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', none failed'}`);
})();
