// Our own readers for what the browser engine refuses (the user, 2026-11-12: "also other typical formats (apple? etc)"):
// Apple Lossless (ALAC) in .m4a / .mp4 / .mov and in .caf, uncompressed CAF, and Sun .au.
// In: an ArrayBuffer. Out: { channels: [Float32Array...], sampleRate, bits } or { error }.
// ALAC follows Apple's open-source reference decoder (Apache 2.0): adaptive Golomb entropy coding,
// adaptive LPC prediction, stereo decorrelation.
"use strict";

const tag4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

// ---------------------------------------------------------------- bits, most significant first
class Bits {
  constructor(u8, start, end) { this.u8 = u8; this.pos = start * 8; this.end = end * 8; }
  left() { return this.end - this.pos; }
  read(n) {                                    // up to 32 bits, unsigned
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos++;
      v = v * 2 + ((this.u8[p >> 3] >> (7 - (p & 7))) & 1);
    }
    return v;
  }
  peek(n) { const p = this.pos; const v = this.read(n); this.pos = p; return v; }
  skip(n) { this.pos += n; }
  sread(n) { const v = this.read(n); return n && v >= 2 ** (n - 1) ? v - 2 ** n : v; }
}

const signExtend = (v, bits) => bits >= 32 ? v | 0 : (v << (32 - bits)) >> (32 - bits);
const log2 = x => x > 0 ? 31 - Math.clz32(x) : 0;
const signOnly = v => v < 0 ? -1 : v > 0 ? 1 : 0;

// ---------------------------------------------------------------- ALAC
function alacConfig(c, o) {
  const v = new DataView(c.buffer, c.byteOffset + o);
  return { frameLength: v.getUint32(0), bitDepth: v.getUint8(5), pb: v.getUint8(6), mb: v.getUint8(7), kb: v.getUint8(8),
           channels: v.getUint8(9), sampleRate: v.getUint32(20) };
}
// the 24-byte ALACSpecificConfig: bare, or inside an 'alac' box (size 36), sometimes after a 'frma' box
function findAlacConfig(u8) {
  for (let o = 0; o + 36 <= u8.length; o++) {
    if (u8[o + 4] === 0x61 && u8[o + 5] === 0x6c && u8[o + 6] === 0x61 && u8[o + 7] === 0x63) {   // "alac"
      const size = (u8[o] << 24 | u8[o + 1] << 16 | u8[o + 2] << 8 | u8[o + 3]) >>> 0;
      if (size === 36) return alacConfig(u8, o + 12);
    }
  }
  return u8.length >= 24 ? alacConfig(u8, 0) : null;
}

