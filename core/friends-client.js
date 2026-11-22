'use strict';
// Talks to a StudyDeck friends server. Plain JavaScript, no Electron: can be reused in a phone app.
// Every method returns { ok: true, ...data } or { ok: false, error: 'friendly message' }.

function checkServerUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, error: 'That is not a web address. Example: https://friends.example.com' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'The address must start with https://' };
  const h = u.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (u.protocol === 'http:' && !local) return { ok: false, error: 'Use an https:// address. Plain http:// would send your password in the open.' };
  return { ok: true, url: u.origin };
}

class FriendsClient {
  constructor({ baseUrl, token, fetchFn }) { this.baseUrl = baseUrl; this.token = token || ''; this.fetchFn = fetchFn || fetch; }

  async call(method, path, body) {
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined
      });
      let data = {};
      try { data = await res.json(); } catch { /* not json */ }
      if (!res.ok) return { ok: false, status: res.status, error: data.error || `The server answered with error ${res.status}.` };
      return { ok: true, ...data };
    } catch { return { ok: false, error: 'Could not reach the friends server. Check the address and your internet connection.' }; }
  }

  async register(username, password, displayName) { const r = await this.call('POST', '/api/register', { username, password, displayName }); if (r.ok) this.token = r.token; return r; }
  async login(username, password) { const r = await this.call('POST', '/api/login', { username, password }); if (r.ok) this.token = r.token; return r; }
  logout() { return this.call('POST', '/api/logout'); }
  me() { return this.call('GET', '/api/me'); }
  friends() { return this.call('GET', '/api/friends'); }
  request(to) { return this.call('POST', '/api/friends/request', { to }); }
  respond(id, accept) { return this.call('POST', '/api/friends/respond', { id, accept: !!accept }); }
  remove(username) { return this.call('POST', '/api/friends/remove', { username }); }
  pushProgress({ shares, days, streak }) { return this.call('POST', '/api/progress', { shares, days, streak }); }
  compare(subject) { return this.call('GET', '/api/compare?subject=' + encodeURIComponent(subject)); }
  subjects() { return this.call('GET', '/api/subjects'); }
  discordConfig() { return this.call('GET', '/api/discord/config'); }
  discordStart(poll) { return this.call('POST', '/api/discord/start', { poll }); }
  async discordPoll(poll) { const r = await this.call('POST', '/api/discord/poll', { poll }); if (r.ok && r.token) this.token = r.token; return r; }
  setDiscoverable(on) { return this.call('POST', '/api/discord/discoverable', { on: !!on }); }
  discordSuggestions() { return this.call('GET', '/api/discord/suggestions'); }
  deleteAccount(password, confirm) { return this.call('POST', '/api/account/delete', { password, confirm }); }
}

module.exports = { FriendsClient, checkServerUrl };
