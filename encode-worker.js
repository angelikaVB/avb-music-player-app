// Encodes a copy: WAV (16 / 24 / 32-bit float), FLAC (16 / 24) or MP3 (LAME).
// In: {channels, sampleRate, format: "wav"|"flac"|"mp3", bits, kbps}.
// Out: {progress} ... then {bytes: ArrayBuffer, mime} or {error}.
// No tags are written: the file carries the sound only.
importScripts("vendor/lame.min.js");                 // lamejs 1.2.1 (LGPL), the LAME MP3 encoder in JavaScript

onmessage = e => {
  const { channels, sampleRate, format, bits, kbps } = e.data;
  try {
    let bytes, mime;
    if (format === "mp3") { bytes = mp3(channels, sampleRate, kbps, e.data.keepName); mime = "audio/mpeg"; }
    else if (format === "flac") { bytes = flac(channels, sampleRate, bits); mime = "audio/flac"; }
    else { bytes = wav(channels, sampleRate, bits); mime = "audio/wav"; }
    postMessage({ bytes, mime }, [bytes]);
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
  }
};

let lastReport = 0;
const report = f => { const now = Date.now(); if (now - lastReport > 200) { lastReport = now; postMessage({ progress: f }); } };

// integer samples: TPDF dither at 16-bit, clamp at 24-bit
function toInt(x, bits) {
  const out = new Int32Array(x.length);
  if (bits === 16) {
    for (let i = 0; i < x.length; i++) {
      const v = x[i] + (Math.random() - Math.random()) / 32768;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
    }
  } else {
    for (let i = 0; i < x.length; i++) out[i] = Math.max(-8388608, Math.min(8388607, Math.round(x[i] * 8388607)));
  }
  return out;
}

// ---------------------------------------------------------------- WAV
function wav(chans, sr, bits) {
  const nch = chans.length, n = chans[0].length, bps = bits / 8, data = n * nch * bps;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nch * bps, true);
  v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true); str(36, "data"); v.setUint32(40, data, true);
  const ints = bits === 32 ? null : chans.map(c => toInt(c, bits));
  let p = 44;
  for (let i = 0; i < n; i++) {
    if (i % 65536 === 0) report(i / n);
    for (let c = 0; c < nch; c++) {
      if (bits === 32) { v.setFloat32(p, chans[c][i], true); p += 4; }
      else if (bits === 24) { const s = ints[c][i]; v.setUint8(p, s & 255); v.setUint8(p + 1, (s >> 8) & 255); v.setUint8(p + 2, (s >> 16) & 255); p += 3; }
      else { v.setInt16(p, ints[c][i], true); p += 2; }
    }
  }
  return buf;
}