function scalar(b, k, bps) {
  let x = 0;
  while (x < 9 && b.read(1) === 1) x++;
  if (x > 8) return b.read(bps);
  if (k !== 1) {
    const extra = b.peek(k);
    x = x * ((1 << k) - 1);
    if (extra > 1) { x += extra - 1; b.skip(k); } else b.skip(k - 1);
  }
  return x;
}
function riceDecompress(b, out, n, bps, mult, cfg) {
  let history = cfg.mb, signMod = 0;
  for (let i = 0; i < n; i++) {
    let k = Math.min(log2((history >>> 9) + 3), cfg.kb);
    let x = scalar(b, k, bps) + signMod;
    signMod = 0;
    out[i] = (x >>> 1) ^ -(x & 1);
    if (x > 0xffff) history = 0xffff;
    else history = (history + x * mult - Math.floor(history * mult / 512)) >>> 0;
    if (history < 128 && i + 1 < n) {
      k = Math.min(7 - log2(history) + ((history + 16) >> 6), cfg.kb);
      const block = scalar(b, k, 16);
      if (block > 0) {
        if (block >= n - i) throw new Error("damaged ALAC frame");
        out.fill(0, i + 1, i + 1 + block);
        i += block;
      }
      if (block <= 0xffff) signMod = 1;
      history = 0;
    }
  }
}
function lpcPredict(err, out, n, bps, coefs, order, quant) {
  out[0] = err[0];
  if (n <= 1) return;
  if (!order) { for (let i = 1; i < n; i++) out[i] = err[i]; return; }
  if (order === 31) { for (let i = 1; i < n; i++) out[i] = signExtend(out[i - 1] + err[i], bps); return; }
  let i = 1;
  for (; i <= order && i < n; i++) out[i] = signExtend(out[i - 1] + err[i], bps);
  const round = quant ? 2 ** (quant - 1) : 0;
  for (; i < n; i++) {
    const base = i - order - 1, d = out[base];
    let val = 0;
    for (let j = 0; j < order; j++) val = (val + Math.imul(out[base + 1 + j] - d, coefs[j])) | 0;
    val = Math.floor((val + round) / 2 ** quant);
    let e = err[i];
    out[i] = signExtend((val + d + e) | 0, bps);
    const es = signOnly(e);
    if (es) {
      for (let j = 0; j < order && (e * es) > 0; j++) {
        let v = d - out[base + 1 + j];
        const s = signOnly(v) * es;
        coefs[j] -= s;
        v *= s;
        e -= (v >> quant) * (j + 1);
      }
    }
  }
}
// one ALAC packet -> Int32 samples per channel
function alacFrame(u8, start, end, cfg, outCh) {
  const b = new Bits(u8, start, end);
  let ch0 = 0, frames = 0;
  while (b.left() >= 3) {
    const el = b.read(3);
    if (el === 7) break;                                               // END
    if (el === 4) {                                                    // DSE: data stream, skipped
      b.skip(4); const align = b.read(1); let count = b.read(8); if (count === 255) count += b.read(8);
      if (align) b.skip((8 - (b.pos & 7)) & 7); b.skip(count * 8); continue;
    }
    if (el === 6) {                                                    // FIL: fill, skipped
      let count = b.read(4); if (count === 15) count += b.read(8) - 1; b.skip(count * 8); continue;
    }
    if (el !== 0 && el !== 1 && el !== 3) throw new Error("ALAC element " + el + " is not supported");
    const nch = el === 1 ? 2 : 1;
    b.skip(4); b.skip(12);
    const hasSize = b.read(1), extraBits = b.read(2) * 8, compressed = !b.read(1);
    const n = hasSize ? b.read(32) : cfg.frameLength;
    if (n > cfg.frameLength || n <= 0) throw new Error("damaged ALAC frame");
    const bufs = [];
    for (let c = 0; c < nch; c++) bufs.push(new Int32Array(n));
    let shift = 0, weight = 0;
    const extra = [];
    if (compressed) {
      shift = b.read(8); weight = b.read(8);
      const mode = [], quant = [], mult = [], order = [], coefs = [];
      for (let c = 0; c < nch; c++) {
        mode[c] = b.read(4); quant[c] = b.read(4); mult[c] = b.read(3); order[c] = b.read(5);
        coefs[c] = new Int32Array(32);
        for (let j = order[c] - 1; j >= 0; j--) coefs[c][j] = b.sread(16);
        if (mode[c] !== 0) throw new Error("ALAC prediction mode " + mode[c] + " is not supported");
      }
      if (extraBits) {
        for (let c = 0; c < nch; c++) extra.push(new Int32Array(n));
        for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) extra[c][i] = b.read(extraBits);
      }
      const bps = cfg.bitDepth - extraBits + nch - 1, err = new Int32Array(n);
      for (let c = 0; c < nch; c++) {
        riceDecompress(b, err, n, bps, (mult[c] * cfg.pb) >> 2, cfg);
        lpcPredict(err, bufs[c], n, bps, coefs[c], order[c], quant[c]);
      }
    } else {
      for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) bufs[c][i] = b.sread(cfg.bitDepth);
    }
    if (nch === 2 && weight) {
      const [l, r] = bufs;
      for (let i = 0; i < n; i++) { let a = l[i], bb = r[i]; a -= (Math.imul(bb, weight) >> shift); bb += a; l[i] = bb; r[i] = a; }
    }
    if (compressed && extraBits) for (let c = 0; c < nch; c++) for (let i = 0; i < n; i++) bufs[c][i] = (bufs[c][i] << extraBits) | extra[c][i];
    for (let c = 0; c < nch; c++) outCh[ch0 + c] = bufs[c];
    ch0 += nch; frames = n;
  }
  return frames;
}
function alacDecode(u8, packets, cfg) {
  const nch = Math.max(1, cfg.channels), scale = 1 / 2 ** (cfg.bitDepth - 1);
  const total = packets.length * cfg.frameLength;
  const out = Array.from({ length: nch }, () => new Float32Array(total));
  let at = 0;
  for (let k = 0; k < packets.length; k++) {
    const [s, len] = packets[k], ch = [];
    const n = alacFrame(u8, s, s + len, cfg, ch);
    for (let c = 0; c < nch; c++) { const src = ch[c] || ch[0], dst = out[c]; for (let i = 0; i < n; i++) dst[at + i] = src[i] * scale; }
    at += n;
    if ((k & 255) === 0) postMessage({ progress: k / packets.length });
  }
  return { channels: out.map(c => c.subarray(0, at)), sampleRate: cfg.sampleRate, bits: cfg.bitDepth };
}

