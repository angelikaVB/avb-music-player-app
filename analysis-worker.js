// What the player learns about a song, off the main thread:
// waveform peaks, peak/RMS, loudness (BS.1770 K-weighting, integrated with
// gating, short-term curve, LRA), tempo + beats, key + Camelot, sections.
// In: {channels, sampleRate, columns}.  Out: {stage, ...} messages, then {done: true, ...}.

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const CAMELOT = { "C major": "8B", "G major": "9B", "D major": "10B", "A major": "11B", "E major": "12B", "B major": "1B", "F# major": "2B",
  "C# major": "3B", "Ab major": "4B", "Eb major": "5B", "Bb major": "6B", "F major": "7B", "A minor": "8A", "E minor": "9A", "B minor": "10A",
  "F# minor": "11A", "C# minor": "12A", "Ab minor": "1A", "Eb minor": "2A", "Bb minor": "3A", "F minor": "4A", "C minor": "5A", "G minor": "6A", "D minor": "7A" };

onmessage = e => {
  const { channels, sampleRate: sr, columns } = e.data;
  const n = channels[0].length;
  const nch = channels.length;
  // ---- peaks for the waveform + level numbers
  const peaks = new Float32Array(columns * 2);
  const per = n / columns;
  let peak = 0, sumsq = 0;
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(c * per), b = Math.min(n, Math.floor((c + 1) * per));
    let mn = 0, mx = 0;
    for (let i = a; i < b; i++) {
      let v = 0;
      for (let k = 0; k < nch; k++) v += channels[k][i];
      v /= nch;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    peaks[c * 2] = mn; peaks[c * 2 + 1] = mx;
  }
  for (let k = 0; k < nch; k++) {
    const x = channels[k];
    for (let i = 0; i < n; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; sumsq += x[i] * x[i]; }
  }
  const rms = Math.sqrt(sumsq / (n * nch));
  postMessage({ stage: "peaks", peaks, peakDb: db(peak), rmsDb: db(rms), duration: n / sr }, [peaks.buffer]);

  // ---- loudness
  const loud = loudness(channels, sr);
  postMessage({ stage: "loudness", ...loud }, [loud.shortTerm.buffer, loud.momentary.buffer]);

  // ---- mono at 22050 for the musical analysis
  const mono = downmix(channels, sr, 22050);
  const msr = 22050;
  const tempo = tempoAndBeats(mono, msr);
  postMessage({ stage: "tempo", ...tempo });
  const key = keyOf(mono, msr);
  postMessage({ stage: "key", ...key });
  const sections = sectionsOf(mono, msr, tempo.beats, n / sr);
  postMessage({ stage: "sections", sections, done: true });
};

function db(x) { return 20 * Math.log10(Math.max(x, 1e-9)); }

function downmix(channels, sr, target) {
  const n = channels[0].length, nch = channels.length;
  const ratio = sr / target, m = Math.floor(n / ratio);
  const out = new Float32Array(m);
  // box filter + decimate (good enough for chroma/onsets)
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) for (let k = 0; k < nch; k++) s += channels[k][j];
    out[i] = s / ((b - a) * nch);
  }
  return out;
}

