'use strict';
// A pretend Discord (OAuth pages + user info) for tests. NOT the real Discord.
const http = require('http');
const people = {   // code -> person
  'code-ann': { id: '1000000000000001', username: 'ann_k', global_name: 'Ann', guilds: ['5000001', '5000002'] },
  'code-ben': { id: '1000000000000002', username: 'ben.s', global_name: 'Ben', guilds: ['5000002', '5000003'] },
  'code-cat': { id: '1000000000000003', username: 'cat', global_name: 'Cat', guilds: ['5000002'] },
  'code-dan': { id: '1000000000000004', username: 'dan', global_name: 'Dan', guilds: ['5000009'] }
};
const tokens = new Map(); const seenSecrets = [];
const discord = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = new URLSearchParams(Buffer.concat(chunks).toString());
  const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/api/v10/oauth2/token') {
    seenSecrets.push(body.get('client_secret'));
    const p = people[body.get('code')]; if (!p || body.get('client_id') !== 'app-id' || body.get('redirect_uri') !== 'http://127.0.0.1/cb') return json({ error: 'invalid_grant' }, 400);
    const t = 'tok-' + Math.random().toString(36).slice(2); tokens.set(t, p); return json({ access_token: t });
  }
  const p = tokens.get((req.headers.authorization || '').replace('Bearer ', ''));
  if (!p) return json({ error: 'unauthorized' }, 401);
  if (req.url === '/api/v10/users/@me') return json({ id: p.id, username: p.username, global_name: p.global_name });
  if (req.url === '/api/v10/users/@me/guilds') return json(p.guilds.map((id) => ({ id, name: 'secret server name ' + id })));
  json({}, 404);
});


async function startFakeDiscord() {
  const port = await new Promise((r) => discord.listen(0, '127.0.0.1', () => r(discord.address().port)));
  return { port, apiBase: `http://127.0.0.1:${port}/api/v10`, close: () => new Promise((r) => discord.close(r)), seenSecrets };
}
module.exports = { startFakeDiscord, REDIRECT: 'http://127.0.0.1/cb' };
