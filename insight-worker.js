// The Info tab's measurements of a song, off the main thread (the user, 2026-11-01: "Audio Truth" panels).
// Everything here is measured from the samples; nothing is guessed about instruments - a stereo mix has none
// to tell apart, so bands are named as bands ("40-120 Hz, the kick's range"), never as instruments.
//
// In: {channels, sampleRate, light}.  Out: {progress, stage} messages, then {done: true, result} or {error}.
// light (a reference song): only the whole-song numbers, plus its own loudness and true peak.
// The FFT, BS.1770 loudness and true peak are the analysis worker's own (importScripts), not copies.

importScripts("analysis-worker.js");

const NB = 120, F0 = 20;                                  // 1/12-octave bands, 20 Hz .. 20 kHz
const fc = b => F0 * Math.pow(2, (b + 0.5) / 12);         // a band's center
const bandOf = f => Math.floor(12 * Math.log2(f / F0));
const GROUPS = [["Sub", 20, 60], ["Bass", 60, 250], ["Low-mid", 250, 1000], ["Mid", 1000, 4000], ["High", 4000, 20000]];
const NFFT = 4096;

onmessage = e => {
  const { channels, sampleRate, light } = e.data;
  try {
    const result = measure(channels, sampleRate, !!light);
    const moved = [];
    for (const v of Object.values(result)) if (ArrayBuffer.isView(v)) moved.push(v.buffer);
    postMessage({ done: true, result }, moved);
  } catch (err) { postMessage({ error: String(err && err.message || err) }); }
};
const say = (p, stage) => postMessage({ progress: p, stage });