// ---------------------------------------------------------------- loudness (BS.1770-4)
function biquad(b0, b1, b2, a1, a2) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
function kWeight(sr) {
  // high shelf (+4 dB above ~1.5 kHz) then high-pass at ~38 Hz, as in the standard, for any sample rate
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const sb0 = (Vh + Vb * K / Q + K * K) / a0, sb1 = 2 * (K * K - Vh) / a0, sb2 = (Vh - Vb * K / Q + K * K) / a0;
  const sa1 = 2 * (K * K - 1) / a0, sa2 = (1 - K / Q + K * K) / a0;
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773, K1 = Math.tan(Math.PI * f1 / sr);
  const hb0 = 1, hb1 = -2, hb2 = 1;
  const ha0 = 1 + K1 / Q1 + K1 * K1;
  const ha1 = 2 * (K1 * K1 - 1) / ha0, ha2 = (1 - K1 / Q1 + K1 * K1) / ha0;
  return () => { const s = biquad(sb0, sb1, sb2, sa1, sa2), h = biquad(hb0 / ha0, hb1 / ha0, hb2 / ha0, ha1, ha2); return x => h(s(x)); };
}
function loudness(channels, sr) {
  const n = channels[0].length, nch = channels.length;
  const hop = Math.round(sr * 0.1);                       // 100 ms blocks of mean square, summed over channels
  const nb = Math.floor(n / hop);
  const ms = new Float64Array(nb);
  const mk = kWeight(sr);
  for (let c = 0; c < nch; c++) {
    const f = mk(); const x = channels[c];
    for (let b = 0; b < nb; b++) {
      let s = 0; const a = b * hop;
      for (let i = 0; i < hop; i++) { const y = f(x[a + i]); s += y * y; }
      ms[b] += s / hop;
    }
  }
  const lk = v => -0.691 + 10 * Math.log10(Math.max(v, 1e-12));
  const win = (len) => { const out = new Float32Array(nb); let acc = 0; for (let b = 0; b < nb; b++) { acc += ms[b]; if (b >= len) acc -= ms[b - len]; out[b] = b >= len - 1 ? lk(acc / len) : -120; } return out; };
  const momentary = win(4), shortTerm = win(30);
  // integrated: 400 ms blocks every 100 ms, absolute gate -70, relative gate -10
  const blocks = [];
  for (let b = 3; b < nb; b++) blocks.push((ms[b] + ms[b - 1] + ms[b - 2] + ms[b - 3]) / 4);
  const abs = blocks.filter(v => lk(v) > -70);
  let integrated = -120, lra = null;
  if (abs.length) {
    const mean1 = abs.reduce((a, b) => a + b, 0) / abs.length;
    const rel = abs.filter(v => lk(v) > lk(mean1) - 10);
    if (rel.length) integrated = lk(rel.reduce((a, b) => a + b, 0) / rel.length);
    // LRA from short-term (3 s) blocks, abs gate -70, rel gate -20, 10th..95th percentile
    const st = []; for (let b = 29; b < nb; b++) st.push(shortTerm[b]);
    const stAbs = st.filter(v => v > -70);
    if (stAbs.length > 2) {
      const pm = lk(stAbs.reduce((a, v) => a + Math.pow(10, (v + 0.691) / 10), 0) / stAbs.length);
      const kept = stAbs.filter(v => v > pm - 20).sort((a, b) => a - b);
      if (kept.length > 2) lra = kept[Math.floor(0.95 * (kept.length - 1))] - kept[Math.floor(0.10 * (kept.length - 1))];
    }
  }
  let stMax = -120; for (let b = 0; b < nb; b++) if (shortTerm[b] > stMax) stMax = shortTerm[b];
  return { integrated, shortTermMax: stMax, lra, shortTerm, momentary, hopSeconds: 0.1 };
}

// ---------------------------------------------------------------- FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
function spectrogram(mono, sr, nfft, hop) {
  const frames = Math.max(1, Math.floor((mono.length - nfft) / hop) + 1);
  const bins = nfft / 2 + 1;
  const win = new Float32Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / nfft);
  const mag = new Float32Array(frames * bins);
  const re = new Float32Array(nfft), im = new Float32Array(nfft);
  for (let f = 0; f < frames; f++) {
    const a = f * hop;
    for (let i = 0; i < nfft; i++) { re[i] = mono[a + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < bins; k++) mag[f * bins + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return { mag, frames, bins };
}

// ---------------------------------------------------------------- tempo
function tempoAndBeats(mono, sr) {
  const nfft = 1024, hop = 512, fps = sr / hop;
  const { mag, frames, bins } = spectrogram(mono, sr, nfft, hop);
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let s = 0;
    for (let k = 1; k < bins; k++) {
      const d = Math.log1p(100 * mag[f * bins + k]) - Math.log1p(100 * mag[(f - 1) * bins + k]);
      if (d > 0) s += d;
    }
    flux[f] = s;
  }
  // local mean removal
  const env = new Float32Array(frames);
  const w = Math.round(fps * 0.5);
  for (let f = 0; f < frames; f++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, f - w); j < Math.min(frames, f + w); j++) { s += flux[j]; c++; }
    env[f] = Math.max(0, flux[f] - s / c);
  }
  // autocorrelation over 50-220 BPM, with a gentle preference around 120
  const minLag = Math.floor(60 / 220 * fps), maxLag = Math.ceil(60 / 50 * fps);
  let best = 0, bestLag = 0, second = 0;
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += env[f] * env[f - lag];
    const bpm = 60 * fps / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
    s *= prior;
    scores.push([bpm, s]);
    if (s > best) { second = best; best = s; bestLag = lag; }
    else if (s > second) second = s;
  }
  if (!bestLag) return { bpm: 0, confidence: "", beats: [], downbeats: [] };
  // refine the lag with a parabola over its neighbours
  const at = lag => { let s = 0; for (let f = lag; f < frames; f++) s += env[f] * env[f - lag]; return s; };
  const y0 = at(bestLag - 1), y1 = at(bestLag), y2 = at(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const frac = denom ? 0.5 * (y0 - y2) / denom : 0;
  const period = (bestLag + Math.max(-0.5, Math.min(0.5, frac))) / fps;
  const bpm = 60 / period;
  // beat phase: the offset where onsets add up most
  let bestPhase = 0, bestSum = -1;
  const pf = period * fps;
  for (let ph = 0; ph < pf; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < frames; t += pf) s += env[Math.round(t)] || 0;
    if (s > bestSum) { bestSum = s; bestPhase = ph; }
  }
  const beats = [];
  for (let t = bestPhase; t < frames; t += pf) beats.push(t / fps);
  // downbeat: which of the 4 phases carries the most onset energy
  let dbBest = 0, dbSum = -1;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let i = k; i < beats.length; i += 4) s += env[Math.round(beats[i] * fps)] || 0;
    if (s > dbSum) { dbSum = s; dbBest = k; }
  }
  const downbeats = beats.filter((_, i) => (i - dbBest) % 4 === 0 && i >= dbBest);
  const ratio = second > 0 ? best / second : 2;
  const confidence = ratio > 1.5 ? "steady" : ratio > 1.15 ? "fair" : "uncertain";
  return { bpm: Math.round(bpm * 10) / 10, confidence, beats, downbeats, ratio: Math.round(ratio * 100) / 100 };
}