// ---------------------------------------------------------------- MP3
function mp3(chans, sr, kbps, keepName) {
  const nch = Math.min(2, chans.length);
  const enc = new lamejs.Mp3Encoder(nch, sr, kbps);
  const n = chans[0].length, step = 1152 * 8;
  const L = toInt(chans[0], 16), R = nch > 1 ? toInt(chans[1], 16) : null;
  const parts = [];
  for (let i = 0; i < n; i += step) {
    report(i / n);
    const l = Int16Array.from(L.subarray(i, i + step));
    const out = R ? enc.encodeBuffer(l, Int16Array.from(R.subarray(i, i + step))) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(total);
  let p = 0; for (const part of parts) { all.set(part, p); p += part.length; }
  if (!keepName) stripEncoderName(all);
  return all.buffer;
}
// LAME writes its name and version ("LAME" + 4 bytes) into each frame's unused
// filler bytes.  Decoders never read those bytes, so they are blanked: the copy
// carries no encoder name (verified: the decoded audio is identical).
function stripEncoderName(u8) {
  let n = 0;
  for (let i = 0; i + 8 <= u8.length; i++) {
    if (u8[i] === 0x4C && u8[i + 1] === 0x41 && u8[i + 2] === 0x4D && u8[i + 3] === 0x45 && u8[i + 4] < 10 && u8[i + 5] < 100) {
      for (let k = 0; k < 8; k++) u8[i + k] = 0;
      n++; i += 7;
    }
  }
  return n;
}

// ---------------------------------------------------------------- FLAC
// A plain, standard FLAC encoder: 4096-sample frames, each channel coded with
// the best of the fixed predictors (order 0-4), residuals Rice-coded in up to
// 16 partitions (escape to raw bits where Rice does not pay).
class Bits {
  constructor(size) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.n = 0; }
  grow(need) { if (this.pos + need + 16 > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need + 4096)); b.set(this.buf); this.buf = b; } }
  write(v, n) {                                             // v unsigned, n <= 32
    if (n > 24) { this.write(Math.floor(v / 16777216), n - 24); v = v % 16777216; n = 24; }
    this.grow(4);
    this.acc = this.acc * Math.pow(2, n) + v; this.n += n;
    while (this.n >= 8) { this.n -= 8; const d = Math.pow(2, this.n); const byte = Math.floor(this.acc / d); this.buf[this.pos++] = byte & 255; this.acc -= byte * d; }
  }
  signed(v, n) { this.write(v < 0 ? v + Math.pow(2, n) : v, n); }
  unary(q) { while (q >= 24) { this.write(0, 24); q -= 24; } this.write(1, q + 1); }
  align() { if (this.n) this.write(0, 8 - this.n); }
  bytes() { return this.buf.subarray(0, this.pos); }
}
const CRC8 = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; t[i] = c; } return t; })();
const CRC16 = (() => { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; t[i] = c; } return t; })();
const crc8 = b => { let c = 0; for (let i = 0; i < b.length; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = b => { let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

function residuals(x, order) {
  const n = x.length, r = new Int32Array(n - order);
  for (let i = order; i < n; i++) {
    let p = 0;
    if (order === 1) p = x[i - 1];
    else if (order === 2) p = 2 * x[i - 1] - x[i - 2];
    else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
    else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
    r[i - order] = x[i] - p;
  }
  return r;
}
const zig = v => v >= 0 ? v * 2 : -v * 2 - 1;
// cost of Rice-coding a partition from its size and the sum of its zig-zagged residuals
// (estimated: one pass over the samples per predictor, not one per parameter)
function riceEstimate(n, sum, maxAbs) {
  if (!n) return { k: 0, cost: 4 };
  const mean = sum / n;
  let k = mean > 1 ? Math.floor(Math.log2(mean)) : 0;
  let best = null;
  for (const kk of [k - 1, k, k + 1]) {
    if (kk < 0) continue;
    const cost = 4 + n * (kk + 1) + Math.floor(sum / Math.pow(2, kk));
    if (!best || cost < best.cost) best = { k: kk, cost };
  }
  const raw = maxAbs ? Math.ceil(Math.log2(maxAbs + 1)) + 1 : 0;
  const esc = 4 + 5 + n * raw;
  if (best.k > 14 || esc < best.cost) return { k: 15, raw, cost: esc };
  return best;
}
function writeSubframe(bw, x, bps) {
  let constant = true; for (let i = 1; i < x.length; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) { bw.write(0, 8); bw.signed(x[0], bps); return; }
  let best = null;
  for (let order = 0; order <= 4 && order < x.length; order++) {
    const r = residuals(x, order);
    let po = 0;
    while (po < 4 && x.length % (1 << (po + 1)) === 0 && (x.length >> (po + 1)) > order) po++;
    // sums and peaks per finest partition, then merged for the coarser ones
    const parts = 1 << po, size = x.length >> po;
    const sums = new Float64Array(parts), maxs = new Float64Array(parts);
    for (let j = 0; j < parts; j++) {
      const a = j === 0 ? 0 : j * size - order, b = (j + 1) * size - order;
      let s = 0, m = 0; for (let i = a; i < b; i++) { const v = r[i]; s += v >= 0 ? v * 2 : -v * 2 - 1; const av = v < 0 ? -v : v; if (av > m) m = av; }
      sums[j] = s; maxs[j] = m;
    }
    let bestPart = null;
    for (let p = 0; p <= po; p++) {
      const n2 = 1 << p, group = parts / n2, sz = x.length >> p; let cost = 0; const ks = [];
      for (let j = 0; j < n2; j++) {
        let s = 0, m = 0; for (let g = j * group; g < (j + 1) * group; g++) { s += sums[g]; if (maxs[g] > m) m = maxs[g]; }
        const c = riceEstimate(j === 0 ? sz - order : sz, s, m); ks.push(c); cost += c.cost;
      }
      if (!bestPart || cost < bestPart.cost) bestPart = { p, ks, cost };
    }
    const total = order * bps + 6 + bestPart.cost;
    if (!best || total < best.total) best = { order, r, part: bestPart, total };
  }
  if (best.total >= x.length * bps) { bw.write(0b00000010, 8); for (let i = 0; i < x.length; i++) bw.signed(x[i], bps); return; }   // verbatim
  bw.write((0b001000 | best.order) << 1, 8);
  for (let i = 0; i < best.order; i++) bw.signed(x[i], bps);
  bw.write(0, 2);                                           // Rice, 4-bit parameters
  bw.write(best.part.p, 4);
  const parts = 1 << best.part.p, size = x.length >> best.part.p;
  for (let j = 0; j < parts; j++) {
    const a = j === 0 ? 0 : j * size - best.order, b = (j + 1) * size - best.order, c = best.part.ks[j];
    bw.write(c.k, 4);
    if (c.k === 15) { bw.write(c.raw, 5); for (let i = a; i < b; i++) bw.signed(best.r[i], c.raw); continue; }
    const d = Math.pow(2, c.k);
    for (let i = a; i < b; i++) { const u = zig(best.r[i]); bw.unary(Math.floor(u / d)); if (c.k) bw.write(u % d, c.k); }
  }
}
function utf8num(n) {
  if (n < 0x80) return [n];
  const out = []; let bytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  for (let i = bytes - 1; i > 0; i--) { out.unshift(0x80 | (n & 0x3f)); n = Math.floor(n / 64); }
  out.unshift(((0xff00 >> bytes) & 0xff) | n);
  return out;
}
function flac(chans, sr, bits) {
  const nch = chans.length, n = chans[0].length, BS = 4096;
  const ints = chans.map(c => toInt(c, bits));
  const out = new Bits(Math.max(1 << 20, n * nch * bits / 8 * 0.7));
  // "fLaC" + STREAMINFO (last metadata block)
  out.write(0x664c6143, 32);
  out.write(1, 1); out.write(0, 7); out.write(34, 24);
  out.write(BS, 16); out.write(BS, 16); out.write(0, 24); out.write(0, 24);
  out.write(sr, 20); out.write(nch - 1, 3); out.write(bits - 1, 5);
  out.write(Math.floor(n / 4294967296), 4); out.write(n % 4294967296, 32);
  for (let i = 0; i < 16; i++) out.write(0, 8);            // MD5 left empty: allowed ("not computed")
  const sizeCode = bits === 16 ? 0b100 : 0b110;
  let frame = 0;
  for (let start = 0; start < n; start += BS, frame++) {
    report(start / n);
    const len = Math.min(BS, n - start);
    const fw = new Bits(len * nch * 4 + 64);
    fw.write(0b11111111111110, 14); fw.write(0, 1); fw.write(0, 1);
    fw.write(len === BS ? 0b1100 : 0b0111, 4);             // 4096, or "16-bit size at the end"
    fw.write(0, 4);                                         // sample rate from STREAMINFO
    fw.write(nch - 1, 4); fw.write(sizeCode, 3); fw.write(0, 1);
    for (const b of utf8num(frame)) fw.write(b, 8);
    if (len !== BS) fw.write(len - 1, 16);
    fw.align();
    fw.write(crc8(fw.bytes()), 8);
    for (let c = 0; c < nch; c++) writeSubframe(fw, ints[c].subarray(start, start + len), bits);
    fw.align();
    fw.write(crc16(fw.bytes()), 16);
    const fb = fw.bytes();
    out.grow(fb.length);
    out.buf.set(fb, out.pos); out.pos += fb.length;
  }
  return out.bytes().slice().buffer;
}
