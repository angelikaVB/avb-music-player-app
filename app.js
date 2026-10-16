// AVB Music Player - phone version.  Everything runs on the phone: songs you
// open are copied into the app's own storage, analysed in a worker, played by
// an AudioWorklet, re-timed/re-pitched by Rubber Band in WebAssembly.

const $ = s => document.querySelector(s);
const RUN = ["#22D3EE", "#3B82F6", "#8B5CF6", "#D946EF", "#EC4899", "#F97316"];
const SECTION_COLOURS = { Intro: "#2563EB", Verse: "#7C3AED", Chorus: "#C026D3", Bridge: "#EA580C", Outro: "#D97706", Part: "#0E7490" };

// ---------------------------------------------------------------- storage
const db = await new Promise((ok, no) => {
  const r = indexedDB.open("avb-music-player", 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("songs", { keyPath: "id" }); d.createObjectStore("kv"); };
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
});
const tx = (store, mode, fn) => new Promise((ok, no) => { const t = db.transaction(store, mode); const req = fn(t.objectStore(store)); t.oncomplete = () => ok(req && req.result); t.onerror = () => no(t.error); });
const kvGet = async (k, d) => { const v = await new Promise((ok, no) => { const t = db.transaction("kv"); const r = t.objectStore("kv").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); return v === undefined ? d : v; };
const kvSet = (k, v) => tx("kv", "readwrite", s => s.put(v, k));
const songsAll = () => new Promise((ok, no) => { const t = db.transaction("songs"); const r = t.objectStore("songs").getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const songGet = id => new Promise((ok, no) => { const t = db.transaction("songs"); const r = t.objectStore("songs").get(id); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

const lib = {
  queue: await kvGet("queue", []), index: await kvGet("index", -1), favorites: await kvGet("favorites", []),
  recent: await kvGet("recent", []), playlists: await kvGet("playlists", []), notes: await kvGet("notes", {}),
  repeat: await kvGet("repeat", "off"), volume: await kvGet("volume", 1), keepVoice: await kvGet("keepVoice", true),
};
const save = k => kvSet(k, lib[k]);
let songs = {};
for (const s of await songsAll()) songs[s.id] = { id: s.id, name: s.name, size: s.size, type: s.type, added: s.added };

// ---------------------------------------------------------------- state
const st = {
  id: null, name: "", buffer: null, duration: 0, sr: 48000, peaks: null, info: null, music: null, sections: [], loud: null,
  pos: 0, playing: false, a: null, b: null, loopOn: false, bpmScale: 1, semis: 0, speed: 1, changed: false,
  view: { a: 0, b: 1 }, rendering: null,
};

// ---------------------------------------------------------------- audio
let ctx = null, node = null;
async function audio() {
  if (ctx) { if (ctx.state === "suspended") await ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
  await ctx.audioWorklet.addModule("player-worklet.js");
  node = new AudioWorkletNode(ctx, "avb-player", { outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = e => {
    if (e.data.frame !== undefined) { st.pos = e.data.frame / st.sr; }
    if (e.data.ended) onEnded();
  };
  node.port.postMessage({ cmd: "volume", volume: lib.volume });
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
    navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack(false));
    navigator.mediaSession.setActionHandler("seekto", d => seek(d.seekTime));
  }
}
const send = m => node && node.port.postMessage(m);
const channelsOf = buf => { const out = []; for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c).slice()); return out; };

let worker = null, stretch = null;
function analyse() {
  if (worker) worker.terminate();
  worker = new Worker("analysis-worker.js");
  const chans = channelsOf(st.buffer);
  const id = st.id;
  st.music = null; st.sections = []; st.loud = null;
  const t0 = performance.now();
  worker.onmessage = e => {
    if (st.id !== id) return;
    const d = e.data;
    if (d.stage === "peaks") { st.peaks = d.peaks; st.info = { ...st.info, peakDb: d.peakDb, rmsDb: d.rmsDb }; drawWave(); fillStats(); }
    if (d.stage === "loudness") { st.loud = d; fillStats(); drawLoud(); }
    if (d.stage === "tempo") { st.music = { ...(st.music || {}), ...d }; refreshMusic(); }
    if (d.stage === "key") { st.music = { ...(st.music || {}), ...d }; refreshMusic(); }
    if (d.stage === "sections") { st.sections = d.sections; drawWave(); fillSections(); $("#listen").textContent = `analysed in ${((performance.now() - t0) / 1000).toFixed(0)} s`; }
  };
  $("#listen").textContent = "Listening…";
  worker.postMessage({ channels: chans, sampleRate: st.sr, columns: 1600 }, chans.map(c => c.buffer));
}

async function loadSong(id, autoplay = true) {
  const rec = await songGet(id);
  if (!rec) { toast("That song is no longer in the app"); return; }
  await audio();
  st.id = id; st.name = rec.name; st.playing = false; st.pos = 0; st.a = st.b = null; st.loopOn = false; st.bpmScale = 1; st.changed = false;
  st.music = null; st.sections = []; st.peaks = null; st.loud = null; st.view = { a: 0, b: 1 };
  send({ cmd: "unload" }); send({ cmd: "loop", loop: null });
  $("#title").textContent = rec.name.replace(/\.[^.]+$/, "");
  $("#listen").textContent = "Reading…";
  $("#cover").style.background = coverFor(rec.name);
  syncMarkers(); refreshMusic(); fillSections(); drawWave();
  let buf;
  try {
    const ab = await rec.blob.arrayBuffer();
    buf = await ctx.decodeAudioData(ab);
  } catch (err) {
    toast("Cannot play this file: " + (err && err.message || "unknown format")); $("#listen").textContent = ""; return;
  }
  if (st.id !== id) return;
  st.buffer = buf; st.sr = buf.sampleRate; st.duration = buf.duration;
  const hdr = await sniffHeader(rec.blob, rec.name);
  st.info = { fmt: fmtOf(rec.name), rate: hdr.rate || buf.sampleRate, channels: buf.numberOfChannels, size: rec.size, bits: hdr.bits || bitsOf(rec) };
  fillBadges(); fillStats();
  const chans = channelsOf(buf);
  send({ cmd: "load", channels: chans });
  $("#tdur").textContent = fmtTime(buf.duration);
  $("#notes").value = lib.notes[id] || "";
  lib.recent = [id, ...lib.recent.filter(x => x !== id)].slice(0, 60); save("recent");
  analyse();
  if (st.speed !== 1 || st.semis) applyChange();            // the sliders carry over to the next song
  if (autoplay) play();
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: $("#title").textContent, artist: "AVB Music Player" });
  renderList();
}
function coverFor(name) {
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = RUN[h % 6], b = RUN[(h >> 3) % 6];
  return `linear-gradient(135deg, ${a}66, ${b}cc), #1e1b4b`;
}
const fmtOf = n => (n.split(".").pop() || "").toUpperCase();
function bitsOf(rec) {
  // only WAV/AIFF/FLAC headers say their depth; others are compressed
  const f = fmtOf(rec.name);
  if (f === "WAV" || f === "AIFF" || f === "AIF" || f === "FLAC") return rec.bits || 0;
  return 0;
}
async function sniffBits(blob, name) { return (await sniffHeader(blob, name)).bits; }
async function sniffHeader(blob, name) {
  // WAV / FLAC / AIFF headers say their sample rate and depth; compressed formats get the rate only where easy
  const f = fmtOf(name);
  try {
    const head = new DataView(await blob.slice(0, 4096).arrayBuffer());
    if (f === "WAV" && head.getUint32(0, false) === 0x52494646) {
      let p = 12;
      while (p + 8 < head.byteLength) { const id = head.getUint32(p, false), sz = head.getUint32(p + 4, true); if (id === 0x666d7420) return { rate: head.getUint32(p + 12, true), bits: head.getUint16(p + 22, true) }; p += 8 + sz + (sz & 1); }
    }
    if (f === "FLAC" && head.getUint32(0, false) === 0x664c6143) {
      const rate = (head.getUint8(18) << 12) | (head.getUint8(19) << 4) | (head.getUint8(20) >> 4);
      const bits = ((((head.getUint8(20) & 1) << 4) | (head.getUint8(21) >> 4)) & 0x1f) + 1;
      return { rate, bits };
    }
  } catch (_) { }
  return { rate: 0, bits: 0 };
}

// ---------------------------------------------------------------- transport
function play() { if (!st.buffer) return; audio().then(() => { send({ cmd: "play" }); st.playing = true; $("#play").textContent = "❚❚"; if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing"; }); }
function pause() { send({ cmd: "pause" }); st.playing = false; $("#play").textContent = "▶"; if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused"; }
function togglePlay() { if (!st.buffer) { if (lib.queue.length) playIndex(Math.max(0, lib.index)); else $("#files2").click(); return; } st.playing ? pause() : play(); }
function seek(t) { if (!st.buffer) return; t = Math.max(0, Math.min(st.duration, t)); st.pos = t; send({ cmd: "seek", frame: Math.round(t * st.sr) }); drawWave(); }
function onEnded() {
  st.playing = false; $("#play").textContent = "▶";
  if (lib.repeat === "one") { seek(0); play(); } else nextTrack(true);
}
function playIndex(i) { if (i < 0 || i >= lib.queue.length) return; lib.index = i; save("index"); loadSong(lib.queue[i]); }
function nextTrack(auto) {
  if (!lib.queue.length) return;
  let n = lib.index + 1;
  if (n >= lib.queue.length) { if (auto && lib.repeat === "off") return; n = 0; }
  playIndex(n);
}
function prevTrack() { if (!lib.queue.length) return; if (st.buffer && st.pos > 3) { seek(0); return; } playIndex((lib.index - 1 + lib.queue.length) % lib.queue.length); }

// ---------------------------------------------------------------- markers & loop
function syncMarkers() {
  $("#markA").classList.toggle("on", st.a !== null); $("#markB").classList.toggle("on", st.b !== null);
  const active = st.loopOn && st.a !== null && st.b !== null;
  send({ cmd: "loop", loop: active ? [Math.round(st.a * st.sr), Math.round(st.b * st.sr)] : null });
  drawWave(); refreshSave();
}
function markButton(which) {
  if (!st.buffer) return;
  if (which === "A") st.a = st.a === null ? st.pos : null; else st.b = st.b === null ? st.pos : null;
  if (st.a !== null && st.b !== null) { if (st.a > st.b) [st.a, st.b] = [st.b, st.a]; st.loopOn = true; }
  syncMarkers();
}
function loopRange(a, b) { st.a = a; st.b = b; st.loopOn = true; syncMarkers(); if (!(st.pos >= a && st.pos < b)) seek(a); }

// ---------------------------------------------------------------- tempo & key
async function applyChange() {
  const speed = +$("#speed").value / 100, semis = st.semis, keepVoice = $("#keepVoice").checked, finer = $("#finer").checked;
  st.speed = speed;
  if (!st.buffer) return;
  if (speed === 1 && semis === 0) {
    const chans = channelsOf(st.buffer); send({ cmd: "swap", channels: chans, speed: 1 }); st.changed = false; $("#changeStatus").textContent = ""; refreshMusic(); refreshSave(); return;
  }
  if (st.rendering) { st.rendering.terminate(); st.rendering = null; }
  const w = new Worker("stretch-worker.js", { type: "module" });
  st.rendering = w;
  const chans = channelsOf(st.buffer);
  const t0 = performance.now();
  $("#changeStatus").textContent = "Preparing… 0 s";
  const clock = setInterval(() => { if (st.rendering === w) $("#changeStatus").textContent = `Preparing… ${((performance.now() - t0) / 1000).toFixed(0)} s` + (w.progress ? ` · ${Math.round(w.progress * 100)}%` : ""); }, 500);
  w.onmessage = e => {
    if (e.data.progress !== undefined) { w.progress = e.data.progress; return; }
    clearInterval(clock);
    if (st.rendering !== w) return;
    st.rendering = null;
    if (e.data.error) { $("#changeStatus").textContent = "Could not change it: " + e.data.error; return; }
    send({ cmd: "swap", channels: e.data.channels, speed: e.data.speed });
    st.changed = true;
    $("#changeStatus").textContent = `Playing the changed version (${((performance.now() - t0) / 1000).toFixed(0)} s)`;
    refreshMusic(); refreshSave();
  };
  w.postMessage({ channels: chans, sampleRate: st.sr, speed, semitones: semis, keepVoice, finer }, chans.map(c => c.buffer));
}
function shiftKey(key, semis) {
  const [root, mode] = key.split(" ");
  const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const i = NAMES.indexOf(root); if (i < 0) return key;
  return `${NAMES[((i + semis) % 12 + 12) % 12]} ${mode}`;
}
const CAMELOT = { "C major": "8B", "G major": "9B", "D major": "10B", "A major": "11B", "E major": "12B", "B major": "1B", "F# major": "2B", "C# major": "3B", "Ab major": "4B", "Eb major": "5B", "Bb major": "6B", "F major": "7B", "A minor": "8A", "E minor": "9A", "B minor": "10A", "F# minor": "11A", "C# minor": "12A", "Ab minor": "1A", "Eb minor": "2A", "Bb minor": "3A", "F minor": "4A", "C minor": "5A", "G minor": "6A", "D minor": "7A" };
function refreshMusic() {
  const m = st.music || {}; const sp = +$("#speed").value;
  $("#speedval").textContent = sp + "%"; $("#speedQuick").value = String(sp / 100);
  $("#semis").textContent = st.semis ? `${st.semis > 0 ? "+" : ""}${st.semis} st` : "±0 st";
  const bpm = (m.bpm || 0) * st.bpmScale;
  $("#bpm").textContent = bpm ? (bpm * sp / 100).toFixed(1) : "—";
  $("#bpmnote").textContent = bpm ? (sp !== 100 ? `${bpm.toFixed(1)} as recorded, at ${sp}%` : `beat ${m.confidence || ""}`) : "";
  $("#bpmTarget").value = bpm ? (bpm * sp / 100).toFixed(1) : ""; $("#bpmTarget").disabled = !bpm;
  $("#bpmFrom").textContent = bpm ? `of ${bpm.toFixed(1)}` : "";
  if (m.key) {
    const k = st.semis ? shiftKey(m.key, st.semis) : m.key;
    $("#key").textContent = k; $("#keynote").textContent = `${CAMELOT[k] || ""}  ·  certainty ${Math.round((m.keyConfidence || 0) * 100)}%`;
    $("#keyResult").textContent = st.semis ? `${m.key} → ${k}` : m.key;
  } else { $("#key").textContent = "—"; $("#keynote").textContent = ""; $("#keyResult").textContent = ""; }
  fillStats();
}

// ---------------------------------------------------------------- stats
function fillBadges() {
  const i = st.info; if (!i) { $("#badges").innerHTML = ""; return; }
  const depth = i.bits ? `${i.bits}-bit` : `${Math.round(i.size * 8 / st.duration / 1000)} kbps`;
  $("#badges").innerHTML = `<span class="badge fmt">${i.fmt}</span><span class="badge rate">${(i.rate / 1000).toFixed(1).replace(".0", "")} kHz</span><span class="badge depth">${depth}</span><span class="badge ch">${i.channels === 1 ? "Mono" : i.channels === 2 ? "Stereo" : i.channels + " ch"}</span>`;
}
function stat(cap, v) { return `<div class="stat"><div class="cap">${cap}</div><div class="v">${v}</div></div>`; }
function fillStats() {
  const i = st.info || {}, l = st.loud, m = st.music || {};
  const f = (v, d = 1, u = "") => v === undefined || v === null || v <= -100 ? "—" : v.toFixed(d) + u;
  $("#stats").innerHTML = stat("DURATION", st.buffer ? fmtTime(st.duration) : "—") + stat("INTEGRATED", l ? f(l.integrated, 1, " LUFS") : "—") + stat("PEAK", f(i.peakDb, 1, " dB"))
    + stat("RMS", f(i.rmsDb, 1, " dB")) + stat("DYNAMIC RANGE", i.peakDb !== undefined ? f(i.peakDb - i.rmsDb, 1, " dB") : "—") + stat("RANGE", l && l.lra !== null ? f(l.lra, 1, " LU") : "—")
    + stat("BARS", m.downbeats ? m.downbeats.length : "—") + stat("BEATS", m.beats ? m.beats.length : "—") + stat("SECTIONS", st.sections.length || "—");
  $("#loudstats").innerHTML = l ? stat("INTEGRATED", f(l.integrated, 1, " LUFS")) + stat("SHORT-TERM MAX", f(l.shortTermMax, 1, " LUFS")) + stat("LOUDNESS RANGE", l.lra !== null ? f(l.lra, 1, " LU") : "—") : "";
}
function fillSections() {
  const el = $("#sections");
  if (!st.sections.length) { el.innerHTML = ""; return; }
  el.innerHTML = st.sections.map((s, i) => `<div class="sec" data-i="${i}"><span class="dot" style="background:${SECTION_COLOURS[s.name.split(" ")[0]] || SECTION_COLOURS.Part}"></span><b>${s.name}</b><span class="muted">${fmtTime(s.start)} – ${fmtTime(s.end)}</span><span class="bar" style="width:${Math.round(s.energy * 100)}%"></span><span class="muted">${Math.round(s.energy * 100)}%</span></div>`).join("");
  el.querySelectorAll(".sec").forEach(d => { d.onclick = () => seek(st.sections[+d.dataset.i].start); d.ondblclick = () => { const s = st.sections[+d.dataset.i]; loopRange(s.start, s.end); }; });
}

// ---------------------------------------------------------------- waveform
const wave = $("#wave"); const wctx = wave.getContext("2d");
const SECT_H = 22, RULER_H = 18;
function sizeCanvas(c) { const dpr = window.devicePixelRatio || 1; const r = c.getBoundingClientRect(); if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); } return dpr; }
const xOf = (t, w) => (t / st.duration - st.view.a) / (st.view.b - st.view.a) * w;
const tOf = (x, w) => (st.view.a + x / w * (st.view.b - st.view.a)) * st.duration;
function drawWave() {
  const dpr = sizeCanvas(wave); const w = wave.width / dpr, h = wave.height / dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.fillStyle = "#0E0D26"; wctx.fillRect(0, 0, w, h);
  if (!st.buffer) {
    wctx.fillStyle = "#9592BF"; wctx.font = "600 14px system-ui"; wctx.textAlign = "center";
    wctx.fillText(lib.queue.length ? "Tap to play" : "Tap here or “+ Open files” to pick songs", w / 2, h / 2);
    return;
  }
  const top = SECT_H + 4, bottom = h - RULER_H, mid = (top + bottom) / 2, amp = (bottom - top) / 2 - 2;
  // sections
  for (const s of st.sections) {
    const x0 = Math.max(0, xOf(s.start, w)), x1 = Math.min(w, xOf(s.end, w));
    if (x1 <= 0 || x0 >= w) continue;
    wctx.fillStyle = SECTION_COLOURS[s.name.split(" ")[0]] || SECTION_COLOURS.Part;
    roundRect(wctx, x0 + 1, 2, Math.max(2, x1 - x0 - 2), SECT_H - 4, 5); wctx.fill();
    if (x1 - x0 > 34) { wctx.fillStyle = "#fff"; wctx.font = "700 11px system-ui"; wctx.textAlign = "center"; wctx.fillText(s.name, (x0 + x1) / 2, 15); }
  }
  // loop band
  if (st.loopOn && st.a !== null && st.b !== null) { wctx.fillStyle = "rgba(236,72,153,.15)"; wctx.fillRect(xOf(st.a, w), top, xOf(st.b, w) - xOf(st.a, w), bottom - top); }
  // waveform in the colour run, played part brighter
  if (st.peaks) {
    const cols = st.peaks.length / 2;
    const g = wctx.createLinearGradient(0, 0, w, 0); RUN.forEach((c, i) => g.addColorStop(i / 5, c));
    const px = xOf(st.pos, w);
    for (const [alpha, from, to] of [[0.45, px, w], [1, 0, px]]) {
      wctx.globalAlpha = alpha; wctx.fillStyle = g; wctx.beginPath();
      for (let x = Math.max(0, from); x < Math.min(w, to); x++) {
        const t0 = tOf(x, w) / st.duration, t1 = tOf(x + 1, w) / st.duration;
        const c0 = Math.max(0, Math.floor(t0 * cols)), c1 = Math.min(cols, Math.max(c0 + 1, Math.ceil(t1 * cols)));
        let mn = 0, mx = 0;
        for (let c = c0; c < c1; c++) { if (st.peaks[c * 2] < mn) mn = st.peaks[c * 2]; if (st.peaks[c * 2 + 1] > mx) mx = st.peaks[c * 2 + 1]; }
        wctx.rect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
      }
      wctx.fill();
    }
    wctx.globalAlpha = 1;
  }
  // beats (only when zoomed in)
  if (st.music && st.music.beats && st.view.b - st.view.a < 0.3) {
    wctx.strokeStyle = "rgba(255,255,255,.12)";
    for (const b of st.music.beats) { const x = xOf(b, w); if (x >= 0 && x <= w) { wctx.beginPath(); wctx.moveTo(x, top); wctx.lineTo(x, bottom); wctx.stroke(); } }
  }
  // markers
  for (const [t, col, letter] of [[st.a, "#22D3EE", "A"], [st.b, "#F97316", "B"]]) {
    if (t === null) continue;
    const x = xOf(t, w); if (x < -10 || x > w + 10) continue;
    wctx.strokeStyle = col; wctx.setLineDash([4, 4]); wctx.beginPath(); wctx.moveTo(x, top); wctx.lineTo(x, bottom); wctx.stroke(); wctx.setLineDash([]);
    wctx.fillStyle = col; roundRect(wctx, x - 10, top - 2, 20, 16, 5); wctx.fill();
    wctx.fillStyle = "#fff"; wctx.font = "700 11px system-ui"; wctx.textAlign = "center"; wctx.fillText(letter, x, top + 10);
  }
  // ruler
  wctx.fillStyle = "#6C6996"; wctx.font = "11px system-ui"; wctx.textAlign = "center";
  const span = (st.view.b - st.view.a) * st.duration;
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => span / s <= 7) || 600;
  for (let t = Math.ceil(st.view.a * st.duration / step) * step; t <= st.view.b * st.duration; t += step) wctx.fillText(fmtTime(t), xOf(t, w), h - 4);
  // playhead
  const px = xOf(st.pos, w);
  wctx.shadowColor = "#fff"; wctx.shadowBlur = 8; wctx.fillStyle = "#fff"; wctx.fillRect(px - 1, top, 2, bottom - top); wctx.shadowBlur = 0;
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
// touch: tap = seek / section jump, drag a flag = move it, pinch = zoom
let drag = null, pinch = null, lastTap = 0;
wave.addEventListener("pointerdown", e => {
  if (!st.buffer) { if (lib.queue.length) playIndex(Math.max(0, lib.index)); else $("#files2").click(); return; }
  wave.setPointerCapture(e.pointerId);
  const r = wave.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, w = r.width;
  const now = Date.now();
  if (y < SECT_H) {
    const t = tOf(x, w), s = st.sections.find(s => t >= s.start && t < s.end);
    if (s) { if (now - lastTap < 350) loopRange(s.start, s.end); else seek(s.start); }
    lastTap = now; return;
  }
  for (const [which, t] of [["A", st.a], ["B", st.b]]) if (t !== null && Math.abs(xOf(t, w) - x) < 14 && y < SECT_H + 24) { drag = which; return; }
  drag = "scrub"; seek(tOf(x, w));
});
wave.addEventListener("pointermove", e => {
  if (!drag || !st.buffer) return;
  const r = wave.getBoundingClientRect(), t = Math.max(0, Math.min(st.duration, tOf(e.clientX - r.left, r.width)));
  if (drag === "scrub") seek(t); else { if (drag === "A") st.a = t; else st.b = t; drawWave(); }
});
wave.addEventListener("pointerup", () => { if (drag === "A" || drag === "B") { if (st.a !== null && st.b !== null && st.a > st.b) [st.a, st.b] = [st.b, st.a]; syncMarkers(); } drag = null; });
wave.addEventListener("wheel", e => { e.preventDefault(); zoom(e.deltaY < 0 ? 0.8 : 1.25); }, { passive: false });
function zoom(f) {
  if (!st.buffer) return;
  const width = st.view.b - st.view.a, nw = Math.max(0.01, Math.min(1, width * f));
  const c = st.pos / st.duration; const a = Math.max(0, Math.min(1 - nw, c - nw / 2));
  st.view = { a, b: a + nw }; drawWave();
}
wave.addEventListener("dblclick", () => { st.view = { a: 0, b: 1 }; drawWave(); });

// loudness graph
const loudC = $("#loud");
function drawLoud() {
  const dpr = sizeCanvas(loudC); const w = loudC.width / dpr, h = loudC.height / dpr; const c = loudC.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = "#0E0D26"; c.fillRect(0, 0, w, h);
  const l = st.loud; if (!l) return;
  const left = 30, bottom = h - 16, top = 6, span = 30, topDb = Math.min(0, Math.ceil((l.shortTermMax + 2) / 6) * 6);
  const y = v => top + (topDb - v) / span * (bottom - top);
  c.fillStyle = "#6C6996"; c.font = "10px system-ui"; c.textAlign = "right";
  for (let k = 0; k <= 5; k++) { const v = topDb - span * k / 5; c.fillStyle = "#232250"; c.fillRect(left, y(v), w - left, 1); c.fillStyle = "#6C6996"; c.fillText(v.toFixed(0), left - 4, y(v) + 4); }
  c.strokeStyle = "#D946EF"; c.lineWidth = 1.5; c.beginPath();
  const n = l.shortTerm.length;
  for (let i = 0; i < n; i++) { const x = left + (i * l.hopSeconds + 3) / st.duration * (w - left); const v = Math.max(topDb - span, l.shortTerm[i]); i ? c.lineTo(x, y(v)) : c.moveTo(x, y(v)); }
  c.stroke();
  if (l.integrated > -70) { c.strokeStyle = "rgba(34,211,238,.8)"; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(left, y(l.integrated)); c.lineTo(w, y(l.integrated)); c.stroke(); c.setLineDash([]); }
  if (-14 > topDb - span && -14 < topDb) { c.strokeStyle = "rgba(34,197,94,.6)"; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(left, y(-14)); c.lineTo(w, y(-14)); c.stroke(); c.setLineDash([]); c.fillStyle = "#22C55E"; c.textAlign = "left"; c.fillText("−14 streaming", left + 4, y(-14) - 3); }
  const px = left + st.pos / st.duration * (w - left); c.fillStyle = "#fff"; c.fillRect(px, top, 1.5, bottom - top);
}

// ---------------------------------------------------------------- save a copy
function refreshSave() {
  const part = $("#part").value, bits = +$("#fmt").value;
  const ok = !!st.buffer && (part === "whole" || (st.a !== null && st.b !== null));
  let reason = "";
  if (st.buffer && part !== "whole" && (st.a === null || st.b === null)) reason = "Set A and B first.";
  if (st.buffer && st.info.bits && bits > st.info.bits && !(bits === 32 && st.info.bits === 32)) reason = `Higher than this file's ${st.info.bits}-bit: it would only make the file bigger.`;
  if (st.buffer && !st.info.bits && bits > 16) reason = `${st.info.fmt} is compressed, so copies stop at 16-bit.`;
  if (st.buffer && part === "whole" && !st.changed && st.speed === 1 && !st.semis && st.info.fmt === "WAV" && st.info.bits === bits) reason = "This would be an identical copy.";
  $("#saveBtn").disabled = !ok || !!reason;
  $("#saveName").textContent = st.buffer ? (reason || "Saves as  " + saveName(part, bits)) : "";
}
function saveName(part, bits) {
  const stem = st.name.replace(/\.[^.]+$/, ""); const tags = [];
  const clock = (t, up) => { const s = up ? Math.ceil(t - 1e-6) : Math.floor(t + 1e-6); return `${Math.floor(s / 60)}.${String(s % 60).padStart(2, "0")}`; };
  if (part !== "whole" && st.a !== null && st.b !== null) tags.push((part === "remove" ? "without " : "") + `${clock(st.a)}–${clock(st.b, true)}`);
  const bpm = (st.music && st.music.bpm || 0) * st.bpmScale;
  if (st.speed !== 1) tags.push(bpm ? `${(bpm * st.speed).toFixed(1).replace(/\.0$/, "")} BPM` : `${Math.round(st.speed * 100)}% speed`);
  if (st.semis) { tags.push(`${st.semis > 0 ? "+" : ""}${st.semis} st`); if (!$("#keepVoice").checked) tags.push("voice shifted"); }
  if (!st.info.bits || bits !== st.info.bits) tags.push(bits === 32 ? "32-bit float" : `${bits}-bit`);
  return `${stem}${tags.length ? ` (${tags.join(", ")})` : ""}.wav`;
}
async function saveCopy() {
  if (!st.buffer) return;
  const part = $("#part").value, bits = +$("#fmt").value;
  let chans = channelsOf(st.buffer); const sr = st.sr;
  if (part !== "whole") chans = applySpan(chans, sr, part);
  const t0 = performance.now(); const status = $("#saveStatus");
  const clock = setInterval(() => status.textContent = `Saving… ${((performance.now() - t0) / 1000).toFixed(0)} s`, 500);
  try {
    if (st.speed !== 1 || st.semis) chans = await renderOnce(chans, sr);
    let peak = 0; for (const c of chans) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    let note = "";
    if (peak > 1 && bits !== 32) { const g = 0.989 / peak; for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g; note = ` · lowered ${(20 * Math.log10(g)).toFixed(1)} dB so it does not clip`; }
    const blob = wavBlob(chans, sr, bits);
    const name = saveName(part, bits);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    status.textContent = `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB)${note}`; toast("Saved to Downloads: " + name);
  } catch (err) { status.textContent = "Save failed: " + (err && err.message || err); }
  clearInterval(clock);
}
function renderOnce(chans, sr) {
  return new Promise((ok, no) => {
    const w = new Worker("stretch-worker.js", { type: "module" });
    w.onmessage = e => { if (e.data.progress !== undefined) return; w.terminate(); e.data.error ? no(new Error(e.data.error)) : ok(e.data.channels); };
    w.postMessage({ channels: chans, sampleRate: sr, speed: st.speed, semitones: st.semis, keepVoice: $("#keepVoice").checked, finer: $("#finer").checked }, chans.map(c => c.buffer));
  });
}
function applySpan(chans, sr, mode) {
  const a = Math.round(st.a * sr), b = Math.round(st.b * sr), n = chans[0].length;
  if (mode === "keep") {
    const f = Math.min(Math.round(0.01 * sr), Math.floor((b - a) / 4));
    return chans.map(c => { const o = c.slice(a, b); for (let i = 0; i < f; i++) { const g = i / f; if (a > 0) o[i] *= g; if (b < n) o[o.length - 1 - i] *= g; } return o; });
  }
  const j = Math.min(Math.round(0.02 * sr), a, n - b);
  return chans.map(c => {
    const o = new Float32Array(n - (b - a) - j);
    o.set(c.subarray(0, a - j), 0);
    for (let i = 0; i < j; i++) { const t = i / j * Math.PI / 2; o[a - j + i] = c[a - j + i] * Math.cos(t) + c[b + i] * Math.sin(t); }
    o.set(c.subarray(b + j), a);
    return o;
  });
}
function wavBlob(chans, sr, bits) {
  const nch = chans.length, n = chans[0].length, bps = bits / 8, data = n * nch * bps;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
  str(36, "data"); v.setUint32(40, data, true);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    let x = chans[c][i];
    if (bits === 32) { v.setFloat32(p, x, true); p += 4; }
    else if (bits === 24) { x = Math.max(-1, Math.min(1, x)); const s = Math.round(x * 8388607); v.setUint8(p, s & 255); v.setUint8(p + 1, (s >> 8) & 255); v.setUint8(p + 2, (s >> 16) & 255); p += 3; }
    else { x += (Math.random() - Math.random()) / 32768; x = Math.max(-1, Math.min(1 - 1 / 32768, x)); v.setInt16(p, Math.round(x * 32768), true); p += 2; }
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------------------------------------------------------------- library
async function addFiles(files) {
  const ids = [];
  for (const f of files) {
    const id = `${f.name}|${f.size}|${f.lastModified}`;
    if (!songs[id]) {
      const bits = await sniffBits(f, f.name);
      await tx("songs", "readwrite", s => s.put({ id, name: f.name, size: f.size, type: f.type, added: Date.now(), blob: f, bits }));
      songs[id] = { id, name: f.name, size: f.size, type: f.type, added: Date.now(), bits };
    }
    ids.push(id);
  }
  const before = lib.queue.length;
  for (const id of ids) if (!lib.queue.includes(id)) lib.queue.push(id);
  save("queue");
  if (!st.buffer && ids.length) playIndex(lib.queue.indexOf(ids[0]));
  else if (ids.length) toast(`Added ${lib.queue.length - before} to the queue`);
  renderList();
}
let view = "queue", listName = "";
function renderList() {
  const filter = $("#filter").value.toLowerCase();
  let ids = view === "queue" ? lib.queue : view === "favorites" ? lib.favorites : view === "recent" ? lib.recent : (lib.playlists.find(p => p.name === listName) || { items: [] }).items;
  ids = ids.filter(id => songs[id] && songs[id].name.toLowerCase().includes(filter));
  const el = $("#list");
  el.innerHTML = ids.map(id => { const s = songs[id]; return `<li data-id="${id}" class="${id === st.id ? "now" : ""}"><div class="thumb" style="background:${coverFor(s.name)}"></div><div class="n"><div class="name">${lib.favorites.includes(id) ? "♥ " : ""}${s.name.replace(/\.[^.]+$/, "")}</div><div class="sub">${fmtOf(s.name)} · ${(s.size / 1e6).toFixed(1)} MB</div></div><button class="icon more" title="More">⋯</button></li>`; }).join("")
    || `<li class="muted">${view === "queue" ? "Open files to start." : view === "favorites" ? "No favourites yet: tap ♡ on a song." : view === "recent" ? "Nothing played yet." : "Empty playlist. Use ⋯ on a song to add it."}</li>`;
  el.querySelectorAll("li[data-id]").forEach(li => {
    li.querySelector(".n").onclick = () => { if (view === "queue") playIndex(lib.queue.indexOf(li.dataset.id)); else { lib.queue = ids.slice(); save("queue"); playIndex(ids.indexOf(li.dataset.id)); } showPage("play"); };
    li.querySelector(".more").onclick = () => songMenu(li.dataset.id);
  });
  $("#listTabs").innerHTML = lib.playlists.map(p => `<button data-view="list" data-name="${p.name}" class="${view === "list" && listName === p.name ? "on" : ""}">${p.name}</button>`).join("");
  $("#views").querySelectorAll("button").forEach(b => { b.classList.toggle("on", b.dataset.view === view && (view !== "list" || b.dataset.name === listName)); b.onclick = () => { view = b.dataset.view; listName = b.dataset.name || ""; renderList(); }; });
  navigator.storage && navigator.storage.estimate && navigator.storage.estimate().then(e => $("#storage").textContent = `${Object.keys(songs).length} song${Object.keys(songs).length === 1 ? "" : "s"} stored in the app · ${(e.usage / 1e6).toFixed(0)} MB of ${(e.quota / 1e9).toFixed(1)} GB`);
}
function sheet(items) {
  const s = $("#sheet");
  s.innerHTML = items.map((it, i) => `<button class="${it.danger ? "danger" : ""}" data-i="${i}">${it.label}</button>`).join("") + `<button data-i="-1">Cancel</button>`;
  s.classList.add("on");
  s.querySelectorAll("button").forEach(b => b.onclick = () => { s.classList.remove("on"); const i = +b.dataset.i; if (i >= 0) items[i].run(); });
}
function songMenu(id) {
  const fav = lib.favorites.includes(id);
  const items = [
    { label: fav ? "Remove from favourites" : "Add to favourites", run: () => toggleFav(id) },
    ...lib.playlists.map(p => ({ label: `Add to ${p.name}`, run: () => { if (!p.items.includes(id)) p.items.push(id); save("playlists"); renderList(); } })),
    { label: "New playlist with this song…", run: () => newPlaylist([id]) },
  ];
  if (view === "queue") items.push({ label: "Remove from queue", run: () => { const i = lib.queue.indexOf(id); if (i >= 0) { lib.queue.splice(i, 1); if (i < lib.index) lib.index--; else if (i === lib.index) lib.index = -1; } save("queue"); save("index"); renderList(); } });
  if (view === "list") items.push({ label: "Remove from this playlist", run: () => { const p = lib.playlists.find(p => p.name === listName); p.items = p.items.filter(x => x !== id); save("playlists"); renderList(); } });
  items.push({ label: "Delete from the app (the file on your phone stays)", danger: true, run: async () => {
    await tx("songs", "readwrite", s => s.delete(id)); delete songs[id];
    lib.queue = lib.queue.filter(x => x !== id); lib.favorites = lib.favorites.filter(x => x !== id); lib.recent = lib.recent.filter(x => x !== id);
    lib.playlists.forEach(p => p.items = p.items.filter(x => x !== id)); delete lib.notes[id];
    for (const k of ["queue", "favorites", "recent", "playlists", "notes"]) save(k);
    if (st.id === id) { pause(); st.buffer = null; st.id = null; $("#title").textContent = "No song loaded"; $("#badges").innerHTML = ""; drawWave(); }
    renderList();
  } });
  sheet(items);
}
function toggleFav(id) { if (!id) return; const i = lib.favorites.indexOf(id); if (i >= 0) lib.favorites.splice(i, 1); else lib.favorites.unshift(id); save("favorites"); $("#heart").textContent = lib.favorites.includes(st.id) ? "♥" : "♡"; renderList(); }
function newPlaylist(items = []) {
  const name = prompt("Playlist name", `Playlist ${lib.playlists.length + 1}`); if (!name) return;
  lib.playlists.push({ name: name.trim(), items: items.slice() }); save("playlists"); view = "list"; listName = name.trim(); renderList();
}

// ---------------------------------------------------------------- recording
// The microphone (or a USB interface the phone treats as its input) -> raw
// PCM through an AudioWorklet -> a 24-bit WAV in the app, into the queue.
let rec = null;
async function recordStart() {
  if (rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("This browser cannot record"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  } catch (err) { toast("Microphone not allowed: " + (err && err.message || err)); return; }
  await audio();
  if (st.playing) pause();
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "avb-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: src.channelCount || 1 });
  const chunks = [], nch = src.channelCount || 1;
  let frames = 0, peak = 0, clip = 0;
  tap.port.onmessage = e => {
    chunks.push(e.data.channels); frames += e.data.channels[0].length;
    let p = 0; for (const ch of e.data.channels) for (let i = 0; i < ch.length; i += 4) { const v = Math.abs(ch[i]); if (v > p) p = v; if (v >= 0.999) clip++; }
    peak = Math.max(peak, p);
    $("#recLevel").style.width = Math.min(100, Math.max(0, (20 * Math.log10(p + 1e-6) + 48) / 48 * 100)) + "%";
    $("#recPeak").textContent = (20 * Math.log10(peak + 1e-6)).toFixed(1) + " dB" + (clip ? " CLIP" : "");
    $("#recTime").textContent = fmtTime(frames / ctx.sampleRate);
  };
  src.connect(tap);
  rec = { stream, src, tap, chunks, nch, started: Date.now() };
  $("#recbox").classList.add("on"); $("#recInfo").textContent = `${(ctx.sampleRate / 1000).toFixed(1).replace(".0", "")} kHz · ${nch === 1 ? "mono" : "stereo"} · 24-bit WAV`;
  $("#recLevel").style.width = "0"; $("#recPeak").textContent = ""; $("#recTime").textContent = "0:00";
}
async function recordStop(keep) {
  if (!rec) return;
  const { stream, src, tap, chunks, nch, started } = rec; rec = null;
  src.disconnect(); tap.disconnect(); stream.getTracks().forEach(t => t.stop());
  $("#recbox").classList.remove("on");
  if (!keep || !chunks.length) return;
  const n = chunks.reduce((s, c) => s + c[0].length, 0);
  const chans = []; for (let c = 0; c < nch; c++) chans.push(new Float32Array(n));
  let p = 0; for (const ch of chunks) { for (let c = 0; c < nch; c++) chans[c].set(ch[Math.min(c, ch.length - 1)], p); p += ch[0].length; }
  const d = new Date(started), pad = x => String(x).padStart(2, "0");
  const name = `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.wav`;
  const blob = wavBlob(chans, ctx.sampleRate, 24);
  const f = new File([blob], name, { type: "audio/wav", lastModified: started });
  await addFiles([f]);
  toast(`Kept ${name} (${fmtTime(n / ctx.sampleRate)})`);
}

// ---------------------------------------------------------------- ui wiring
function showPage(p) { document.querySelectorAll(".page").forEach(e => e.classList.toggle("on", e.id === "page-" + p)); $("#pages").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.page === p)); if (p === "play") drawWave(); }
$("#pages").querySelectorAll("button").forEach(b => b.onclick = () => showPage(b.dataset.page));
$("#tools").querySelectorAll("button").forEach(b => b.onclick = () => { $("#tools").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab)); if (b.dataset.tab === "loud") drawLoud(); });
$("#files").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
$("#files2").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
$("#play").onclick = togglePlay; $("#prev").onclick = prevTrack; $("#next").onclick = () => nextTrack(false);
$("#back10").onclick = () => seek(st.pos - 10); $("#fwd10").onclick = () => seek(st.pos + 10);
$("#markA").onclick = () => markButton("A"); $("#markB").onclick = () => markButton("B");
$("#repeat").onclick = () => { lib.repeat = { off: "all", all: "one", one: "off" }[lib.repeat]; save("repeat"); $("#repeat").textContent = { off: "↻ off", all: "↻ all", one: "↻ one" }[lib.repeat]; $("#repeat").classList.toggle("on", lib.repeat !== "off"); };
$("#repeat").textContent = { off: "↻ off", all: "↻ all", one: "↻ one" }[lib.repeat]; $("#repeat").classList.toggle("on", lib.repeat !== "off");
$("#seek").oninput = e => seek(+e.target.value / 1000 * st.duration);
$("#heart").onclick = () => toggleFav(st.id);
$("#half").onclick = () => { st.bpmScale = Math.max(0.25, st.bpmScale / 2); refreshMusic(); refreshSave(); };
$("#dbl").onclick = () => { st.bpmScale = Math.min(4, st.bpmScale * 2); refreshMusic(); refreshSave(); };
$("#speed").oninput = () => { refreshMusic(); };
$("#speedQuick").onchange = e => { $("#speed").value = Math.round(+e.target.value * 100); applyChange(); refreshMusic(); refreshSave(); };
$("#bpmTarget").onchange = e => { const bpm = (st.music && st.music.bpm || 0) * st.bpmScale; if (bpm) { $("#speed").value = Math.max(50, Math.min(150, Math.round(+e.target.value / bpm * 100))); refreshMusic(); } };
$("#keyDown").onclick = () => { st.semis = Math.max(-12, st.semis - 1); refreshMusic(); };
$("#keyUp").onclick = () => { st.semis = Math.min(12, st.semis + 1); refreshMusic(); };
$("#applyChange").onclick = () => { applyChange(); refreshSave(); };
$("#resetChange").onclick = () => { st.semis = 0; $("#speed").value = 100; applyChange(); refreshMusic(); refreshSave(); };
$("#keepVoice").checked = lib.keepVoice; $("#keepVoice").onchange = e => { lib.keepVoice = e.target.checked; save("keepVoice"); };
$("#part").onchange = refreshSave; $("#fmt").onchange = refreshSave; $("#saveBtn").onclick = saveCopy;
$("#notes").oninput = () => { if (st.id) { lib.notes[st.id] = $("#notes").value; save("notes"); } };
$("#newList").onclick = () => newPlaylist();
$("#recBtn").onclick = recordStart; $("#recBtn2").onclick = () => { showPage("library"); recordStart(); }; $("#recStop").onclick = () => recordStop(true); $("#recCancel").onclick = () => recordStop(false);
$("#filter").oninput = renderList;
window.addEventListener("resize", () => { drawWave(); drawLoud(); });
document.addEventListener("keydown", e => { if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return; if (e.code === "Space") { e.preventDefault(); togglePlay(); } if (e.key === "ArrowLeft") seek(st.pos - 5); if (e.key === "ArrowRight") seek(st.pos + 5); });

// clock
let lastDraw = 0;
function tick(now) {
  if (st.buffer && st.playing && now - lastDraw > 40) {
    lastDraw = now; $("#tnow").textContent = fmtTime(st.pos); $("#seek").value = Math.round(st.pos / st.duration * 1000); drawWave();
    if ($("#tab-loud").classList.contains("on")) drawLoud();
    const i = st.sections.findIndex(s => st.pos >= s.start && st.pos < s.end);
    document.querySelectorAll(".sec").forEach((d, k) => d.classList.toggle("now", k === i));
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function fmtTime(s) { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`; }
let toastTimer = 0;
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove("on"), 3500); }

renderList(); drawWave(); refreshSave();
if (lib.queue.length && lib.index >= 0 && songs[lib.queue[lib.index]]) { $("#title").textContent = songs[lib.queue[lib.index]].name.replace(/\.[^.]+$/, ""); $("#listen").textContent = "Tap play to continue"; }
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => { });

// ---------------------------------------------------------------- install
// Opened as an installed app: nothing to offer.  In Chrome: Chrome's own
// installer behind our button.  Elsewhere (an app's built-in browser, a
// home-screen shortcut): say how to get the real install.
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
let installEvent = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; $("#installBtn").hidden = false; });
window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; $("#installHint").hidden = true; toast("Installed: open AVB Music Player from its icon"); });
$("#installBtn").onclick = async () => {
  if (installEvent) { installEvent.prompt(); const r = await installEvent.userChoice; if (r.outcome === "accepted") $("#installBtn").hidden = true; installEvent = null; return; }
  showInstallHint();
};
$("#installClose").onclick = () => { $("#installHint").hidden = true; sessionStorage.setItem("hintClosed", "1"); };
function showInstallHint() {
  const ua = navigator.userAgent;
  const inApp = /; wv\)|FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\//.test(ua);
  const chrome = /Chrome\//.test(ua) && !/EdgA|SamsungBrowser|OPR|YaBrowser/.test(ua);
  $("#installText").innerHTML = inApp
    ? "This page is open inside another app. Tap ⋮ and choose <b>Open in Chrome</b>, then tap <b>Install app</b> at the top."
    : chrome
      ? "You are in the browser. Tap ⋮ (top right) → <b>Install app</b> (or <b>Add to Home screen</b> → <b>Install</b>, not “Create shortcut”). If you made a shortcut before, delete it first."
      : "For the full app, open this link in <b>Chrome</b>, then tap ⋮ → <b>Install app</b>.";
  $("#installHint").hidden = false;
}
if (!standalone) {
  $("#installBtn").hidden = false;                       // shown at once; Chrome's own prompt attaches when it is ready
  if (!sessionStorage.getItem("hintClosed")) setTimeout(() => { if (!installEvent && !standalone) showInstallHint(); }, 2500);
}
// a test hook: ?demo=<url> loads a file without a file picker (used only on localhost)
const demo = new URLSearchParams(location.search).get("demo");
if (demo && ["localhost", "127.0.0.1"].includes(location.hostname)) {
  const r = await fetch(demo); const blob = await r.blob();
  const f = new File([blob], decodeURIComponent(demo.split("/").pop()), { type: blob.type, lastModified: 1 });
  await addFiles([f]);
}
window.avb = { st, lib, loadSong, applyChange, saveCopy, seek, play, pause, markButton, loopRange };