// ---------------------------------------------------------------- key
function keyOf(mono, sr) {
  const nfft = 4096, hop = 2048;
  const { mag, frames, bins } = spectrogram(mono, sr, nfft, hop);
  const chroma = new Float64Array(12);
  for (let k = 1; k < bins; k++) {
    const hz = k * sr / nfft;
    if (hz < 100 || hz > 2000) continue;                  // mid register: where the harmony lives
    const pc = ((Math.round(12 * Math.log2(hz / 440)) + 9) % 12 + 12) % 12;
    let s = 0;
    for (let f = 0; f < frames; f++) s += mag[f * bins + k];
    chroma[pc] += s;
  }
  const norm = Math.max(...chroma) || 1;
  for (let i = 0; i < 12; i++) chroma[i] /= norm;
  let best = "", bestR = -2, second = -2;
  for (let i = 0; i < 12; i++) {
    for (const [name, prof] of [["major", MAJOR], ["minor", MINOR]]) {
      const rolled = prof.map((_, j) => prof[((j - i) % 12 + 12) % 12]);
      const r = corr(rolled, Array.from(chroma));
      if (r > bestR) { second = bestR; bestR = r; best = `${NAMES[i]} ${name}`; }
      else if (r > second) second = r;
    }
  }
  const confidence = Math.max(0, Math.min(1, (bestR - second) * 5));
  return { key: best, camelot: CAMELOT[best] || "", keyConfidence: Math.round(confidence * 100) / 100 };
}
function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
  return da && dbb ? num / Math.sqrt(da * dbb) : 0;
}

