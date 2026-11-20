'use strict';
// A tiny reader for the few protobuf messages that Anki uses inside deck files.
// Plain JavaScript, no Electron: can be reused in a phone app.

function readVarint(buf, pos) {
  let result = 0, mul = 1, b;
  let i = 0;
  do {
    if (pos + i >= buf.length) throw new Error('protobuf: unexpected end');
    b = buf[pos + i];
    result += (b & 0x7f) * mul;
    mul *= 128;
    i++;
    if (i > 10) throw new Error('protobuf: varint too long');
  } while (b & 0x80);
  return { value: result, next: pos + i };
}

// Returns a list of { field, wire, value } where value is a number (varint)
// or a Buffer (length-delimited). Fixed-size fields are skipped over.
function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos); pos = key.next;
    const field = Math.floor(key.value / 8), wire = key.value % 8;
    if (wire === 0) { const v = readVarint(buf, pos); pos = v.next; out.push({ field, wire, value: v.value }); }
    else if (wire === 2) {
      const len = readVarint(buf, pos); pos = len.next;
      if (pos + len.value > buf.length) throw new Error('protobuf: bad length');
      out.push({ field, wire, value: buf.subarray(pos, pos + len.value) }); pos += len.value;
    }
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error('protobuf: unsupported wire type ' + wire);
  }
  return out;
}

function firstField(fields, n) { const f = fields.find((x) => x.field === n); return f ? f.value : undefined; }
function str(v) { return Buffer.isBuffer(v) ? v.toString('utf8') : ''; }

module.exports = { readFields, firstField, str, readVarint };