// ---------------------------------------------------------------- MP4 / M4A / MOV with ALAC
function mp4Alac(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const boxes = (from, to, cb) => {
    for (let p = from; p + 8 <= to;) {
      let size = dv.getUint32(p), head = 8;
      const type = tag4(u8, p + 4);
      if (size === 1) { size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); head = 16; }
      else if (size === 0) size = to - p;
      if (size < head || p + size > to) break;
      if (cb(type, p + head, p + size) === false) return;
      p += size;
    }
  };
  let found = null;
  boxes(0, u8.length, (t, s, e) => {
    if (t !== "moov") return;
    boxes(s, e, (t2, s2, e2) => {
      if (t2 !== "trak" || found) return;
      const tk = {};
      const walk = (a, b) => boxes(a, b, (t3, s3, e3) => {
        if (t3 === "mdia" || t3 === "minf" || t3 === "stbl") walk(s3, e3);
        else if (t3 === "stsd" && tag4(u8, s3 + 12) === "alac") tk.cfg = findAlacConfig(u8.subarray(s3 + 8, e3));
        else if (t3 === "stsz") tk.stsz = s3;
        else if (t3 === "stco" || t3 === "co64") { tk.stco = s3; tk.co64 = t3 === "co64"; }
        else if (t3 === "stsc") tk.stsc = s3;
      });
      walk(s2, e2);
      if (tk.cfg && tk.stsz && tk.stco && tk.stsc) found = tk;
    });
    return false;
  });
  if (!found) return null;
  const { cfg } = found;
  const fixed = dv.getUint32(found.stsz + 4), count = dv.getUint32(found.stsz + 8);
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(found.stsz + 12 + i * 4);
  const nChunks = dv.getUint32(found.stco + 4), offs = new Array(nChunks);
  for (let i = 0; i < nChunks; i++) offs[i] = found.co64 ? dv.getUint32(found.stco + 8 + i * 8) * 4294967296 + dv.getUint32(found.stco + 12 + i * 8) : dv.getUint32(found.stco + 8 + i * 4);
  const nRuns = dv.getUint32(found.stsc + 4), runs = [];
  for (let i = 0; i < nRuns; i++) runs.push([dv.getUint32(found.stsc + 8 + i * 12) - 1, dv.getUint32(found.stsc + 12 + i * 12)]);
  const packets = [];
  let sample = 0;
  for (let r = 0; r < runs.length && sample < count; r++) {
    const last = r + 1 < runs.length ? runs[r + 1][0] : nChunks;
    for (let c = runs[r][0]; c < last && sample < count; c++) {
      let p = offs[c];
      for (let k = 0; k < runs[r][1] && sample < count; k++) { packets.push([p, sizes[sample]]); p += sizes[sample++]; }
    }
  }
  return alacDecode(u8, packets, cfg);
}