// ---------------------------------------------------------------- sections
function sectionsOf(mono, sr, beats, duration) {
  if (duration < 20) return [{ letter: "A", name: "Part A", start: 0, end: duration, energy: 1 }];
  // band energies per ~0.5 s, in 16 log bands; novelty with a checkerboard kernel over cosine self-similarity
  const nfft = 2048, hop = 1024;
  const { mag, frames, bins } = spectrogram(mono, sr, nfft, hop);
  const nb = 16, edges = [];
  for (let i = 0; i <= nb; i++) edges.push(Math.round(Math.pow(2, Math.log2(2) + (Math.log2(bins - 1) - 1) * i / nb)));
  const step = Math.max(1, Math.round(0.5 * sr / hop));
  const T = Math.floor(frames / step);
  const feat = [];
  for (let t = 0; t < T; t++) {
    const v = new Float64Array(nb);
    for (let f = t * step; f < (t + 1) * step; f++)
      for (let b = 0; b < nb; b++) { let s = 0; for (let k = edges[b]; k < edges[b + 1]; k++) s += mag[f * bins + k]; v[b] += Math.log1p(s); }
    const len = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    feat.push(v.map(x => x / len));
  }
  const sim = (i, j) => { let s = 0; for (let b = 0; b < nb; b++) s += feat[i][b] * feat[j][b]; return s; };
  const K = 8;                                           // 4 s each side
  const nov = new Float64Array(T);
  for (let t = K; t < T - K; t++) {
    let s = 0;
    for (let i = 1; i <= K; i++) for (let j = 1; j <= K; j++) s += sim(t - i, t - j) + sim(t + i, t + j) - sim(t - i, t + j) - sim(t + i, t - j);
    nov[t] = s / (K * K);
  }
  // peaks at least 8 s apart, above the mean
  const mean = nov.reduce((a, b) => a + b, 0) / T;
  const bounds = [0];
  for (let t = K; t < T - K; t++) {
    if (nov[t] > mean && nov[t] >= nov[t - 1] && nov[t] >= nov[t + 1] && t * 0.5 - bounds[bounds.length - 1] * 0.5 >= 8) bounds.push(t);
  }
  const secs = [];
  const times = bounds.map(b => b * 0.5).concat([duration]);
  // snap boundaries to the nearest downbeat when one is close
  const snap = t => { let best = t; for (const b of beats) if (Math.abs(b - t) < 0.4 && Math.abs(b - t) < Math.abs(best - t)) best = b; return best; };
  for (let i = 0; i < times.length - 1; i++) {
    const a = i ? snap(times[i]) : 0, b = i + 2 < times.length ? snap(times[i + 1]) : duration;
    if (b - a < 2) continue;
    const ta = Math.floor(a * sr / hop / step), tb = Math.max(ta + 1, Math.floor(b * sr / hop / step));
    const prof = new Float64Array(nb); let e = 0;
    for (let t = ta; t < Math.min(T, tb); t++) for (let k = 0; k < nb; k++) prof[k] += feat[t][k];
    const seg = mono.subarray(Math.floor(a * sr), Math.floor(b * sr));
    for (let i2 = 0; i2 < seg.length; i2 += 4) e += seg[i2] * seg[i2];
    secs.push({ start: a, end: b, prof: Array.from(prof, x => x / Math.max(1, tb - ta)), energy: Math.sqrt(e / Math.max(1, seg.length / 4)) });
  }
  // letters: greedy clustering of the profiles
  const cents = [];
  for (const s of secs) {
    let best = -1, bestD = 0.985;
    for (let c = 0; c < cents.length; c++) {
      const d = cos(cents[c], s.prof);
      if (d > bestD) { bestD = d; best = c; }
    }
    if (best < 0) { cents.push(s.prof.slice()); best = cents.length - 1; }
    s.letter = String.fromCharCode(65 + Math.min(best, 25));
  }
  const top = Math.max(...secs.map(s => s.energy)) || 1;
  for (const s of secs) s.energy = s.energy / top;
  nameSections(secs);
  return secs.map(({ letter, name, start, end, energy }) => ({ letter, name, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, energy: Math.round(energy * 1000) / 1000 }));
}
function cos(a, b) { let s = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; da += a[i] * a[i]; db += b[i] * b[i]; } return da && db ? s / Math.sqrt(da * db) : 0; }
function nameSections(out) {
  if (out.length < 3) { out.forEach(d => d.name = `Part ${d.letter}`); return; }
  const counts = {}; out.forEach(d => counts[d.letter] = (counts[d.letter] || 0) + 1);
  const loud = l => { const v = out.filter(d => d.letter === l).map(d => d.energy); return v.reduce((a, b) => a + b, 0) / v.length; };
  const repeating = Object.keys(counts).filter(l => counts[l] >= 2);
  const pool = repeating.length ? repeating : Object.keys(counts);
  const chorus = pool.reduce((a, b) => loud(a) >= loud(b) ? a : b);
  const others = repeating.filter(l => l !== chorus);
  const verse = others.length ? others.reduce((a, b) => (counts[a] > counts[b] || (counts[a] === counts[b] && loud(a) <= loud(b))) ? a : b) : null;
  const top = Math.max(...out.map(d => d.energy));
  for (const d of out) d.name = d.letter === chorus ? "Chorus" : (d.letter === verse || counts[d.letter] >= 2) ? "Verse" : "Bridge";
  const first = out[0], last = out[out.length - 1];
  if ((first.letter !== chorus || counts[chorus] > 2) && first.energy < 0.8 * top && first.end - first.start <= 30) first.name = "Intro";
  if (out.length >= 4 && last.energy < 0.8 * top && last.end - last.start <= 40) last.name = "Outro";
}
