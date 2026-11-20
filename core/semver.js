'use strict';
// Plain JavaScript, no Electron: can be reused later in a phone app.

function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// returns 1 if a > b, -1 if a < b, 0 if equal (or either is not a version)
function compare(a, b) {
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

module.exports = { parse, compare };