function rbj(type, f, sr, q = Math.SQRT1_2) {           // a 2nd-order Butterworth filter (Audio EQ Cookbook)
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a;
  return type === "lp" ? biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - a) / a0)
    : biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - a) / a0);
}
const pct = (arr, p) => { if (!arr.length) return null; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const dB10 = x => 10 * Math.log10(Math.max(x, 1e-20));

function measure(channels, sr, light) {
  const L = channels[0], R = channels.length > 1 ? channels[1] : channels[0], n = L.length, dur = n / sr;
  const stereo = channels.length > 1;
  // ---------------------------------------------------------------- spectra: mid and side in one FFT
  const binBand = new Int16Array(NFFT / 2).fill(-1);
  for (let k = 1; k < NFFT / 2; k++) { const b = bandOf(k * sr / NFFT); if (b >= 0 && b < NB) binBand[k] = b; }
  const hasBin = new Uint8Array(NB); for (const b of binBand) if (b >= 0) hasBin[b] = 1;
  const top = Math.min(NB, bandOf(sr / 2));                // bands above Nyquist stay empty
  const nearest = new Int16Array(NB); for (let b = 0; b < NB; b++) nearest[b] = Math.max(1, Math.min(NFFT / 2 - 1, Math.round(fc(b) * NFFT / sr)));
  const win = new Float32Array(NFFT); for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
  const frames = Math.max(1, Math.floor((n - NFFT) / NFFT) + 1);
  const bandM = new Float32Array(frames * NB);             // mid power per frame and band
  const sumS = new Float64Array(NB), sumM = new Float64Array(NB);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), pm = new Float64Array(NFFT / 2), ps = new Float64Array(NFFT / 2);
  for (let f = 0; f < frames; f++) {
    const a = f * NFFT;
    for (let i = 0; i < NFFT; i++) { const l = L[a + i] || 0, r = R[a + i] || 0; re[i] = (l + r) * 0.5 * win[i]; im[i] = (l - r) * 0.5 * win[i]; }
    fft(re, im);
    for (let k = 1; k < NFFT / 2; k++) {
      const j = NFFT - k;
      const mr = (re[k] + re[j]) / 2, mi = (im[k] - im[j]) / 2, sr_ = (im[k] + im[j]) / 2, si = -(re[k] - re[j]) / 2;
      pm[k] = mr * mr + mi * mi; ps[k] = sr_ * sr_ + si * si;
      const b = binBand[k]; if (b < 0) continue;
      bandM[f * NB + b] += pm[k]; sumM[b] += pm[k]; sumS[b] += ps[k];
    }
    for (let b = 0; b < top; b++) if (!hasBin[b]) { const k = nearest[b]; bandM[f * NB + b] = pm[k]; sumM[b] += pm[k]; sumS[b] += ps[k]; }
    if (f % 200 === 0) say(0.05 + 0.45 * f / frames, "Spectrum");
  }
  // frames that are music, not silence: within 60 dB of the loudest
  const fE = new Float64Array(frames); let fMax = 0;
  for (let f = 0; f < frames; f++) { let s = 0; for (let b = 0; b < NB; b++) s += bandM[f * NB + b]; fE[f] = s; if (s > fMax) fMax = s; }
  const live = f => fE[f] > fMax * 1e-6;
  const avg = new Float64Array(NB); let nLive = 0;
  for (let f = 0; f < frames; f++) if (live(f)) { nLive++; for (let b = 0; b < NB; b++) avg[b] += bandM[f * NB + b]; }
  const avgDb = new Float32Array(NB);                      // absolute: a reference is matched to it by loudness
  for (let b = 0; b < NB; b++) avgDb[b] = b < top ? dB10(avg[b] / Math.max(1, nLive)) : -200;
  const inGroup = (b, lo, hi) => fc(b) >= lo && fc(b) < hi;
  let tot = 0; for (let b = 0; b < top; b++) tot += avg[b];
  const groups = GROUPS.map(([name, lo, hi]) => { let s = 0; for (let b = 0; b < top; b++) if (inGroup(b, lo, hi)) s += avg[b]; return { name, lo, hi, db: dB10(s / tot) }; });
  // tilt: a straight line through the spectrum, 100 Hz - 10 kHz, in dB per octave
  let sx = 0, sy = 0, sxx = 0, sxy = 0, k0 = 0;
  for (let b = 0; b < top; b++) { const f = fc(b); if (f < 100 || f > 10000) continue; const x = Math.log2(f), y = avgDb[b]; sx += x; sy += y; sxx += x * x; sxy += x * y; k0++; }
  const tilt = k0 > 2 ? (k0 * sxy - sx * sy) / (k0 * sxx - sx * sx) : null;
  // stereo by band: the side's share of the energy (0 % = mono, 50 % = left and right unrelated)
  const share = (lo, hi) => { let m = 0, s = 0; for (let b = 0; b < top; b++) if (inGroup(b, lo, hi)) { m += sumM[b]; s += sumS[b]; } return m + s > 0 ? 100 * s / (m + s) : 0; };
  const sideGroups = GROUPS.map(([name, lo, hi]) => ({ name, pct: share(lo, hi) }));
  const sideAll = share(20, 20000), sideLow = share(20, 120);
  say(0.5, "Punch");
  // ---------------------------------------------------------------- time domain: hits, crest, correlation, mono sum
  const blk = Math.max(1, Math.round(sr * 0.005)), nbk = Math.floor(n / blk);
  const envLo = new Float32Array(nbk), envHi = new Float32Array(nbk);
  const loH = rbj("hp", 40, sr), loL = rbj("lp", 120, sr), hiH = rbj("hp", 1500, sr), hiL = rbj("lp", 5000, sr);
  const W1 = Math.round(sr);                               // 1 s windows: correlation; 3 s windows: short-term crest
  const nW = Math.max(1, Math.floor(n / W1));
  const corrW = new Float32Array(nW);
  let LL = 0, RR = 0, MM = 0, wl = 0, wr = 0, wlr = 0, peakAll = 0, sqAll = 0;
  const crest3 = []; let p3 = 0, s3 = 0, c3 = 0;
  for (let bk = 0, i = 0; bk < nbk; bk++) {
    let el = 0, eh = 0;
    for (let j = 0; j < blk; j++, i++) {
      const l = L[i], r = R[i], m = (l + r) * 0.5;
      const yl = loL(loH(m)), yh = hiL(hiH(m));
      el += yl * yl; eh += yh * yh;
      LL += l * l; RR += r * r; MM += m * m; wl += l * l; wr += r * r; wlr += l * r;
      const am = Math.abs(m); if (am > peakAll) peakAll = am; sqAll += m * m;
      if (am > p3) p3 = am; s3 += m * m; c3++;
      if ((i + 1) % W1 === 0) { const w = (i + 1) / W1 - 1; if (w < nW) corrW[w] = wl > 1e-9 && wr > 1e-9 ? wlr / Math.sqrt(wl * wr) : 1; wl = wr = wlr = 0; }
      if (c3 === 3 * W1) { if (s3 > 0) crest3.push({ crest: 20 * Math.log10(p3 / Math.sqrt(s3 / c3)), rms: s3 / c3 }); p3 = s3 = c3 = 0; }
    }
    envLo[bk] = Math.sqrt(el / blk); envHi[bk] = Math.sqrt(eh / blk);
    if (bk % 20000 === 0) say(0.5 + 0.3 * bk / nbk, "Punch");
  }
  const loudest3 = crest3.reduce((a, c) => Math.max(a, c.rms), 0);
  const crestLive = crest3.filter(c => c.rms > loudest3 * 0.01).map(c => c.crest);   // within 20 dB of the loudest 3 s
  const monoDrop = stereo && LL + RR > 0 ? dB10(MM / ((LL + RR) / 2)) : 0;
  // hits: the band's level (15 ms average) jumping 6 dB+ from its low in the 50 ms before, the highest point
  // within 100 ms either side, within 30 dB of the band's loudest
  const hits = env => {
    let mx = 0; for (const v of env) if (v > mx) mx = v;
    const sm = Float32Array.from(env, (v, i) => (v + (env[i - 1] ?? v) + (env[i - 2] ?? v)) / 3);
    const dbv = Float32Array.from(sm, v => 20 * Math.log10(Math.max(v, mx * 1e-4)));
    const floor = 20 * Math.log10(mx) - 30, rises = [], times = [];
    for (let i = 10; i < dbv.length - 20; i++) {
      if (dbv[i] < floor) continue;
      let peak = true; for (let j = i - 20; j <= i + 20; j++) if (j !== i && dbv[j] > dbv[i]) { peak = false; break; }
      if (!peak) continue;
      let lo = Infinity; for (let j = i - 10; j < i; j++) lo = Math.min(lo, dbv[j]);
      const rise = dbv[i] - lo; if (rise < 6) continue;
      rises.push(rise); times.push(i);
    }
    return { rise: pct(rises, 0.5), perMin: rises.length / (dur / 60), count: rises.length };
  };
  const hitLo = hits(envLo), hitHi = hits(envHi);
  say(0.82, "Clarity");
  // ---------------------------------------------------------------- clarity over time: 1 s windows of the spectrum
  const fpw = Math.max(1, Math.round(sr / NFFT));          // frames per window (about 1 s)
  const nWin = Math.max(1, Math.floor(frames / fpw));
  const lowMid = new Float32Array(nWin), harsh = new Float32Array(nWin), winDb = new Float32Array(nWin), crowd = new Float32Array(nWin);
  const thirds = []; for (let b = bandOf(100); b + 4 <= Math.min(top, bandOf(5000)); b += 4) thirds.push(b);
  for (let w = 0; w < nWin; w++) {
    const e = new Float64Array(NB);
    for (let f = w * fpw; f < (w + 1) * fpw; f++) for (let b = 0; b < NB; b++) e[b] += bandM[f * NB + b];
    let all = 0, lm = 0, hs = 0;
    for (let b = 0; b < top; b++) { all += e[b]; const f = fc(b); if (f >= 200 && f < 500) lm += e[b]; if (f >= 2000 && f < 5000) hs += e[b]; }
    lowMid[w] = dB10(lm / all); harsh[w] = dB10(hs / all); winDb[w] = dB10(all / fpw);
    const t = thirds.map(b => dB10(e[b] + e[b + 1] + e[b + 2] + e[b + 3])); const mx = Math.max(...t);
    crowd[w] = t.filter(v => v > mx - 6).length / t.length;
  }
  const maxWin = Math.max(...winDb);
  const active = []; for (let w = 0; w < nWin; w++) if (winDb[w] > maxWin - 20) active.push(w);
  const medLM = pct(active.map(w => lowMid[w]), 0.5) ?? 0, medH = pct(active.map(w => harsh[w]), 0.5) ?? 0;
  const lmOver = Float32Array.from(lowMid, (v, w) => winDb[w] > maxWin - 20 ? v - medLM : 0);
  const hOver = Float32Array.from(harsh, (v, w) => winDb[w] > maxWin - 20 ? v - medH : 0);
  const secPerWin = fpw * NFFT / sr;
  const spans = (over, kind) => {
    const out = [];
    for (let w = 0; w < nWin; w++) if (over[w] >= 3) {
      const last = out[out.length - 1];
      if (last && w - last.w1 <= 1) { last.w1 = w; last.db = Math.max(last.db, over[w]); } else out.push({ kind, w0: w, w1: w, db: over[w] });
    }
    return out.map(s => ({ kind, t: s.w0 * secPerWin, end: (s.w1 + 1) * secPerWin, db: s.db }));
  };
  const events = [...spans(lmOver, "lowmid"), ...spans(hOver, "harsh")];
  const negCorr = [];                                      // stretches where left and right work against each other
  for (let w = 0; w < nW; w++) if (corrW[w] < 0) {
    const last = negCorr[negCorr.length - 1];
    if (last && w - last.w1 <= 1) { last.w1 = w; last.c = Math.min(last.c, corrW[w]); } else negCorr.push({ w0: w, w1: w, c: corrW[w] });
  }
  const result = {
    v: 1, duration: dur, avgDb, groups, tilt, sideGroups, sideAll, sideLow, monoDrop, stereo,
    crestDb: peakAll > 0 && sqAll > 0 ? 20 * Math.log10(peakAll / Math.sqrt(sqAll / n)) : null,
    crest3: { med: pct(crestLive, 0.5), lo: pct(crestLive, 0.1), hi: pct(crestLive, 0.9) },
    hitLo, hitHi, medLowMid: medLM, medHarsh: medH, crowdMed: pct(active.map(w => crowd[w]), 0.5), crowdBands: thirds.length,
    activePct: { lowmid: 100 * active.filter(w => lmOver[w] >= 3).length / Math.max(1, active.length), harsh: 100 * active.filter(w => hOver[w] >= 3).length / Math.max(1, active.length) },
    negCorr: negCorr.slice(0, 20).map(x => ({ t: x.w0 * W1 / sr, end: (x.w1 + 1) * W1 / sr, c: x.c })), minCorr: nW ? Math.min(...corrW) : null,
  };
  if (light) {
    say(0.9, "Loudness");
    const l = loudness(channels, sr), c = checks(channels, sr);
    Object.assign(result, { integrated: l.integrated, lra: l.lra, shortTermMax: l.shortTermMax, truePeakDb: c.truePeakDb, correlation: c.correlation });
    return result;
  }
  // ---------------------------------------------------------------- pictures: spectrogram, hit strips, clarity lines
  const C = Math.min(frames, 720), img = new Uint8Array(C * NB);
  const colDb = new Float32Array(C * NB); let gMax = -400;
  for (let c = 0; c < C; c++) {
    const f0 = Math.floor(c * frames / C), f1 = Math.max(f0 + 1, Math.floor((c + 1) * frames / C));
    for (let b = 0; b < NB; b++) { let s = 0; for (let f = f0; f < f1; f++) s += bandM[f * NB + b]; const v = b < top ? dB10(s / (f1 - f0)) : -400; colDb[c * NB + b] = v; if (v > gMax) gMax = v; }
  }
  for (let i = 0; i < C * NB; i++) img[i] = Math.max(0, Math.min(255, Math.round(255 * (colDb[i] - (gMax - 80)) / 80)));
  const strip = env => { const S = 900, out = new Uint8Array(S); let mx = 0; for (const v of env) if (v > mx) mx = v; for (let s = 0; s < S; s++) { const a = Math.floor(s * env.length / S), b = Math.max(a + 1, Math.floor((s + 1) * env.length / S)); let m = 0; for (let i = a; i < b; i++) if (env[i] > m) m = env[i]; out[s] = mx > 0 ? Math.round(255 * m / mx) : 0; } return out; };
  Object.assign(result, { img, imgCols: C, imgRows: NB, top, stripLo: strip(envLo), stripHi: strip(envHi), lmOver, hOver, secPerWin, events, corrW });
  return result;
}