// ---------------------------------------------------------------- CAF
function caf(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (tag4(u8, 0) !== "caff") return null;
  let desc = null, kuki = null, pakt = null, data = null;
  for (let p = 8; p + 12 <= u8.length;) {
    const type = tag4(u8, p);
    let size = dv.getUint32(p + 4) * 4294967296 + dv.getUint32(p + 8);
    const s = p + 12;
    if (size > u8.length - s || dv.getInt32(p + 4) === -1) size = u8.length - s;      // a 'data' size of -1 runs to the end
    if (type === "desc") desc = { sr: dv.getFloat64(s), fmt: tag4(u8, s + 8), flags: dv.getUint32(s + 12), bpp: dv.getUint32(s + 16), fpp: dv.getUint32(s + 20), ch: dv.getUint32(s + 24), bits: dv.getUint32(s + 28) };
    else if (type === "kuki") kuki = u8.subarray(s, s + size);
    else if (type === "pakt") pakt = { s, e: s + size };
    else if (type === "data") data = { s: s + 4, e: s + size };
    p = s + size;
  }
  if (!desc || !data) return null;
  if (desc.fmt === "lpcm") {
    const fl = desc.flags & 1, le = !!(desc.flags & 2), bps = desc.bits / 8, ch = desc.ch;
    const frames = Math.floor((data.e - data.s) / (bps * ch)), out = Array.from({ length: ch }, () => new Float32Array(frames));
    for (let i = 0, p = data.s; i < frames; i++) for (let c = 0; c < ch; c++, p += bps) {
      let x;
      if (fl) x = bps === 8 ? dv.getFloat64(p, le) : dv.getFloat32(p, le);
      else if (bps === 1) x = dv.getInt8(p) / 128;
      else if (bps === 2) x = dv.getInt16(p, le) / 32768;
      else if (bps === 3) { let n = le ? u8[p] | u8[p + 1] << 8 | u8[p + 2] << 16 : u8[p + 2] | u8[p + 1] << 8 | u8[p] << 16; if (n & 0x800000) n -= 0x1000000; x = n / 8388608; }
      else x = dv.getInt32(p, le) / 2147483648;
      out[c][i] = x;
    }
    return { channels: out, sampleRate: desc.sr, bits: desc.bits };
  }
  if (desc.fmt === "alac") {
    if (!kuki || !pakt) return null;
    const cfg = findAlacConfig(kuki);
    const n = dv.getUint32(pakt.s) * 4294967296 + dv.getUint32(pakt.s + 4), packets = [];
    let p = pakt.s + 24, at = data.s;
    for (let i = 0; i < n && p < pakt.e; i++) {
      let len = 0, byte;
      do { byte = u8[p++]; len = len * 128 + (byte & 127); } while (byte & 128);
      packets.push([at, len]); at += len;
    }
    const res = alacDecode(u8, packets, cfg);
    const valid = dv.getUint32(pakt.s + 8) * 4294967296 + dv.getUint32(pakt.s + 12), prime = dv.getInt32(pakt.s + 16);
    if (valid > 0) res.channels = res.channels.map(c => c.subarray(prime, prime + valid));
    return res;
  }
  return { error: `CAF with ${desc.fmt} audio cannot be opened` };
}

// ---------------------------------------------------------------- Sun / NeXT .au
function au(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (tag4(u8, 0) !== ".snd") return null;
  const off = dv.getUint32(4), enc = dv.getUint32(12), sr = dv.getUint32(16), ch = dv.getUint32(20);
  const bps = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 4, 7: 8 }[enc];
  if (!bps) return { error: "this .au encoding cannot be opened" };
  const frames = Math.floor((u8.length - off) / (bps * ch)), out = Array.from({ length: ch }, () => new Float32Array(frames));
  for (let i = 0, p = off; i < frames; i++) for (let c = 0; c < ch; c++, p += bps) {
    let x;
    if (enc === 6) x = dv.getFloat32(p); else if (enc === 7) x = dv.getFloat64(p);
    else if (bps === 1) x = dv.getInt8(p) / 128; else if (bps === 2) x = dv.getInt16(p) / 32768;
    else if (bps === 3) { let n = u8[p] << 16 | u8[p + 1] << 8 | u8[p + 2]; if (n & 0x800000) n -= 0x1000000; x = n / 8388608; }
    else x = dv.getInt32(p) / 2147483648;
    out[c][i] = x;
  }
  return { channels: out, sampleRate: sr, bits: bps * 8 };
}

function decodeAny(ab) {
  const u8 = new Uint8Array(ab);
  if (tag4(u8, 0) === "caff") return caf(u8);
  if (tag4(u8, 0) === ".snd") return au(u8);
  if (tag4(u8, 4) === "ftyp" || tag4(u8, 4) === "moov" || tag4(u8, 4) === "wide" || tag4(u8, 4) === "mdat") return mp4Alac(u8);
  return null;
}

if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = e => {
    try {
      const r = decodeAny(e.data.buffer);
      if (!r) { postMessage({ none: true }); return; }
      if (r.error) { postMessage({ error: r.error }); return; }
      const ch = r.channels.map(c => c.byteOffset || c.length !== c.buffer.byteLength / 4 ? c.slice() : c);
      postMessage({ channels: ch, sampleRate: r.sampleRate, bits: r.bits }, ch.map(c => c.buffer));
    } catch (err) { postMessage({ error: String(err && err.message || err) }); }
  };
}
if (typeof module !== "undefined") module.exports = { decodeAny };
