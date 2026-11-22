'use strict';
// A fetch() look-alike built on Electron's net.request (the module is passed in, so this file has no Electron code of its own).
// Why: Electron's net.fetch cannot show a redirect. With redirect "follow" it posts to the new address WITHOUT the request path
// (AnkiWeb then answers "405 Not Allowed"), and with "manual" it throws. net.request tells us the new address, so the sync code
// can send the request there itself. It also uses the system's proxy and certificate settings, like the rest of the program.
function makeFetch(net, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return function fetchViaRequest(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const manual = opts.redirect === 'manual';
      const req = net.request({ method: opts.method || 'GET', url, redirect: manual ? 'manual' : 'follow' });
      for (const [k, v] of Object.entries(opts.headers || {})) req.setHeader(k, v);
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => { try { req.abort(); } catch { /* already finished */ } finish(reject, new Error('The request took too long.')); }, timeoutMs);
      const make = (status, headers, buf) => ({
        status, ok: status >= 200 && status < 300, type: 'default',
        headers: { get: (n) => { const v = headers[String(n).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v == null ? null : String(v)); } },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        text: async () => buf.toString('utf8'),
        json: async () => JSON.parse(buf.toString('utf8'))
      });
      req.on('redirect', (code, _method, redirectUrl) => {
        if (!manual) { req.followRedirect(); return; }
        try { req.abort(); } catch { /* ignore */ }
        finish(resolve, make(code, { location: redirectUrl }, Buffer.alloc(0)));
      });
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(resolve, make(res.statusCode, res.headers, Buffer.concat(chunks))));
        res.on('error', (e) => finish(reject, e));
      });
      req.on('error', (e) => finish(reject, e));
      if (opts.body != null) req.write(Buffer.from(opts.body));
      req.end();
    });
  };
}

module.exports = { makeFetch };
