'use strict';
// StudyDeck friends server. Open source, no outside libraries, needs Node.js 24 or newer.
//   node server/server.js            (listens on 127.0.0.1:8787, data in server/data/friends.db)
// Settings (environment): PORT, HOST (0.0.0.0 to accept other computers), DATA_DIR.
// It stores accounts, friendships and DAILY TOTALS for the subjects each person chose to share.
// It never sees cards, notes or deck contents. Put it behind HTTPS (a hosting service does this for you) before
// using it over the internet: passwords and tokens travel in the requests.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DAY = 86400000;
const MAX_BODY = 200 * 1024;

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function makeCode() {
  let s = ''; const b = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

function createApp({ dbPath, now = () => Date.now(), discord = null }) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT,
      salt BLOB, hash BLOB, friend_code TEXT UNIQUE, streak INTEGER DEFAULT 0, created INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER);
    CREATE TABLE IF NOT EXISTS friendships (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER, to_id INTEGER, status TEXT, created INTEGER, UNIQUE(from_id, to_id));
    CREATE TABLE IF NOT EXISTS shares (user_id INTEGER, subject TEXT, PRIMARY KEY(user_id, subject));
    CREATE TABLE IF NOT EXISTS progress (user_id INTEGER, day TEXT, subject TEXT, reviews INTEGER, correct INTEGER, minutes INTEGER, PRIMARY KEY(user_id, day, subject));
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'discord_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN discord_id TEXT; ALTER TABLE users ADD COLUMN discord_name TEXT; ALTER TABLE users ADD COLUMN discoverable INTEGER DEFAULT 0;
      CREATE UNIQUE INDEX IF NOT EXISTS users_discord ON users(discord_id);`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS user_guilds (user_id INTEGER, guild_id TEXT, PRIMARY KEY(user_id, guild_id));
    CREATE TABLE IF NOT EXISTS discord_logins (poll_hash TEXT PRIMARY KEY, state TEXT UNIQUE, created INTEGER, token TEXT, error TEXT);`);
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // very small rate limiter, per address
  const hits = new Map();
  function limit(key, max, windowMs) {
    const t = now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) throw new HttpError(429, 'Too many tries. Please wait a few minutes.');
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > windowMs) hits.delete(k);
  }

  const userRow = (id) => q('SELECT * FROM users WHERE id=?').get(id);
  const publicUser = (u) => ({ username: u.username, displayName: u.display_name || u.username });
  const sharesOf = (id) => q('SELECT subject FROM shares WHERE user_id=? ORDER BY subject').all(id).map((r) => r.subject);

  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, now() + 90 * DAY);
    return token;
  }
  function auth(req) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'Please sign in.');
    const s = q('SELECT * FROM sessions WHERE token_hash=?').get(sha(m[1]));
    if (!s || s.expires < now()) throw new HttpError(401, 'Your sign-in has expired. Please sign in again.');
    const u = userRow(s.user_id); if (!u) throw new HttpError(401, 'Please sign in.');
    return { user: u, tokenHash: s.token_hash };
  }
  const areFriends = (a, b) => !!q("SELECT 1 FROM friendships WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))").get(a, b, b, a);
  const friendIds = (id) => q("SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS fid FROM friendships WHERE status='accepted' AND (from_id=? OR to_id=?)").all(id, id, id).map((r) => r.fid);

  function summary(userId, subject) {
    const t = now(); const today = ymd(t); const d7 = ymd(t - 6 * DAY); const d30 = ymd(t - 29 * DAY);
    const f = subject ? ' AND subject=?' : ''; const a = subject ? [userId, subject] : [userId];
    const r = q(`SELECT COALESCE(SUM(CASE WHEN day=? THEN reviews END),0) tr, COALESCE(SUM(CASE WHEN day=? THEN minutes END),0) tm,
      COALESCE(SUM(CASE WHEN day>=? THEN reviews END),0) wr, COALESCE(SUM(CASE WHEN day>=? THEN correct END),0) wc,
      COALESCE(SUM(reviews),0) mr, COUNT(DISTINCT CASE WHEN day>=? THEN day END) wd FROM progress WHERE user_id=? AND day>=?${f}`).get(today, today, d7, d7, d7, ...a.slice(0, 1), d30, ...a.slice(1));
    return { todayReviews: r.tr, todayMinutes: r.tm, weekReviews: r.wr, weekCorrect: r.wc, weekDays: r.wd, monthReviews: r.mr };
  }

  const routes = {};
  const route = (method, p, fn) => { routes[method + ' ' + p] = fn; };

  route('POST', '/api/register', async (req, body) => {
    limit('reg:' + req.ip, 10, 3600000);
    const username = clean(body.username, 20);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpError(400, 'Choose a username of 3 to 20 letters, numbers or underscores.');
    const pw = String(body.password || '');
    if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'The password needs at least 8 characters.');
    if (q('SELECT 1 FROM users WHERE username=?').get(username)) throw new HttpError(409, 'That username is taken.');
    const salt = crypto.randomBytes(16); const hash = await scrypt(pw, salt);
    let id;
    for (let i = 0; i < 5 && !id; i++) {
      try { id = q('INSERT INTO users (username, display_name, salt, hash, friend_code, created) VALUES (?,?,?,?,?,?)').run(username, clean(body.displayName, 40) || username, salt, hash, makeCode(), now()).lastInsertRowid; }
      catch (e) { if (!/UNIQUE/.test(e.message) || q('SELECT 1 FROM users WHERE username=?').get(username)) throw new HttpError(409, 'That username is taken.'); }
    }
    return { token: await newSession(Number(id)) };
  });

  route('POST', '/api/login', async (req, body) => {
    limit('login:' + req.ip, 20, 900000);
    const u = q('SELECT * FROM users WHERE username=?').get(clean(body.username, 20));
    const salt = u && u.salt ? u.salt : crypto.randomBytes(16);
    const hash = await scrypt(String(body.password || '').slice(0, 200), salt);
    if (!u || !u.hash || !crypto.timingSafeEqual(Buffer.from(u.hash), hash)) throw new HttpError(401, 'Wrong username or password.');
    return { token: await newSession(u.id) };
  });

  route('POST', '/api/logout', (req) => { const { tokenHash } = auth(req); q('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); return { ok: true }; });

  route('GET', '/api/me', (req) => {
    const { user } = auth(req);
    return { username: user.username, displayName: user.display_name || user.username, friendCode: user.friend_code, shares: sharesOf(user.id),
      discord: user.discord_id ? { linked: true, name: user.discord_name } : { linked: false }, discoverable: !!user.discoverable };
  });

  route('POST', '/api/me', (req, body) => {
    const { user } = auth(req);
    const name = clean(body.displayName, 40); if (!name) throw new HttpError(400, 'The name cannot be empty.');
    q('UPDATE users SET display_name=? WHERE id=?').run(name, user.id); return { ok: true };
  });

  route('POST', '/api/friends/request', (req, body) => {
    const { user } = auth(req);
    limit('freq:' + user.id, 30, 3600000);
    const raw = clean(body.to, 40).replace(/\s/g, '');
    const code = raw.toUpperCase().replace(/^(.{4})-?(.{4})$/, '$1-$2');
    const other = q('SELECT * FROM users WHERE friend_code=?').get(code) || q('SELECT * FROM users WHERE username=?').get(raw)
      || q('SELECT * FROM users WHERE discord_name=? COLLATE NOCASE AND discoverable=1').get(raw);   // Discord name only works if that person opted in
    if (!other) throw new HttpError(404, 'No one was found with that code or username.');
    if (other.id === user.id) throw new HttpError(400, 'That is your own code.');
    const existing = q('SELECT * FROM friendships WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').get(user.id, other.id, other.id, user.id);
    if (existing) {
      if (existing.status === 'accepted') throw new HttpError(409, 'You are already friends.');
      if (existing.from_id === other.id) { q("UPDATE friendships SET status='accepted' WHERE id=?").run(existing.id); return { status: 'accepted', user: publicUser(other) }; }
      throw new HttpError(409, 'You already sent a request to this person.');
    }
    q("INSERT INTO friendships (from_id, to_id, status, created) VALUES (?,?, 'pending', ?)").run(user.id, other.id, now());
    return { status: 'pending', user: publicUser(other) };
  });

  route('POST', '/api/friends/respond', (req, body) => {
    const { user } = auth(req);
    const f = q("SELECT * FROM friendships WHERE id=? AND to_id=? AND status='pending'").get(Number(body.id) || 0, user.id);
    if (!f) throw new HttpError(404, 'That request was not found.');
    if (body.accept === true) q("UPDATE friendships SET status='accepted' WHERE id=?").run(f.id); else q('DELETE FROM friendships WHERE id=?').run(f.id);
    return { ok: true };
  });

  route('POST', '/api/friends/remove', (req, body) => {
    const { user } = auth(req);
    const other = q('SELECT id FROM users WHERE username=?').get(clean(body.username, 20)); if (!other) return { ok: true };
    q('DELETE FROM friendships WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(user.id, other.id, other.id, user.id);
    return { ok: true };
  });

  route('GET', '/api/friends', (req) => {
    const { user } = auth(req);
    const friends = friendIds(user.id).map((fid) => {
      const u = userRow(fid);
      return { ...publicUser(u), streak: u.streak, subjects: sharesOf(fid), ...summary(fid) };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const incoming = q("SELECT f.id, u.username, u.display_name FROM friendships f JOIN users u ON u.id=f.from_id WHERE f.to_id=? AND f.status='pending'").all(user.id).map((r) => ({ id: r.id, username: r.username, displayName: r.display_name || r.username }));
    const outgoing = q("SELECT f.id, u.username, u.display_name FROM friendships f JOIN users u ON u.id=f.to_id WHERE f.from_id=? AND f.status='pending'").all(user.id).map((r) => ({ id: r.id, username: r.username, displayName: r.display_name || r.username }));
    return { friends, incoming, outgoing };
  });

  route('POST', '/api/progress', (req, body) => {
    const { user } = auth(req);
    limit('prog:' + user.id, 120, 3600000);
    const shares = [...new Set((Array.isArray(body.shares) ? body.shares : []).map((s) => clean(s, 60)).filter(Boolean))].slice(0, 50);
    const days = Array.isArray(body.days) ? body.days.slice(0, 2000) : [];
    const t = now(); const lo = ymd(t - 400 * DAY), hi = ymd(t + 2 * DAY);
    tx(() => {
      q('DELETE FROM shares WHERE user_id=?').run(user.id);
      for (const s of shares) q('INSERT INTO shares VALUES (?,?)').run(user.id, s);
      const mark = shares.map(() => '?').join(',');
      q(`DELETE FROM progress WHERE user_id=?${shares.length ? ` AND subject NOT IN (${mark})` : ''}`).run(user.id, ...shares);   // un-shared subjects are erased
      for (const d of days) {
        const subject = clean(d && d.subject, 60);
        if (!shares.includes(subject) || !/^\d{4}-\d{2}-\d{2}$/.test(d.day) || d.day < lo || d.day > hi) continue;
        const reviews = Math.min(100000, Math.max(0, Math.trunc(Number(d.reviews)) || 0));
        const correct = Math.min(reviews, Math.max(0, Math.trunc(Number(d.correct)) || 0));
        const minutes = Math.min(1440, Math.max(0, Math.trunc(Number(d.minutes)) || 0));
        q('INSERT OR REPLACE INTO progress VALUES (?,?,?,?,?,?)').run(user.id, d.day, subject, reviews, correct, minutes);
      }
      q('UPDATE users SET streak=? WHERE id=?').run(Math.min(99999, Math.max(0, Math.trunc(Number(body.streak)) || 0)), user.id);
    });
    return { ok: true };
  });

  route('GET', '/api/compare', (req, body, url) => {
    const { user } = auth(req);
    const subject = clean(url.searchParams.get('subject'), 60);
    const ids = [user.id, ...friendIds(user.id)].filter((id) => q('SELECT 1 FROM shares WHERE user_id=? AND subject=?').get(id, subject));
    const members = ids.map((id) => { const u = userRow(id); return { ...publicUser(u), you: id === user.id, streak: u.streak, ...summary(id, subject) }; })
      .sort((a, b) => b.weekReviews - a.weekReviews);
    return { subject, members };
  });

  route('GET', '/api/subjects', (req) => {
    const { user } = auth(req);
    const ids = [user.id, ...friendIds(user.id)];
    const counts = new Map();
    for (const id of ids) for (const s of sharesOf(id)) counts.set(s, (counts.get(s) || 0) + 1);
    return { subjects: [...counts].map(([subject, people]) => ({ subject, people })).sort((a, b) => b.people - a.people || a.subject.localeCompare(b.subject)) };
  });

  route('POST', '/api/account/delete', async (req, body) => {
    const { user } = auth(req);
    if (user.hash) {
      const hash = await scrypt(String(body.password || '').slice(0, 200), user.salt);
      if (!crypto.timingSafeEqual(Buffer.from(user.hash), hash)) throw new HttpError(401, 'Wrong password.');
    } else if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
    tx(() => { for (const t of ['sessions', 'shares', 'progress', 'user_guilds']) q(`DELETE FROM ${t} WHERE user_id=?`).run(user.id); q('DELETE FROM friendships WHERE from_id=? OR to_id=?').run(user.id, user.id); q('DELETE FROM users WHERE id=?').run(user.id); });
    return { ok: true };
  });


  // ---- Discord sign-in (optional) ----------------------------------------------------------------
  // Needs a Discord application (Client ID + secret) set in the server's environment. Scopes asked: identify, guilds.
  // We keep: Discord user id, Discord name, and the ids of the servers you are in (only to find shared servers). The Discord
  // access token is thrown away right after sign-in.
  const dc = discord && discord.clientId && discord.clientSecret && discord.redirectUri ? { apiBase: 'https://discord.com/api/v10', authUrl: 'https://discord.com/oauth2/authorize', ...discord } : null;
  route('GET', '/api/discord/config', () => ({ enabled: !!dc }));

  route('POST', '/api/discord/start', (req, body) => {
    if (!dc) throw new HttpError(404, 'Discord sign-in is not set up on this server.');
    limit('dstart:' + req.ip, 30, 3600000);
    const poll = String(body.poll || '');
    if (!/^[a-f0-9]{32,128}$/.test(poll)) throw new HttpError(400, 'Bad request.');
    const state = crypto.randomBytes(24).toString('hex');
    q('DELETE FROM discord_logins WHERE created < ?').run(now() - 15 * 60000);
    q('INSERT OR REPLACE INTO discord_logins (poll_hash, state, created) VALUES (?,?,?)').run(sha(poll), state, now());
    const u = new URL(dc.authUrl);
    u.search = new URLSearchParams({ client_id: dc.clientId, response_type: 'code', redirect_uri: dc.redirectUri, scope: 'identify guilds', state, prompt: 'consent' }).toString();
    return { url: u.toString() };
  });

  route('POST', '/api/discord/poll', (req, body) => {
    limit('dpoll:' + req.ip, 600, 900000);
    const row = q('SELECT * FROM discord_logins WHERE poll_hash=?').get(sha(String(body.poll || '')));
    if (!row || row.created < now() - 15 * 60000) throw new HttpError(404, 'This sign-in expired. Please try again.');
    if (row.error) { q('DELETE FROM discord_logins WHERE poll_hash=?').run(row.poll_hash); return { error: row.error }; }
    if (!row.token) return { pending: true };
    q('DELETE FROM discord_logins WHERE poll_hash=?').run(row.poll_hash);
    return { token: row.token };
  });

  const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;text-align:center;margin-top:15vh"><h2>${title}</h2><p>${text}</p>`;
  async function discordFetch(url, opts) {
    const r = await fetch(url, opts); if (!r.ok) throw new Error('Discord answered ' + r.status);
    return r.json();
  }
  async function finishDiscord(code, state) {
    const row = q('SELECT * FROM discord_logins WHERE state=?').get(state);
    if (!row || row.token || row.error || row.created < now() - 15 * 60000) throw new Error('This sign-in link is not valid any more.');
    const tok = await discordFetch(dc.apiBase + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: dc.clientId, client_secret: dc.clientSecret, grant_type: 'authorization_code', code, redirect_uri: dc.redirectUri }) });
    const auth = { headers: { Authorization: 'Bearer ' + tok.access_token } };
    const me = await discordFetch(dc.apiBase + '/users/@me', auth);
    const guilds = await discordFetch(dc.apiBase + '/users/@me/guilds', auth);
    if (!me || !/^\d{5,25}$/.test(String(me.id))) throw new Error('Discord sent an unexpected answer.');
    const dname = clean(me.username, 40) || 'discord-user';
    let user = q('SELECT * FROM users WHERE discord_id=?').get(String(me.id));
    if (!user) {
      const base = (dname.replace(/[^A-Za-z0-9_]/g, '') || 'user').slice(0, 14);
      let id;
      for (let i = 0; i < 20 && !id; i++) {
        try { id = q('INSERT INTO users (username, display_name, friend_code, created, discord_id, discord_name) VALUES (?,?,?,?,?,?)')
          .run(`${base}_${crypto.randomInt(1000, 10000)}`, clean(me.global_name, 40) || dname, makeCode(), now(), String(me.id), dname).lastInsertRowid; } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
      }
      if (!id) throw new Error('Could not create the account.');
      user = userRow(Number(id));
    } else q('UPDATE users SET discord_name=? WHERE id=?').run(dname, user.id);
    tx(() => {
      q('DELETE FROM user_guilds WHERE user_id=?').run(user.id);
      for (const g of (Array.isArray(guilds) ? guilds : []).slice(0, 500)) if (/^\d{5,25}$/.test(String(g.id))) q('INSERT OR IGNORE INTO user_guilds VALUES (?,?)').run(user.id, String(g.id));
    });
    q('UPDATE discord_logins SET token=? WHERE poll_hash=?').run(await newSession(user.id), row.poll_hash);
  }
  route('GET', '/discord/callback', async (req, body, url) => {
    if (!dc) throw new HttpError(404, 'Discord sign-in is not set up on this server.');
    const state = String(url.searchParams.get('state') || ''), code = String(url.searchParams.get('code') || '');
    try {
      if (url.searchParams.get('error')) { q('UPDATE discord_logins SET error=? WHERE state=?').run('Discord sign-in was cancelled.', state); return { __html: page('Sign-in cancelled', 'You can close this window and return to StudyDeck.') }; }
      if (!/^[a-f0-9]{48}$/.test(state) || !code) throw new Error('bad');
      await finishDiscord(code, state);
      return { __html: page('You are signed in', 'You can close this window and return to StudyDeck.') };
    } catch (e) {
      console.error('discord sign-in failed:', e.message);
      return { __html: page('Sign-in failed', 'Something went wrong. Close this window and try again in StudyDeck.'), __status: 400 };
    }
  });

  route('POST', '/api/discord/discoverable', (req, body) => {
    const { user } = auth(req);
    if (!user.discord_id) throw new HttpError(400, 'Sign in with Discord first.');
    q('UPDATE users SET discoverable=? WHERE id=?').run(body.on === true ? 1 : 0, user.id);
    return { ok: true };
  });

  // People who share a Discord server with you. Both of you must have switched "let people find me" on.
  route('GET', '/api/discord/suggestions', (req) => {
    const { user } = auth(req);
    if (!user.discord_id || !user.discoverable) return { suggestions: [], enabled: false };
    const rows = q(`SELECT u.id, u.username, u.display_name, u.discord_name, COUNT(*) AS shared FROM user_guilds a JOIN user_guilds b ON a.guild_id=b.guild_id JOIN users u ON u.id=b.user_id
      WHERE a.user_id=? AND b.user_id<>? AND u.discoverable=1 GROUP BY u.id ORDER BY shared DESC, u.username LIMIT 50`).all(user.id, user.id);
    const known = new Set(q('SELECT from_id, to_id FROM friendships WHERE from_id=? OR to_id=?').all(user.id, user.id).flatMap((f) => [f.from_id, f.to_id]));
    return { enabled: true, suggestions: rows.filter((r) => !known.has(r.id)).map((r) => ({ username: r.username, displayName: r.display_name || r.username, discordName: r.discord_name, sharedServers: r.shared })) };
  });

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { ...(status === 413 ? { Connection: 'close' } : {}), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(b); };
    try {
      req.ip = req.socket.remoteAddress || '?';
      const url = new URL(req.url, 'http://x');
      const fn = routes[req.method + ' ' + url.pathname];
      if (url.pathname === '/' ) return send(200, { app: 'studydeck-friends', ok: true });
      if (!fn) throw new HttpError(404, 'Not found.');
      let body = {};
      if (req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'Too much data.'); chunks.push(c); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Bad request.'); }
        if (!body || typeof body !== 'object') throw new HttpError(400, 'Bad request.');
      }
      const out = await fn(req, body, url);
      if (out && out.__html) { res.writeHead(out.__status || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }); return res.end(out.__html); }
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message });
      else { console.error('server error:', e); send(500, { error: 'Something went wrong on the server.' }); }
    }
  });
  return { server, db, close: () => new Promise((r) => server.close(() => { db.close(); r(); })) };
}

module.exports = { createApp };

if (require.main === module) {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const e = process.env;
  const discord = e.DISCORD_CLIENT_ID && e.DISCORD_CLIENT_SECRET && e.DISCORD_REDIRECT_URI ? { clientId: e.DISCORD_CLIENT_ID, clientSecret: e.DISCORD_CLIENT_SECRET, redirectUri: e.DISCORD_REDIRECT_URI } : null;
  const { server } = createApp({ dbPath: path.join(dir, 'friends.db'), discord });
  console.log(discord ? 'Discord sign-in: on' : 'Discord sign-in: off (set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI to turn it on)');
  const port = Number(process.env.PORT) || 8787; const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`StudyDeck friends server listening on http://${host}:${port}  (data: ${dir})`));
}
