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
  recent: await kvGet("recent", []), playlists: await kvGet("playlists", []), notes: await kvGet("notes", {}), lyrics: await kvGet("lyrics", {}), eq: await kvGet("eq", null), hidden: await kvGet("hidden", []),
  repeat: await kvGet("repeat", "off"), volume: await kvGet("volume", 1), keepVoice: await kvGet("keepVoice", true),
};
const save = k => kvSet(k, lib[k]);
let songs = {};
for (const s of await songsAll()) songs[s.id] = { id: s.id, name: s.name, size: s.size, type: s.type, added: s.added, kind: s.kind || "app", duration: s.duration };
const isRecording = id => !!songs[id] && songs[id].kind === "recording";
if (lib.queue.some(isRecording)) { const cur = lib.queue[lib.index]; lib.queue = lib.queue.filter(id => !isRecording(id)); lib.index = lib.queue.indexOf(cur); save("queue"); save("index"); }

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
  buildEqChain();
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
  let rec = null;
  if (songs[id] && songs[id].url) {
    // a song on the phone (All music / Recordings): read it where it is
    try {
      const blob = await (await fetch(songs[id].url)).blob();
      rec = { ...songs[id], blob, size: songs[id].size > 0 ? songs[id].size : blob.size };
    } catch (err) { toast("Cannot read that song from the phone"); return; }
  } else rec = await songGet(id).catch(() => null);
  if (!rec || !rec.blob) { toast("That song is no longer in the app"); return; }
  await audio();
  st.id = id; st.name = rec.name; st.playing = false; st.pos = 0; st.a = st.b = null; st.loopOn = false; st.bpmScale = 1; st.changed = false;
  st.music = null; st.sections = []; st.peaks = null; st.loud = null; st.view = { a: 0, b: 1 }; st.vzoom = 1;
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
  findLyrics(id, rec);
  if (!isRecording(id)) { lib.recent = [id, ...lib.recent.filter(x => x !== id)].slice(0, 60); save("recent"); }
  if ($("#page-recs").classList.contains("on")) renderRecList();
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
const ANDROID = window.AVBAndroid || null;
function play() { if (!st.buffer) return; audio().then(() => { send({ cmd: "play" }); st.playing = true; $("#play").textContent = "❚❚"; if (ANDROID) ANDROID.playing(true); if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing"; }); }
function pause() { send({ cmd: "pause" }); st.playing = false; $("#play").textContent = "▶"; if (ANDROID) ANDROID.playing(false); if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused"; }
function togglePlay() { if (!st.buffer) { if (lib.queue.length) playIndex(Math.max(0, lib.index), true); else $("#files2").click(); return; } st.playing ? pause() : play(); }
function seek(t) { if (!st.buffer) return; t = Math.max(0, Math.min(st.duration, t)); st.pos = t; send({ cmd: "seek", frame: Math.round(t * st.sr) }); drawWave(); }
function onEnded() {
  st.playing = false; $("#play").textContent = "▶"; if (ANDROID) ANDROID.playing(false);
  if (lib.repeat === "one") { seek(0); play(); } else if (!isRecording(st.id)) nextTrack(true);
}
// choosing a song only loads it: playing is the user's ▶ (autoplay only when the music was already going)
function playIndex(i, autoplay = false) { if (i < 0 || i >= lib.queue.length) return; lib.index = i; save("index"); loadSong(lib.queue[i], autoplay); }
function nextTrack(auto) {
  if (isRecording(st.id)) {                              // inside Recordings: step through the takes, no auto-advance
    if (auto) return;
    const i = recordingIds.indexOf(st.id);
    if (i >= 0 && i + 1 < recordingIds.length) loadSong(recordingIds[i + 1], st.playing);
    return;
  }
  if (!lib.queue.length) return;
  let n = lib.index + 1;
  if (n >= lib.queue.length) { if (auto && lib.repeat === "off") return; n = 0; }
  playIndex(n, auto || st.playing);                     // the next song keeps playing only if music was playing
}
function prevTrack() {
  if (isRecording(st.id)) { if (st.pos > 3) { seek(0); return; } const i = recordingIds.indexOf(st.id); if (i > 0) loadSong(recordingIds[i - 1], st.playing); return; }
  if (!lib.queue.length) return; if (st.buffer && st.pos > 3) { seek(0); return; } playIndex((lib.index - 1 + lib.queue.length) % lib.queue.length, st.playing); }

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
  if (!st.buffer) { $("#changeStatus").textContent = speed === 1 && !semis ? "" : "Applies to the next song you load"; return; }
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
  if (!showSections()) { el.innerHTML = ""; return; }
  el.innerHTML = st.sections.map((s, i) => `<div class="sec" data-i="${i}"><span class="dot" style="background:${SECTION_COLOURS[s.name.split(" ")[0]] || SECTION_COLOURS.Part}"></span><b>${s.name}</b><span class="muted">${fmtTime(s.start)} – ${fmtTime(s.end)}</span><span class="bar" style="width:${Math.round(s.energy * 100)}%"></span><span class="muted">${Math.round(s.energy * 100)}%</span></div>`).join("");
  el.querySelectorAll(".sec").forEach(d => { d.onclick = () => seek(st.sections[+d.dataset.i].start); d.ondblclick = () => { const s = st.sections[+d.dataset.i]; loopRange(s.start, s.end); }; });
}

// ---------------------------------------------------------------- waveform
const wave = $("#wave"); const wctx = wave.getContext("2d");
const SECT_H = 22, RULER_H = 18;
function sizeCanvas(c) { const dpr = window.devicePixelRatio || 1; const r = c.getBoundingClientRect(); if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); } return dpr; }
const xOf = (t, w) => (t / st.duration - st.view.a) / (st.view.b - st.view.a) * w;
const tOf = (x, w) => (st.view.a + x / w * (st.view.b - st.view.a)) * st.duration;
// "Part A / Part B" means the analysis could not tell verse from chorus: show nothing then
const showSections = () => st.sections.length >= 3 && !isRecording(st.id) && !st.sections.every(x => /^Part /.test(x.name));
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
  for (const s of (showSections() ? st.sections : [])) {
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
        const vz = st.vzoom || 1, hi = Math.min(1, mx * vz), lo = Math.max(-1, mn * vz);
        wctx.rect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
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
  // how far in it is zoomed, while it is
  if ((st.vzoom || 1) > 1.05 || st.view.b - st.view.a < 0.98) {
    wctx.fillStyle = "rgba(11,10,31,.75)"; roundRect(wctx, w - 112, top + 2, 106, 18, 6); wctx.fill();
    wctx.fillStyle = "#CFCDEE"; wctx.font = "600 11px system-ui"; wctx.textAlign = "right";
    wctx.fillText(`↔ ${(1 / (st.view.b - st.view.a)).toFixed(1)}×  ↕ ${(st.vzoom || 1).toFixed(1)}×`, w - 10, top + 15);
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
let drag = null, pinch = null, lastTap = 0, lastWaveTap = 0;
const fingers = new Map();
function startPinch() {
  const [p1, p2] = [...fingers.values()];
  const r = wave.getBoundingClientRect();
  pinch = { dx: Math.max(24, Math.abs(p1.x - p2.x)), dy: Math.max(24, Math.abs(p1.y - p2.y)), view: { ...st.view }, vz: st.vzoom || 1,
            cx: ((p1.x + p2.x) / 2 - r.left) / r.width, horiz: Math.abs(p1.x - p2.x) >= Math.abs(p1.y - p2.y) };
  drag = null; clearTimeout(scrubTimer); lastWaveTap = 0;
}
let scrubTimer = 0;
function movePinch() {
  const [p1, p2] = [...fingers.values()];
  const dx = Math.max(24, Math.abs(p1.x - p2.x)), dy = Math.max(24, Math.abs(p1.y - p2.y));
  if (pinch.horiz) {
    // time: the point between the fingers stays put while the span shrinks or grows
    const w0 = pinch.view.b - pinch.view.a, nw = Math.max(0.005, Math.min(1, w0 * pinch.dx / dx));
    const anchor = pinch.view.a + pinch.cx * w0;
    const a = Math.max(0, Math.min(1 - nw, anchor - pinch.cx * nw));
    st.view = { a, b: a + nw };
  } else {
    st.vzoom = Math.max(1, Math.min(16, pinch.vz * dy / pinch.dy));
  }
  drawWave();
}
wave.addEventListener("pointerdown", e => {
  if (!st.buffer) { if (lib.queue.length) playIndex(Math.max(0, lib.index)); else $("#files2").click(); return; }
  try { wave.setPointerCapture(e.pointerId); } catch (_) { }
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (fingers.size === 2) { startPinch(); return; }
  if (fingers.size > 2) return;
  const r = wave.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, w = r.width;
  const now = Date.now();
  if (now - lastWaveTap < 300 && y >= SECT_H) { clearTimeout(scrubTimer); st.view = { a: 0, b: 1 }; st.vzoom = 1; drawWave(); lastWaveTap = 0; return; }   // double-tap: back to the whole song
  lastWaveTap = now;
  if (y < SECT_H && showSections()) {
    const t = tOf(x, w), s = st.sections.find(s => t >= s.start && t < s.end);
    if (s) { if (now - lastTap < 350) loopRange(s.start, s.end); else seek(s.start); }
    lastTap = now; return;
  }
  for (const [which, t] of [["A", st.a], ["B", st.b]]) if (t !== null && Math.abs(xOf(t, w) - x) < 14 && y < SECT_H + 24) { drag = which; return; }
  // one finger seeks - after a moment, so the first finger of a pinch does not jump the song
  drag = "wait";
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => { if (drag === "wait" && fingers.size === 1) { drag = "scrub"; seek(tOf(x, w)); } }, 90);
});
wave.addEventListener("pointermove", e => {
  if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && fingers.size >= 2) { movePinch(); return; }
  if (!drag || !st.buffer || drag === "wait") return;
  const r = wave.getBoundingClientRect(), t = Math.max(0, Math.min(st.duration, tOf(e.clientX - r.left, r.width)));
  if (drag === "scrub") seek(t); else { if (drag === "A") st.a = t; else st.b = t; drawWave(); }
});
const fingerUp = e => {
  fingers.delete(e.pointerId);
  if (pinch) { if (fingers.size < 2) pinch = null; drag = null; return; }
  if (drag === "wait") {                                  // a quick tap: seek right away
    clearTimeout(scrubTimer);
    const r = wave.getBoundingClientRect(); seek(tOf(e.clientX - r.left, r.width));
  }
  if (drag === "A" || drag === "B") { if (st.a !== null && st.b !== null && st.a > st.b) [st.a, st.b] = [st.b, st.a]; syncMarkers(); }
  drag = null;
};
wave.addEventListener("pointerup", fingerUp);
wave.addEventListener("pointercancel", fingerUp);
wave.addEventListener("wheel", e => { e.preventDefault(); zoom(e.deltaY < 0 ? 0.8 : 1.25); }, { passive: false });
function zoom(f) {
  if (!st.buffer) return;
  const width = st.view.b - st.view.a, nw = Math.max(0.01, Math.min(1, width * f));
  const c = st.pos / st.duration; const a = Math.max(0, Math.min(1 - nw, c - nw / 2));
  st.view = { a, b: a + nw }; drawWave();
}
wave.addEventListener("dblclick", () => { st.view = { a: 0, b: 1 }; st.vzoom = 1; drawWave(); });

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
// the copy's format: "wav-16", "flac-24", "mp3-320" ...
const fmtChoice = () => { const [kind, n] = $("#fmt").value.split("-"); return { kind, n: +n }; };
function sourceKbps() { return st.info && st.duration ? st.info.size * 8 / st.duration / 1000 : 0; }
function saveReason(part, f) {
  if (!st.buffer) return "";
  if (part !== "whole" && (st.a === null || st.b === null)) return "Mark the piece first: tap A where it starts and B where it ends.";
  const changed = part !== "whole" || st.speed !== 1 || !!st.semis || eqActive();
  const lossless = !!st.info.bits;
  if (f.kind === "wav" || f.kind === "flac") {
    if (!lossless && f.n > 16) return `${st.info.fmt} is compressed, so lossless copies stop at 16-bit.`;
    if (lossless && f.n > st.info.bits && !(f.n === 32 && st.info.bits === 32)) return `Higher than this file's ${st.info.bits}-bit: it would only make the file bigger.`;
    if (!changed && st.info.fmt === f.kind.toUpperCase() && st.info.bits === f.n) return "This would be an identical copy.";
    return "";
  }
  if (!lossless) {
    const kb = sourceKbps();
    if (kb && f.n > kb + 8) return `Higher than this file's ${Math.round(kb)} kbps: it would only make the file bigger.`;
    if (!changed && st.info.fmt === "MP3" && kb && Math.abs(f.n - kb) <= 8) return "Re-encoding this MP3 at its own bitrate would only lose quality.";
  }
  return "";
}
function refreshSave() {
  const part = $("#part").value, f = fmtChoice();
  $("#partHint").hidden = part === "whole";
  // grey out the formats the rules do not allow for this song
  for (const o of $("#fmt").querySelectorAll("option")) { const [k, n] = o.value.split("-"); o.disabled = !!st.buffer && !!saveReason("whole", { kind: k, n: +n }) && !saveReason(part, { kind: k, n: +n }).startsWith("Mark"); }
  const reason = saveReason(part, f);
  $("#saveBtn").disabled = !st.buffer || !!reason || !!saving;
  $("#saveName").textContent = st.buffer ? (reason || "Saves as  " + saveName(part, f)) : "";
}
function saveName(part, f) {
  const stem = st.name.replace(/\.[^.]+$/, ""); const tags = [];
  const clock = (t, up) => { const s = up ? Math.ceil(t - 1e-6) : Math.floor(t + 1e-6); return `${Math.floor(s / 60)}.${String(s % 60).padStart(2, "0")}`; };
  if (part !== "whole" && st.a !== null && st.b !== null) tags.push((part === "remove" ? "without " : "") + `${clock(st.a)}–${clock(st.b, true)}`);
  const bpm = (st.music && st.music.bpm || 0) * st.bpmScale;
  if (st.speed !== 1) tags.push(bpm ? `${(bpm * st.speed).toFixed(1).replace(/\.0$/, "")} BPM` : `${Math.round(st.speed * 100)}% speed`);
  if (st.semis) { tags.push(`${st.semis > 0 ? "+" : ""}${st.semis} st`); if (!$("#keepVoice").checked) tags.push("voice shifted"); }
  if (eqActive()) tags.push("EQ");
  if (f.kind === "mp3") tags.push(`${f.n} kbps`);
  else if (!st.info.bits || f.n !== st.info.bits) tags.push(f.n === 32 ? "32-bit float" : `${f.n}-bit`);
  return `${stem}${tags.length ? ` (${tags.join(", ")})` : ""}.${f.kind}`;
}
let saving = null;
// a copy of the loaded song: the piece asked for, tempo/key, EQ, back to its own rate, then the format
async function makeCopy(part, f, onStage) {
  let chans = channelsOf(st.buffer); let sr = st.sr;
  if (part !== "whole") chans = applySpan(chans, sr, part);
  if (st.speed !== 1 || st.semis) { onStage("Changing tempo / key"); chans = await renderOnce(chans, sr); }
  if (eqActive()) { onStage("Applying the EQ"); chans = await renderEq(chans, sr); }
  if (st.info.rate && st.info.rate !== sr) { onStage("Back to " + (st.info.rate / 1000).toFixed(1).replace(".0", "") + " kHz"); chans = await resample(chans, sr, st.info.rate); sr = st.info.rate; }
  let peak = 0; for (const c of chans) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  let note = "";
  if (peak > 1 && !(f.kind === "wav" && f.n === 32)) { const g = 0.989 / peak; for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g; note = ` · lowered ${(20 * Math.log10(g)).toFixed(1)} dB so it does not clip`; }
  onStage(f.kind === "mp3" ? "Encoding MP3" : f.kind === "flac" ? "Encoding FLAC" : "Writing WAV");
  const { bytes, mime } = await encode(chans, sr, f);
  return { blob: new Blob([bytes], { type: mime }), name: saveName(part, f), note };
}
async function saveCopy() {
  if (!st.buffer || saving) return;
  const part = $("#part").value, f = fmtChoice();
  if (saveReason(part, f)) return;
  const t0 = performance.now(); const status = $("#saveStatus");
  let stage = "Preparing";
  saving = true; refreshSave();
  const clock = setInterval(() => status.textContent = `${stage}… ${((performance.now() - t0) / 1000).toFixed(0)} s`, 500);
  try {
    const { blob, name, note } = await makeCopy(part, f, x => stage = x);
    stage = "Saving";
    if (ANDROID) await androidSave(blob, name);
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    status.textContent = `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(0)} s)${note}`; toast("Saved to Downloads: " + name);
  } catch (err) { status.textContent = "Save failed: " + (err && err.message || err); }
  clearInterval(clock); saving = null; refreshSave();
}

// ---------------------------------------------------------------- share
// The ⤴ button: the original file, or a copy in any format (with the tempo /
// key / EQ as they sound now), handed to Android's share sheet.
async function shareSong(id) {
  id = id || st.id;
  if (!id || !songs[id]) { toast("Load a song first"); return; }
  if (st.id !== id) { await loadSong(id, false); if (st.id !== id || !st.buffer) return; }
  if (!st.buffer) { toast("The song is still loading"); return; }
  const s0 = songs[id];
  const changes = [st.speed !== 1 || st.semis ? "tempo/key" : "", eqActive() ? "EQ" : ""].filter(Boolean).join(" + ");
  const tail = changes ? ` · with your ${changes}` : "";
  const srcFmt = st.info.fmt, bits = st.info.bits;
  const options = [];
  options.push({ label: `Original file · ${srcFmt}${s0.size > 0 ? ` · ${(s0.size / 1e6).toFixed(1)} MB` : ""}${changes ? " (without your changes)" : ""}`, run: () => shareOriginal(id) });
  const fmts = [
    [{ kind: "mp3", n: 320 }, "MP3 · best quality"],
    [{ kind: "mp3", n: 192 }, "MP3 · smaller, good for messages"],
    [{ kind: "flac", n: bits && bits <= 24 ? (bits > 16 ? 24 : 16) : 16 }, "FLAC · lossless"],
    [{ kind: "wav", n: bits && bits <= 24 ? (bits > 16 ? 24 : 16) : 16 }, "WAV"],
  ];
  for (const [f, label] of fmts) {
    const why = saveReason("whole", f);
    if (why && !why.startsWith("This would be an identical")) continue;     // above the song's own quality
    if (why) continue;                                                          // identical: that is the Original
    options.push({ label: label + tail, run: () => shareCopy(f) });
  }
  sheet(options, `Share “${s0.name.replace(/\.[^.]+$/, "")}”`);
}
async function shareOriginal(id) {
  const s0 = songs[id];
  if (ANDROID && s0.url && /^[mr]:/.test(id)) { ANDROID.shareMedia(id.slice(2), s0.name); return; }
  const rec = await songGet(id).catch(() => null);
  const blob = rec && rec.blob ? rec.blob : (s0.url ? await (await fetch(s0.url)).blob() : null);
  if (!blob) { toast("Cannot read that song"); return; }
  await deliverShare(blob, s0.name);
}
async function shareCopy(f) {
  const t0 = performance.now(); let stage = "Preparing";
  const clock = setInterval(() => toast(`${stage}… ${((performance.now() - t0) / 1000).toFixed(0)} s`), 600);
  try {
    const { blob, name } = await makeCopy("whole", f, x => stage = x);
    clearInterval(clock);
    await deliverShare(blob, name);
  } catch (err) { clearInterval(clock); toast("Could not make the copy: " + (err && err.message || err)); }
}
async function deliverShare(blob, name) {
  if (ANDROID && ANDROID.shareBegin) {
    const id = ANDROID.shareBegin(name, blob.type || "audio/*");
    if (id < 0) { toast("Could not prepare the file"); return; }
    const step = 768 * 1024;
    for (let p = 0; p < blob.size; p += step) {
      const bytes = new Uint8Array(await blob.slice(p, p + step).arrayBuffer());
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      if (!ANDROID.saveChunk(id, btoa(bin))) { toast("Could not prepare the file"); return; }
    }
    ANDROID.shareEnd(id);
    return;
  }
  const file = new File([blob], name, { type: blob.type || "audio/*" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch (err) { if (err && err.name !== "AbortError") toast("Sharing failed: " + err.message); }
    return;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast("This browser cannot share files: saved to Downloads instead");
}
function encode(chans, sr, f) {
  return new Promise((ok, no) => {
    const w = new Worker("encode-worker.js");
    w.onmessage = e => { if (e.data.progress !== undefined) return; w.terminate(); e.data.error ? no(new Error(e.data.error)) : ok(e.data); };
    w.onerror = e => { w.terminate(); no(new Error(e.message || "the encoder failed")); };
    w.postMessage({ channels: chans, sampleRate: sr, format: f.kind, bits: f.n, kbps: f.n }, chans.map(c => c.buffer));
  });
}
async function resample(chans, from, to) {
  const n = Math.round(chans[0].length * to / from);
  const off = new OfflineAudioContext(chans.length, n, to);
  const buf = off.createBuffer(chans.length, chans[0].length, from);
  chans.forEach((c, i) => buf.copyToChannel(c, i));
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return channelsOf(out);
}
async function androidSave(blob, name, where = "downloads") {
  const id = ANDROID.saveBegin(name, blob.type || "audio/wav", where);
  if (id < 0) throw new Error("could not create the file in Downloads");
  const step = 768 * 1024;
  for (let p = 0; p < blob.size; p += step) {
    const bytes = new Uint8Array(await blob.slice(p, p + step).arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    if (!ANDROID.saveChunk(id, btoa(bin))) throw new Error("writing to Downloads failed");
  }
  if (!ANDROID.saveEnd(id)) throw new Error("finishing the file in Downloads failed");
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
async function addFiles(files, playNow = false) {
  const ids = [];
  for (const f of files) {
    const id = `${f.name}|${f.size}|${f.lastModified}`;
    try {
      if (!songs[id]) {
        // a copy of the bytes, not the picker's handle: a handle can stop being readable later
        const blob = new Blob([await f.arrayBuffer()], { type: f.type || "" });
        const bits = await sniffBits(blob, f.name);
        await tx("songs", "readwrite", s => s.put({ id, name: f.name, size: f.size, type: f.type, added: Date.now(), blob, bits }));
        songs[id] = { id, name: f.name, size: f.size, type: f.type, added: Date.now(), bits };
      }
      ids.push(id);
    } catch (err) {
      toast(`Could not open ${f.name}: ${err && err.message || err}`);
    }
  }
  const before = lib.queue.length;
  for (const id of ids) if (!lib.queue.includes(id)) lib.queue.push(id);
  save("queue");
  if ((playNow || !st.buffer) && ids.length) { playIndex(lib.queue.indexOf(ids[0])); showPage("music"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else if (ids.length) toast(`Added ${lib.queue.length - before} to the queue`);
  renderList();
}
let view = ANDROID ? "phone" : "queue", listName = "";
let phoneIds = [], recordingIds = [], phoneState = ANDROID ? "loading" : "web";
function subLine(s) {
  const bits = [];
  if (s.artist && !/unknown/i.test(s.artist)) bits.push(s.artist);
  if (s.duration) bits.push(fmtTime(s.duration));
  bits.push(fmtOf(s.name));
  if (s.size > 0) bits.push((s.size / 1e6).toFixed(1) + " MB");
  if (s.folder) bits.push(s.folder.replace(/\/$/, ""));
  return bits.join(" · ");
}
function emptyText() {
  if (view === "phone") return phoneState === "denied" ? "Allow AVB Music Player to see your music: tap All music again, then Allow."
    : phoneState === "loading" ? "Looking for music on your phone…" : "No music found on this phone.";
  if (view === "recordings") return "No recordings yet: tap ● Record on the Play page.";
  if (view === "queue") return ANDROID ? "Pick songs in All music, or + Open files." : "Open files to start.";
  if (view === "favorites") return "No favourites yet: tap ♡ on a song.";
  if (view === "recent") return "Nothing played yet.";
  return "Empty playlist. Use ⋯ on a song to add it.";
}
function renderList() {
  const filter = $("#filter").value.toLowerCase();
  let ids = view === "phone" ? phoneIds.filter(x => !lib.hidden.includes(x)) : view === "recordings" ? recordingIds : view === "queue" ? lib.queue : view === "favorites" ? lib.favorites
    : view === "recent" ? lib.recent : (lib.playlists.find(p => p.name === listName) || { items: [] }).items;
  ids = ids.filter(id => !isRecording(id) && !String(id).startsWith("r:"));
  ids = ids.filter(id => songs[id] && ((songs[id].name + " " + (songs[id].artist || "") + " " + (songs[id].album || "")).toLowerCase().includes(filter)));
  const el = $("#list");
  el.innerHTML = ids.map(id => { const s = songs[id]; return `<li data-id="${id}" class="${id === st.id ? "now" : ""}"><div class="thumb" style="background:${coverFor(s.name)}"></div><div class="n"><div class="name">${lib.favorites.includes(id) ? "♥ " : ""}${s.name.replace(/\.[^.]+$/, "")}</div><div class="sub">${subLine(s)}</div></div><button class="icon more" title="More">⋯</button></li>`; }).join("")
    || `<li class="muted">${emptyText()}</li>`;
  el.querySelectorAll("li[data-id]").forEach(li => {
    li.querySelector(".n").onclick = () => { if (view === "queue") playIndex(lib.queue.indexOf(li.dataset.id)); else { lib.queue = ids.slice(); save("queue"); playIndex(ids.indexOf(li.dataset.id)); } window.scrollTo({ top: 0, behavior: "smooth" }); };
    li.querySelector(".more").onclick = () => songMenu(li.dataset.id);
  });
  $("#listTabs").innerHTML = lib.playlists.map(p => `<button data-view="list" data-name="${p.name}" class="${view === "list" && listName === p.name ? "on" : ""}">${p.name}</button>`).join("");
  $("#views").querySelectorAll("button").forEach(b => { b.classList.toggle("on", b.dataset.view === view && (view !== "list" || b.dataset.name === listName)); b.onclick = () => { view = b.dataset.view; listName = b.dataset.name || ""; if (view === "phone" && phoneState === "denied") loadPhone(true); if (view === "recordings" && ANDROID) loadRecordings(); renderList(); }; });
  const n = ids.length;
  if (view === "phone") $("#storage").textContent = phoneState === "ok" ? `${n} song${n === 1 ? "" : "s"} on this phone` : "";
  else if (view === "recordings") $("#storage").textContent = ANDROID ? `${n} recording${n === 1 ? "" : "s"} · saved in Recordings/AVB Music Player on your phone` : `${n} recording${n === 1 ? "" : "s"} · kept in the app`;
  else if (!ANDROID && navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => $("#storage").textContent = `${Object.keys(songs).length} songs stored in the app · ${(e.usage / 1e6).toFixed(0)} MB of ${(e.quota / 1e9).toFixed(1)} GB`);
  else $("#storage").textContent = "";
}
function sheet(items, title) {
  const s = $("#sheet");
  s.innerHTML = (title ? `<div class="sheettitle">${title.replace(/</g, "&lt;")}</div>` : "") + items.map((it, i) => `<button class="${it.danger ? "danger" : ""}" data-i="${i}">${it.label}</button>`).join("") + `<button data-i="-1">Cancel</button>`;
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
  items.unshift({ label: "Share… (any format)", run: () => shareSong(id) });
  const rec = isRecording(id);
  const twin = phoneTwin(id);                         // the phone file behind an app copy, when it can be found
  if (!rec) items.push({ label: "Remove from AVB Music Player (the file stays on your phone)", run: () => removeFromApp(id) });
  if (ANDROID && (id.startsWith("m:") || id.startsWith("r:") || twin))
    items.push({ label: rec ? "Delete this recording from the phone" : "Delete from phone completely", danger: true, run: () => deleteFromPhone(twin || id, id) });
  else if (rec) items.push({ label: "Delete this recording", danger: true, run: async () => {
    if (await confirmBox("Delete this recording?", `“${songs[id].name}” is erased. This cannot be undone.`, "Delete")) removeFromApp(id, true);
  } });
  sheet(items);
}
// an app copy (opened through + Open files / Share) and the same file in All music: same name and size
function phoneTwin(id) {
  const s0 = songs[id]; if (!s0 || s0.url) return null;
  return phoneIds.find(m => songs[m] && songs[m].name === s0.name && songs[m].size === s0.size) || null;
}
function forget(id) {
  lib.queue = lib.queue.filter(x => x !== id); lib.favorites = lib.favorites.filter(x => x !== id); lib.recent = lib.recent.filter(x => x !== id);
  lib.playlists.forEach(p => p.items = p.items.filter(x => x !== id)); delete lib.notes[id]; delete lib.lyrics[id];
  lib.index = st.id && lib.queue.includes(st.id) ? lib.queue.indexOf(st.id) : -1;
  for (const k of ["queue", "index", "favorites", "recent", "playlists", "notes", "lyrics"]) save(k);
  if (st.id === id) { pause(); send({ cmd: "unload" }); st.buffer = null; st.id = null; st.peaks = null; $("#title").textContent = "No song loaded"; $("#badges").innerHTML = ""; drawWave(); }
}
async function removeFromApp(id, quiet) {
  if (!songs[id]) return;
  if (songs[id].url) { if (!lib.hidden.includes(id)) lib.hidden.push(id); save("hidden"); }     // a phone song: hidden from All music
  else { await tx("songs", "readwrite", s2 => s2.delete(id)); delete songs[id]; recordingIds = recordingIds.filter(x => x !== id); }
  forget(id);
  renderList(); renderRecList();
  if (!quiet) toast("Removed from AVB Music Player. The file is still on your phone.");
}
// deleting a file from the phone: our question first, then Android's own confirmation
const deleteWaiters = {};
let deleteToken = 0;
window.avbDeleted = (token, ok) => { const f = deleteWaiters[token]; delete deleteWaiters[token]; if (f) f(!!ok); };
async function deleteFromPhone(phoneId, shownId) {
  const s0 = songs[shownId] || songs[phoneId];
  if (!(await confirmBox(isRecording(shownId) ? "Delete this recording from your phone?" : "Delete from your phone completely?",
      `“${s0.name}” is erased from the phone itself, not only from this app. This cannot be undone.`, "Delete", "Cancel"))) return;
  const token = ++deleteToken;
  const done = new Promise(r => deleteWaiters[token] = r);
  ANDROID.deletePhone(phoneId.slice(2), token);
  if (!(await done)) { toast("Not deleted"); return; }
  for (const x of new Set([phoneId, shownId])) {
    if (songs[x] && !songs[x].url) await tx("songs", "readwrite", s2 => s2.delete(x));
    forget(x); delete songs[x];
  }
  phoneIds = phoneIds.filter(x => x !== phoneId && x !== shownId); recordingIds = recordingIds.filter(x => x !== phoneId && x !== shownId);
  renderList(); renderRecList();
  toast(`Deleted “${s0.name}” from your phone`);
}
function toggleFav(id) { if (!id) return; const i = lib.favorites.indexOf(id); if (i >= 0) lib.favorites.splice(i, 1); else lib.favorites.unshift(id); save("favorites"); $("#heart").textContent = lib.favorites.includes(st.id) ? "♥" : "♡"; renderList(); }
function newPlaylist(items = []) {
  ask("New playlist", "", `Playlist ${lib.playlists.length + 1}`, "Create").then(name => { if (!name) return; newPlaylistNamed(name, items); });
}
function newPlaylistNamed(name, items) {
  lib.playlists.push({ name: name.trim(), items: items.slice() }); save("playlists"); view = "list"; listName = name.trim(); renderList();
}

// ---------------------------------------------------------------- lyrics
// Where a song's lyrics come from, in order: the user's own (saved per song),
// the file's own tags (ID3 USLT / Vorbis LYRICS / MP4 ©lyr), then LRCLIB
// (a free online library of released songs, looked up by title + artist).
let lyr = { id: null, lines: [], timed: false, text: "", source: "" };

function parseLrc(text) {
  const lines = [];
  let timed = false;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    const words = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (tags.length) {
      timed = true;
      for (const t of tags) lines.push({ t: +t[1] * 60 + parseFloat(t[2].replace(":", ".")), text: words });
    } else if (!/^\[(ar|ti|al|by|offset|length|re|ve):/i.test(raw)) lines.push({ t: null, text: words });
  }
  if (timed) lines.sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
  return { lines, timed };
}
function showLyrics(text, source, id) {
  lyr = { id, text: text || "", source, ...parseLrc(text || "") };
  const el = $("#lyrics");
  if (!lyr.text.trim()) {
    el.innerHTML = `<div class="empty">${source === "searching" ? "Looking for lyrics…" : "No lyrics found for this song. Tap Edit to paste or type them."}</div>`;
  } else {
    el.innerHTML = lyr.lines.map((l, i) => l.text ? `<div class="l" data-i="${i}">${l.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>` : `<div class="l gap"></div>`).join("");
    if (lyr.timed) el.querySelectorAll(".l[data-i]").forEach(d => d.onclick = () => { const t = lyr.lines[+d.dataset.i].t; if (t != null) seek(t); });
  }
  $("#lyrSource").textContent = { mine: "Your lyrics", file: "From the file", lrclib: "From LRCLIB (online)", searching: "", none: "" }[source] || "";
  $("#lyrCopy").disabled = !lyr.text.trim();
}
function tagTitleArtist(name) {
  // "Artist - Title.mp3" -> both; otherwise the title only
  const stem = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = stem.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1], title: m[2] } : { artist: "", title: stem };
}
async function findLyrics(id, rec) {
  showLyrics("", "searching", id);
  if (lib.lyrics[id]) { showLyrics(lib.lyrics[id], "mine", id); openLyricsTab(); return; }
  let tags = {};
  try { tags = await readTags(rec.blob, rec.name); } catch (_) { }
  if (st.id !== id) return;
  if (tags.lyrics && tags.lyrics.trim()) { showLyrics(tags.lyrics, "file", id); openLyricsTab(); return; }
  const guess = tagTitleArtist(rec.name);
  const title = tags.title || songs[id]?.title || guess.title, artist = tags.artist || songs[id]?.artist || guess.artist;
  if (!navigator.onLine || isRecording(id) || !title || /^<unknown>$/i.test(artist || "")) { showLyrics("", "none", id); return; }
  try {
    const q = new URLSearchParams({ track_name: title });
    if (artist && !/unknown/i.test(artist)) q.set("artist_name", artist);
    let r = await fetch("https://lrclib.net/api/get?" + q, { headers: { "Accept": "application/json" } });
    let d = r.ok ? await r.json() : null;
    if (!d) {
      r = await fetch("https://lrclib.net/api/search?" + new URLSearchParams({ q: `${artist || ""} ${title}`.trim() }));
      const list = r.ok ? await r.json() : [];
      d = (list || []).find(x => x.syncedLyrics || x.plainLyrics) || null;
    }
    if (st.id !== id) return;
    if (d && (d.syncedLyrics || d.plainLyrics)) { showLyrics(d.syncedLyrics || d.plainLyrics, "lrclib", id); openLyricsTab(); }
    else showLyrics("", "none", id);
  } catch (_) { if (st.id === id) showLyrics("", "none", id); }
}
function openLyricsTab() {
  // lyrics appear under the song by themselves, unless the user is busy in another tool
  const on = document.querySelector("#tools button.on");
  if (!on || on.dataset.tab === "intel" || on.dataset.tab === "songs") selectTool("lyrics");
}
function lyricsTick(t) {
  if (!lyr.timed || !$("#tab-lyrics").classList.contains("on")) return;
  let k = -1;
  for (let i = 0; i < lyr.lines.length; i++) if (lyr.lines[i].t != null && lyr.lines[i].t <= t + 0.15) k = i;
  if (k === lyr.now) return;
  lyr.now = k;
  $("#lyrics").querySelectorAll(".l.now").forEach(d => d.classList.remove("now"));
  const cur = $("#lyrics").querySelector(`.l[data-i="${k}"]`);
  if (cur) { cur.classList.add("now"); const box = $("#lyrics"); box.scrollTop = cur.offsetTop - box.offsetTop - box.clientHeight / 3; }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { }
  const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch (_) { }
  ta.remove(); return ok;
}
// plain lyrics for copying: without the [mm:ss] times
const plainLyrics = () => lyr.lines.map(l => l.text).join("\n").replace(/\n{3,}/g, "\n\n").trim();

// ---- tags inside the file
const dec = (bytes, enc) => {
  if (enc === 1 || enc === 2) { const le = enc === 1 ? !(bytes[0] === 0xFE && bytes[1] === 0xFF) : false; const start = enc === 1 && (bytes[0] === 0xFF || bytes[0] === 0xFE) ? 2 : 0;
    return new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes.subarray(start)); }
  return new TextDecoder(enc === 0 ? "latin1" : "utf-8").decode(bytes);
};
function id3(view, base) {
  const out = {};
  if (view.getUint8(base) !== 0x49 || view.getUint8(base + 1) !== 0x44 || view.getUint8(base + 2) !== 0x33) return out;
  const ver = view.getUint8(base + 3);
  const syn = i => ((view.getUint8(i) & 127) << 21) | ((view.getUint8(i + 1) & 127) << 14) | ((view.getUint8(i + 2) & 127) << 7) | (view.getUint8(i + 3) & 127);
  const size = syn(base + 6);
  let p = base + 10;
  const end = Math.min(view.byteLength, base + 10 + size);
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  while (p + 10 < end) {
    const fid = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(fid)) break;
    const fs = ver === 4 ? syn(p + 4) : view.getUint32(p + 4);
    const body = u8.subarray(p + 10, p + 10 + fs);
    const enc = body[0];
    const zero = enc === 1 || enc === 2 ? 2 : 1;
    const afterTerm = (b, from) => { for (let i = from; i < b.length - (zero - 1); i += zero) { if (b[i] === 0 && (zero === 1 || b[i + 1] === 0)) return i + zero; } return b.length; };
    if (fid === "USLT") { const k = afterTerm(body, 4); out.lyrics = dec(body.subarray(k), enc).replace(/\0+$/, ""); }
    else if (fid === "TIT2") out.title = dec(body.subarray(1), enc).replace(/\0+$/, "");
    else if (fid === "TPE1") out.artist = dec(body.subarray(1), enc).replace(/\0+$/, "");
    else if (fid === "TXXX") { const k = afterTerm(body, 1); const key = dec(body.subarray(1, k - zero), enc).toUpperCase(); if (/LYRICS/.test(key) && !out.lyrics) out.lyrics = dec(body.subarray(k), enc).replace(/\0+$/, ""); }
    p += 10 + fs;
  }
  return out;
}
function vorbis(u8, start) {
  // a Vorbis comment block: vendor string, then KEY=value pairs
  const dv = new DataView(u8.buffer, u8.byteOffset + start);
  const out = {};
  let p = 4 + dv.getUint32(0, true);
  const n = dv.getUint32(p, true); p += 4;
  for (let i = 0; i < n && p < dv.byteLength; i++) {
    const len = dv.getUint32(p, true); p += 4;
    const kv = new TextDecoder().decode(u8.subarray(start + p, start + p + len)); p += len;
    const eq = kv.indexOf("="); if (eq < 0) continue;
    const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1);
    if ((k === "LYRICS" || k === "UNSYNCEDLYRICS" || k === "UNSYNCED LYRICS") && !out.lyrics) out.lyrics = v;
    if (k === "TITLE") out.title = v; if (k === "ARTIST") out.artist = v;
  }
  return out;
}
async function readTags(blob, name) {
  const f = fmtOf(name);
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4 * 1024 * 1024)).arrayBuffer());
  const view = new DataView(head.buffer);
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return id3(view, 0);                      // MP3 (or any file starting with ID3)
  if (f === "FLAC" && head[0] === 0x66) {
    let p = 4;
    while (p + 4 < head.length) {
      const last = head[p] & 0x80, type = head[p] & 0x7f, len = (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3];
      if (type === 4) return vorbis(head, p + 4);
      p += 4 + len; if (last) break;
    }
    return {};
  }
  if (f === "WAV" || f === "AIFF" || f === "AIF") {                                                      // an "id3 " chunk inside the file
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 2 * 1024 * 1024)).arrayBuffer());
    for (const buf of [head, tail]) for (let i = 0; i + 13 < buf.length; i++)
      if ((buf[i] === 0x69 || buf[i] === 0x49) && buf[i + 1] === 0x44 && buf[i + 2] === 0x33 && buf[i + 3] === 0x20 && buf[i + 8] === 0x49 && buf[i + 9] === 0x44 && buf[i + 10] === 0x33)
        return id3(new DataView(buf.buffer, buf.byteOffset + i + 8), 0);
    return {};
  }
  if (f === "OGG" || f === "OPUS") {
    for (let i = 0; i + 8 < head.length; i++)
      if ((head[i] === 3 && String.fromCharCode(...head.subarray(i + 1, i + 7)) === "vorbis") || String.fromCharCode(...head.subarray(i, i + 8)) === "OpusTags")
        return vorbis(head, i + (head[i] === 3 ? 7 : 8));
    return {};
  }
  if (f === "M4A" || f === "AAC" || f === "MP4") {
    const out = {};
    const find = (sig) => { for (let i = 0; i + 4 < head.length; i++) if (head[i] === sig[0] && head[i + 1] === sig[1] && head[i + 2] === sig[2] && head[i + 3] === sig[3]) return i; return -1; };
    const data = at => { const d = at + 4; if (String.fromCharCode(...head.subarray(d + 4, d + 8)) !== "data") return ""; const len = new DataView(head.buffer).getUint32(d); return new TextDecoder().decode(head.subarray(d + 16, d + len)); };
    let i = find([0xA9, 0x6C, 0x79, 0x72]); if (i >= 0) out.lyrics = data(i);
    i = find([0xA9, 0x6E, 0x61, 0x6D]); if (i >= 0) out.title = data(i);
    i = find([0xA9, 0x41, 0x52, 0x54]); if (i >= 0) out.artist = data(i);
    return out;
  }
  return {};
}

// ---------------------------------------------------------------- EQ
// Eight bands: low cut, low shelf, four bells, air shelf, high cut; plus an
// output level.  Biquads in the live chain; the same chain renders copies.
const EQ_COLOURS = ["#94A3B8", "#3B82F6", "#22D3EE", "#8B5CF6", "#D946EF", "#EC4899", "#F97316", "#94A3B8"];
const EQ_DEFAULT = () => ({ on: true, out: 0, bands: [
  { label: "Low cut", type: "highpass", f: 30, g: 0, q: 0.71, on: false },
  { label: "Low", type: "lowshelf", f: 100, g: 0, q: 0.71, on: true },
  { label: "Low-mid", type: "peaking", f: 250, g: 0, q: 1, on: true },
  { label: "Mid", type: "peaking", f: 800, g: 0, q: 1, on: true },
  { label: "Upper-mid", type: "peaking", f: 2500, g: 0, q: 1, on: true },
  { label: "Presence", type: "peaking", f: 5000, g: 0, q: 1, on: true },
  { label: "Air", type: "highshelf", f: 10000, g: 0, q: 0.71, on: true },
  { label: "High cut", type: "lowpass", f: 18000, g: 0, q: 0.71, on: false },
] });
if (!lib.eq || !lib.eq.bands || lib.eq.bands.length !== 8) lib.eq = EQ_DEFAULT();
const EQ_PRESETS = {
  flat: [],
  vocal: [[0, { on: true, f: 80 }], [2, { g: -2, f: 250, q: 1 }], [4, { g: 3, f: 3000, q: 0.9 }], [6, { g: 2, f: 11000 }]],
  bass: [[1, { g: 5, f: 100 }], [2, { g: -1, f: 300 }]],
  boomy: [[0, { on: true, f: 40 }], [2, { g: -4, f: 220, q: 1.2 }]],
  warm: [[1, { g: 2.5, f: 150 }], [6, { g: -2.5, f: 8000 }]],
  bright: [[5, { g: 2, f: 5000 }], [6, { g: 4, f: 9000 }]],
  scoop: [[3, { g: -3.5, f: 700, q: 0.8 }]],
  harsh: [[4, { g: -3, f: 3200, q: 1.4 }], [5, { g: -2, f: 6500, q: 2 }]],
  phone: [[0, { on: true, f: 300 }], [7, { on: true, f: 3400 }], [4, { g: 4, f: 1500, q: 0.7 }]],
};
let eqNodes = [], eqOut = null, eqAnalyser = null, eqSel = 4;
const eqBandActive = b => b.on && ((b.type === "highpass" || b.type === "lowpass") || Math.abs(b.g) > 0.05);
function eqActive() { return lib.eq.on && (lib.eq.bands.some(eqBandActive) || Math.abs(lib.eq.out) > 0.05); }
function setBiquad(n, b, ctxt) {
  n.type = b.type;
  const t = ctxt.currentTime;
  n.frequency.setTargetAtTime(b.f, t, 0.01); n.Q.setTargetAtTime(b.q, t, 0.01);
  n.gain.setTargetAtTime(b.on ? b.g : 0, t, 0.01);
}
function makeChain(c, input, output) {
  // only the bands that do something are in the chain
  let last = input;
  for (const b of lib.eq.bands) { if (!lib.eq.on || !eqBandActive(b)) continue; const n = c.createBiquadFilter(); n.type = b.type; n.frequency.value = b.f; n.Q.value = b.q; n.gain.value = b.g; last.connect(n); last = n; }
  const g = c.createGain(); g.gain.value = lib.eq.on ? Math.pow(10, lib.eq.out / 20) : 1;
  last.connect(g); g.connect(output);
}
function buildEqChain() {
  if (!ctx || !node) return;
  try { node.disconnect(); } catch (_) { }
  eqNodes.forEach(n => { try { n.disconnect(); } catch (_) { } });
  if (eqOut) try { eqOut.disconnect(); } catch (_) { }
  eqNodes = lib.eq.bands.map(b => { const n = ctx.createBiquadFilter(); setBiquad(n, b, ctx); return n; });
  eqOut = ctx.createGain();
  eqAnalyser = eqAnalyser || ctx.createAnalyser(); eqAnalyser.fftSize = 4096; eqAnalyser.smoothingTimeConstant = 0.8;
  let last = node;
  if (lib.eq.on) for (const n of eqNodes) { last.connect(n); last = n; }
  last.connect(eqOut); eqOut.gain.value = lib.eq.on ? Math.pow(10, lib.eq.out / 20) : 1;
  eqOut.connect(ctx.destination); eqOut.connect(eqAnalyser);
}
function eqChanged(rebuild) {
  save("eq");
  if (ctx && node) {
    if (rebuild || eqNodes.length !== 8) buildEqChain();
    else { lib.eq.bands.forEach((b, i) => setBiquad(eqNodes[i], b, ctx)); eqOut.gain.setTargetAtTime(lib.eq.on ? Math.pow(10, lib.eq.out / 20) : 1, ctx.currentTime, 0.01); }
  }
  drawEq(); fillEqEdit(); refreshSave();
}
async function renderEq(chans, sr) {
  const off = new OfflineAudioContext(chans.length, chans[0].length, sr);
  const buf = off.createBuffer(chans.length, chans[0].length, sr);
  chans.forEach((c, i) => buf.copyToChannel(c, i));
  const src = off.createBufferSource(); src.buffer = buf;
  makeChain(off, src, off.destination); src.start();
  return channelsOf(await off.startRendering());
}
// response: the product of every band's curve, from a scratch context when the player has not started
let eqScratch = null;
function eqResponse(freqs) {
  const c = ctx || (eqScratch = eqScratch || new OfflineAudioContext(1, 1, 48000));
  const mag = new Float32Array(freqs.length).fill(1), m = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
  const each = [];
  for (const b of lib.eq.bands) {
    const n = c.createBiquadFilter(); n.type = b.type; n.frequency.value = b.f; n.Q.value = b.q; n.gain.value = b.g;
    n.getFrequencyResponse(freqs, m, ph);
    const db = Float32Array.from(m, v => 20 * Math.log10(Math.max(v, 1e-6)));
    each.push(db);
    if (lib.eq.on && eqBandActive(b)) for (let i = 0; i < freqs.length; i++) mag[i] *= m[i];
  }
  const total = Float32Array.from(mag, v => 20 * Math.log10(Math.max(v, 1e-6)) + (lib.eq.on ? lib.eq.out : 0));
  return { total, each };
}
const EQ_MIN = 20, EQ_MAX = 20000, EQ_DB = 18;
const eqX = (f, w) => Math.log(f / EQ_MIN) / Math.log(EQ_MAX / EQ_MIN) * w;
const eqF = (x, w) => EQ_MIN * Math.pow(EQ_MAX / EQ_MIN, Math.max(0, Math.min(1, x / w)));
function drawEq() {
  const cv = $("#eqCurve"); if (!cv || !$("#tab-eq").classList.contains("on")) return;
  const dpr = sizeCanvas(cv), w = cv.width / dpr, h = cv.height / dpr, c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = "#0E0D26"; c.fillRect(0, 0, w, h);
  const y = db => h / 2 - db / EQ_DB * (h / 2 - 14);
  // the music's spectrum behind the curve
  if (eqAnalyser && st.playing) {
    const bins = new Float32Array(eqAnalyser.frequencyBinCount); eqAnalyser.getFloatFrequencyData(bins);
    const nyq = ctx.sampleRate / 2;
    c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x < w; x += 2) { const f = eqF(x, w), i = Math.min(bins.length - 1, Math.round(f / nyq * bins.length)); const v = Math.max(0, (bins[i] + 100) / 80); c.lineTo(x, h - v * (h - 10)); }
    c.lineTo(w, h); c.closePath(); c.fillStyle = "rgba(139,92,246,.18)"; c.fill();
  }
  // grid
  c.strokeStyle = "#232250"; c.lineWidth = 1; c.fillStyle = "#6C6996"; c.font = "10px system-ui"; c.textAlign = "center";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = eqX(f, w); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); c.fillText(f >= 1000 ? f / 1000 + "k" : f, x, h - 3); }
  c.textAlign = "left";
  for (const db of [-12, -6, 0, 6, 12]) { c.strokeStyle = db === 0 ? "#34336B" : "#1b1a42"; c.beginPath(); c.moveTo(0, y(db)); c.lineTo(w, y(db)); c.stroke(); c.fillText((db > 0 ? "+" : "") + db, 3, y(db) - 2); }
  // curve
  const N = Math.max(64, Math.floor(w / 2)), freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = eqF(i / (N - 1) * w, w);
  const r = eqResponse(freqs);
  const sel = lib.eq.bands[eqSel];
  if (sel.on || sel.type === "highpass" || sel.type === "lowpass") {      // the selected band's own shape, faint
    c.strokeStyle = EQ_COLOURS[eqSel] + "88"; c.lineWidth = 1.5; c.beginPath();
    r.each[eqSel].forEach((v, i) => { const xx = i / (N - 1) * w, yy = y(Math.max(-EQ_DB, Math.min(EQ_DB, v))); i ? c.lineTo(xx, yy) : c.moveTo(xx, yy); }); c.stroke();
  }
  const g = c.createLinearGradient(0, 0, w, 0); RUN.forEach((col, i) => g.addColorStop(i / 5, col));
  c.strokeStyle = lib.eq.on ? g : "#6C6996"; c.lineWidth = 2.5; c.beginPath();
  r.total.forEach((v, i) => { const xx = i / (N - 1) * w, yy = y(Math.max(-EQ_DB, Math.min(EQ_DB, v))); i ? c.lineTo(xx, yy) : c.moveTo(xx, yy); }); c.stroke();
  // band dots
  lib.eq.bands.forEach((b, i) => {
    const cut = b.type === "highpass" || b.type === "lowpass";
    const xx = eqX(b.f, w), yy = y(cut ? 0 : b.g);
    c.globalAlpha = b.on ? 1 : 0.35;
    c.beginPath(); c.arc(xx, yy, i === eqSel ? 9 : 7, 0, Math.PI * 2); c.fillStyle = EQ_COLOURS[i]; c.fill();
    if (i === eqSel) { c.strokeStyle = "#fff"; c.lineWidth = 2; c.stroke(); }
    c.fillStyle = "#fff"; c.font = "700 9px system-ui"; c.textAlign = "center"; c.fillText(String(i + 1), xx, yy + 3);
    c.globalAlpha = 1;
  });
}
const fmtHz = f => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, "") + " kHz" : Math.round(f) + " Hz";
function fillEqEdit() {
  const b = lib.eq.bands[eqSel], cut = b.type === "highpass" || b.type === "lowpass";
  $("#eqBands").innerHTML = lib.eq.bands.map((x, i) => `<button data-i="${i}" class="${i === eqSel ? "sel" : ""} ${x.on ? "" : "off"}" style="color:${EQ_COLOURS[i]}">${i + 1} ${x.label}</button>`).join("");
  $("#eqBands").querySelectorAll("button").forEach(bt => bt.onclick = () => { eqSel = +bt.dataset.i; fillEqEdit(); drawEq(); });
  $("#eqName").textContent = `${eqSel + 1} · ${b.label}`; $("#eqName").style.color = EQ_COLOURS[eqSel];
  $("#eqBandOn").checked = b.on;
  $("#eqF").value = Math.round(Math.log(b.f / EQ_MIN) / Math.log(EQ_MAX / EQ_MIN) * 1000); $("#eqFv").textContent = fmtHz(b.f);
  $("#eqGrow").hidden = cut;
  $("#eqG").value = Math.round(b.g * 10); $("#eqGv").textContent = (b.g > 0 ? "+" : "") + b.g.toFixed(1) + " dB";
  $("#eqQ").value = Math.round(Math.log(b.q / 0.2) / Math.log(15 / 0.2) * 1000); $("#eqQv").textContent = b.q.toFixed(2);
  $("#eqOut").value = Math.round(lib.eq.out * 10); $("#eqOutv").textContent = (lib.eq.out > 0 ? "+" : "") + lib.eq.out.toFixed(1) + " dB";
  $("#eqOn").checked = lib.eq.on;
}
function eqWire() {
  const band = () => lib.eq.bands[eqSel];
  $("#eqOn").onchange = e => { lib.eq.on = e.target.checked; eqChanged(true); };
  $("#eqBandOn").onchange = e => { band().on = e.target.checked; eqChanged(true); };
  $("#eqF").oninput = e => { band().f = EQ_MIN * Math.pow(EQ_MAX / EQ_MIN, +e.target.value / 1000); eqChanged(false); };
  $("#eqG").oninput = e => { const b = band(); const was = eqBandActive(b); b.g = +e.target.value / 10; if (Math.abs(b.g) < 0.15) b.g = 0; eqChanged(was !== eqBandActive(b)); };
  $("#eqQ").oninput = e => { band().q = 0.2 * Math.pow(15 / 0.2, +e.target.value / 1000); eqChanged(false); };
  $("#eqOut").oninput = e => { lib.eq.out = +e.target.value / 10; eqChanged(false); };
  $("#eqFlat").onclick = () => { lib.eq = EQ_DEFAULT(); eqChanged(true); };
  $("#eqPreset").onchange = e => {
    const p = EQ_PRESETS[e.target.value]; e.target.value = ""; if (!p) return;
    lib.eq = EQ_DEFAULT();
    for (const [i, v] of p) Object.assign(lib.eq.bands[i], v);
    eqChanged(true);
  };
  // drag the dots on the curve
  const cv = $("#eqCurve"); let dragging = null;
  cv.addEventListener("pointerdown", e => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, yy = e.clientY - r.top, w = r.width, h = r.height;
    const y = db => h / 2 - db / EQ_DB * (h / 2 - 14);
    let best = -1, bd = 1e9;
    lib.eq.bands.forEach((b, i) => { const cut = b.type === "highpass" || b.type === "lowpass"; const d = Math.hypot(eqX(b.f, w) - x, y(cut ? 0 : b.g) - yy); if (d < bd) { bd = d; best = i; } });
    if (best < 0 || bd > 40) return;
    eqSel = best; dragging = { w, h }; try { cv.setPointerCapture(e.pointerId); } catch (_) { }
    if (!lib.eq.bands[best].on) { lib.eq.bands[best].on = true; eqChanged(true); } else { fillEqEdit(); drawEq(); }
  });
  cv.addEventListener("pointermove", e => {
    if (!dragging) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, yy = e.clientY - r.top, { w, h } = dragging;
    const b = lib.eq.bands[eqSel]; const was = eqBandActive(b);
    b.f = Math.round(eqF(x, w));
    if (!(b.type === "highpass" || b.type === "lowpass")) { b.g = Math.max(-EQ_DB, Math.min(EQ_DB, (h / 2 - yy) / (h / 2 - 14) * EQ_DB)); b.g = Math.round(b.g * 10) / 10; if (Math.abs(b.g) < 0.2) b.g = 0; }
    eqChanged(was !== eqBandActive(b));
  });
  const up = () => { dragging = null; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
}
eqWire();

// ---------------------------------------------------------------- dialogs
// An in-page question with a text field (window.prompt is not available
// inside the Android app, and this one matches the player).
function ask(title, text, value, yes = "Save", no = "Cancel", withInput = true) {
  return new Promise(done => {
    const d = $("#dialog"), inp = $("#dlgInput");
    $("#dlgTitle").textContent = title; $("#dlgText").textContent = text || ""; $("#dlgText").hidden = !text;
    $("#dlgYes").textContent = yes; $("#dlgNo").textContent = no; inp.value = value || ""; inp.hidden = !withInput;
    d.hidden = false;
    if (withInput) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const finish = v => { d.hidden = true; $("#dlgYes").onclick = $("#dlgNo").onclick = inp.onkeydown = null; done(v); };
    $("#dlgYes").onclick = () => finish(withInput ? (inp.value.trim() || value || "") : true);
    $("#dlgNo").onclick = () => finish(withInput ? null : false);
    inp.onkeydown = e => { if (e.key === "Enter") $("#dlgYes").onclick(); if (e.key === "Escape") finish(null); };
  });
}
const confirmBox = (title, text, yes, no = "Cancel") => ask(title, text, "", yes, no, false);

// ---------------------------------------------------------------- recording
// The microphone (or a USB interface the phone treats as its input) -> raw
// PCM through an AudioWorklet -> a 24-bit WAV in the app, into the queue.
// While recording the waveform draws itself live; pause/resume; on stop the
// take gets a name.
let rec = null;
async function recordStart() {
  if (rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("This device cannot record here"); return; }
  if (st.playing) pause();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  } catch (err) {
    if (err && err.name === "NotAllowedError") { toast("Microphone not allowed: " + (err.message || err.name)); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }         // the phone refused the stereo / raw settings
    catch (err2) { toast("The microphone did not start: " + (err2 && (err2.message || err2.name) || err2)); return; }
  }
  // its own audio engine for this take (closed on stop), so a second take never attaches to a spent one
  let rctx;
  try {
    rctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await rctx.audioWorklet.addModule("player-worklet.js");
    if (rctx.state === "suspended") await rctx.resume();
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    toast("Recording could not start: " + (err && err.message || err)); return;
  }
  let src, tap, nch;
  try {
    src = rctx.createMediaStreamSource(stream);
    nch = Math.max(1, Math.min(2, src.channelCount || 1));
    tap = new AudioWorkletNode(rctx, "avb-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: nch, channelCountMode: "explicit" });
  } catch (err) {
    stream.getTracks().forEach(t => t.stop()); rctx.close().catch(() => { });
    toast("No sound is coming from the microphone: " + (err && err.message || err)); return;
  }
  rec = { stream, src, tap, rctx, chunks: [], nch, frames: 0, peak: 0, clip: 0, paused: false, started: Date.now(), peaks: [], sr: rctx.sampleRate };
  const mine = rec;
  setTimeout(() => {                                          // nothing arriving: say so instead of "recording" silence
    if (rec === mine && !mine.paused && mine.frames === 0) { recordStop(false); toast("No sound is coming from the microphone. Close other apps that use it, then try again."); }
  }, 3000);
  const BLOCK = Math.round(rctx.sampleRate * 0.02);          // one waveform column per 20 ms
  let acc = 0, mn = 0, mx = 0;
  tap.port.onmessage = e => {
    const r = rec;
    if (!r || r.paused) return;
    const ch = e.data.channels;
    r.chunks.push(ch); r.frames += ch[0].length;
    let p = 0;
    const a = ch[0], b = ch[ch.length - 1];
    for (let i = 0; i < a.length; i++) {
      const v = (a[i] + b[i]) / 2, av = Math.max(Math.abs(a[i]), Math.abs(b[i]));
      if (av > p) p = av; if (av >= 0.999) r.clip++;
      if (v < mn) mn = v; if (v > mx) mx = v;
      if (++acc >= BLOCK) { r.peaks.push(mn, mx); acc = 0; mn = mx = 0; }
    }
    r.peak = Math.max(r.peak, p); r.level = p;
  };
  src.connect(tap);
  showPage("recs");
  $("#recbar").classList.add("on"); $("#recbar").classList.remove("paused");
  $("#recLabel").textContent = "REC"; $("#recPause").textContent = "❚❚ Pause";
  $("#recInfo").textContent = `${(rctx.sampleRate / 1000).toFixed(1).replace(".0", "")} kHz · ${nch === 1 ? "mono" : "stereo"} · saved as a 24-bit WAV`;
  $("#recStart").style.display = "none";
  document.querySelector(".wavecard").classList.add("recording");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function recordPause() {
  if (!rec) return;
  rec.paused = !rec.paused;
  $("#recbar").classList.toggle("paused", rec.paused);
  $("#recLabel").textContent = rec.paused ? "PAUSED" : "REC";
  $("#recPause").textContent = rec.paused ? "● Resume" : "❚❚ Pause";
  if (rec.paused) rec.peaks.push(-0.02, 0.02, -0.02, 0.02);   // a small gap marks where it paused
}
async function recordStop(keep) {
  if (!rec) return;
  const r = rec; rec = null;
  try { r.src.disconnect(); r.tap.disconnect(); r.tap.port.onmessage = null; } catch (_) { }
  r.stream.getTracks().forEach(t => t.stop());
  r.rctx.close().catch(() => { });
  $("#recbar").classList.remove("on"); $("#recStart").style.display = "";
  document.querySelector(".wavecard").classList.remove("recording");
  drawWave();
  if (!keep || !r.frames) { if (keep) toast("Nothing was recorded"); return; }
  const n = r.frames;
  const chans = []; for (let c = 0; c < r.nch; c++) chans.push(new Float32Array(n));
  let p = 0; for (const ch of r.chunks) { for (let c = 0; c < r.nch; c++) chans[c].set(ch[Math.min(c, ch.length - 1)], p); p += ch[0].length; }
  const d = new Date(r.started), pad = x => String(x).padStart(2, "0");
  const suggested = `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  let name = await ask("Name this recording", `${fmtTime(n / r.sr)} recorded`, suggested, "Save", "Discard");
  if (name === null) {
    if (await confirmBox("Throw this recording away?", "It has not been saved.", "Discard", "Keep it")) { toast("Recording discarded"); return; }
    name = suggested;
  }
  name = name.replace(/[\\/:*?"<>|]+/g, " ").trim().replace(/\.wav$/i, "") + ".wav";
  const blob = wavBlob(chans, r.sr, 24);
  await saveRecording(blob, name, r.started, n / r.sr);
  toast(`Saved “${name}” in Recordings (${fmtTime(n / r.sr)})`);
}
async function saveRecording(blob, name, started, seconds) {
  if (ANDROID && ANDROID.saveBegin) {
    await androidSave(blob, name, "recordings");            // Recordings/AVB Music Player on the phone
    loadRecordings();
    const id = recordingIds.find(x => songs[x].name === name) || recordingIds[0];
    if (id && !songs[id].duration) songs[id].duration = seconds;   // the phone may not have measured it yet
    showSavedTake(id);
    return;
  }
  // web: kept in the app, in the Recordings library only
  const id = `rec|${name}|${started}`;
  await tx("songs", "readwrite", st2 => st2.put({ id, name, size: blob.size, type: "audio/wav", added: Date.now(), blob, bits: 24, kind: "recording", duration: seconds }));
  songs[id] = { id, name, size: blob.size, type: "audio/wav", added: Date.now(), kind: "recording", duration: seconds };
  recordingIds.unshift(id);
  showSavedTake(id);
}
let freshTake = null;
function showSavedTake(id) {
  freshTake = id;
  showPage("recs");
  renderRecList();
  // nothing plays and nothing new loads: the take waits at the top of Recordings
}
function selectTool(name) {
  $("#tools").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.tab === name));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.id === "tab-" + name));
  if (name === "loud") drawLoud();
  if (name === "eq") { fillEqEdit(); drawEq(); }
}
function renderRecList() {
  const el = $("#recList");
  const ids = recordingIds.filter(id => songs[id]);
  const when = t => { if (!t) return ""; const d = new Date(t); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
  el.innerHTML = ids.map(id => { const s = songs[id]; return `<li data-id="${id}" class="${id === st.id ? "now" : ""} ${id === freshTake ? "fresh" : ""}"><div class="thumb rec"></div><div class="n"><div class="name">${s.name.replace(/\.[^.]+$/, "")}</div><div class="sub">${[s.duration ? fmtTime(s.duration) : "", when(s.added), s.size > 0 ? (s.size / 1e6).toFixed(1) + " MB" : ""].filter(Boolean).join(" · ")}</div></div><button class="icon more" title="More">⋯</button></li>`; }).join("")
    || `<li class="muted">No recordings yet: tap ● Record.</li>`;
  $("#recsInfo").textContent = ids.length ? (ANDROID ? `${ids.length} recording${ids.length === 1 ? "" : "s"} · Recordings/AVB Music Player on your phone` : `${ids.length} recording${ids.length === 1 ? "" : "s"}`) : "";
  el.querySelectorAll("li[data-id]").forEach(li => {
    li.querySelector(".n").onclick = () => { loadSong(li.dataset.id, false); window.scrollTo({ top: 0, behavior: "smooth" }); };
    li.querySelector(".more").onclick = () => songMenu(li.dataset.id);
  });
}
function drawRecording() {
  const dpr = sizeCanvas(wave); const w = wave.width / dpr, h = wave.height / dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.fillStyle = rec.paused ? "#0E0D26" : "#1a0a18"; wctx.fillRect(0, 0, w, h);
  const top = 30, bottom = h - 8, mid = (top + bottom) / 2, amp = (bottom - top) / 2 - 2;
  const cols = rec.peaks.length / 2;
  const span = Math.max(cols, Math.floor(w));                 // fills from the left, then scrolls
  const first = Math.max(0, cols - Math.floor(w));
  const g = wctx.createLinearGradient(0, 0, w, 0); ["#EF4444", "#EC4899", "#D946EF", "#8B5CF6"].forEach((c, i) => g.addColorStop(i / 3, c));
  wctx.fillStyle = g; wctx.beginPath();
  for (let i = first, x = 0; i < cols; i++, x++) {
    const lo = rec.peaks[i * 2], hi = rec.peaks[i * 2 + 1];
    wctx.rect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
  }
  wctx.fill();
  const head = Math.min(w - 2, cols - first);
  wctx.shadowColor = "#EF4444"; wctx.shadowBlur = 10; wctx.fillStyle = "#fff"; wctx.fillRect(head, top, 2, bottom - top); wctx.shadowBlur = 0;
  wctx.fillStyle = rec.paused ? "#F59E0B" : "#EF4444"; wctx.font = "800 14px system-ui"; wctx.textAlign = "left";
  wctx.fillText(rec.paused ? "❚❚ PAUSED" : "● RECORDING", 10, 20);
  wctx.textAlign = "right"; wctx.fillStyle = "#fff"; wctx.fillText(fmtTime(rec.frames / rec.sr), w - 10, 20);
  void span;
}

// ---------------------------------------------------------------- ui wiring
function showPage(p) {
  if (p === "play" || p === "library") p = "music";
  document.querySelectorAll(".page").forEach(e => e.classList.toggle("on", e.id === "page-" + p));
  $("#pages").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.page === p));
  if (p === "recs") { if (ANDROID) loadRecordings(); renderRecList(); }
  drawWave();
}
$("#pages").querySelectorAll("button").forEach(b => b.onclick = () => showPage(b.dataset.page));
$("#tools").querySelectorAll("button").forEach(b => b.onclick = () => selectTool(b.dataset.tab));
$("#files2").onchange = e => { addFiles([...e.target.files], true); e.target.value = ""; };
$("#play").onclick = togglePlay; $("#prev").onclick = prevTrack; $("#next").onclick = () => nextTrack(false);
$("#back10").onclick = () => seek(st.pos - 10); $("#fwd10").onclick = () => seek(st.pos + 10);
$("#markA").onclick = () => markButton("A"); $("#markB").onclick = () => markButton("B");
$("#repeat").onclick = () => { lib.repeat = { off: "all", all: "one", one: "off" }[lib.repeat]; save("repeat"); $("#repeat").textContent = { off: "↻ off", all: "↻ all", one: "↻ one" }[lib.repeat]; $("#repeat").classList.toggle("on", lib.repeat !== "off"); };
$("#repeat").textContent = { off: "↻ off", all: "↻ all", one: "↻ one" }[lib.repeat]; $("#repeat").classList.toggle("on", lib.repeat !== "off");
$("#seek").oninput = e => seek(+e.target.value / 1000 * st.duration);
$("#heart").onclick = () => toggleFav(st.id);
$("#shareBtn").onclick = () => shareSong();
$("#half").onclick = () => { st.bpmScale = Math.max(0.25, st.bpmScale / 2); refreshMusic(); refreshSave(); };
$("#dbl").onclick = () => { st.bpmScale = Math.min(4, st.bpmScale * 2); refreshMusic(); refreshSave(); };
// the change happens by itself: when the finger lifts off the slider, or shortly after the last tap on − / +
let changeTimer = 0;
const changeSoon = (ms = 450) => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { applyChange(); refreshSave(); }, ms); };
$("#speed").oninput = () => { refreshMusic(); };
$("#speed").onchange = () => changeSoon(50);
$("#speedQuick").onchange = e => { $("#speed").value = Math.round(+e.target.value * 100); applyChange(); refreshMusic(); refreshSave(); };
$("#bpmTarget").onchange = e => { const bpm = (st.music && st.music.bpm || 0) * st.bpmScale; if (bpm) { $("#speed").value = Math.max(50, Math.min(150, Math.round(+e.target.value / bpm * 100))); refreshMusic(); changeSoon(50); } };
$("#keyDown").onclick = () => { st.semis = Math.max(-12, st.semis - 1); refreshMusic(); changeSoon(); };
$("#keyUp").onclick = () => { st.semis = Math.min(12, st.semis + 1); refreshMusic(); changeSoon(); };

$("#resetChange").onclick = () => { st.semis = 0; $("#speed").value = 100; applyChange(); refreshMusic(); refreshSave(); };
$("#keepVoice").checked = lib.keepVoice; $("#keepVoice").onchange = e => { lib.keepVoice = e.target.checked; save("keepVoice"); if (st.semis) changeSoon(50); };
$("#finer").onchange = () => { if (st.speed !== 1 || st.semis) changeSoon(50); };
$("#part").onchange = refreshSave; $("#fmt").onchange = refreshSave; $("#saveBtn").onclick = saveCopy;
$("#lyrCopy").onclick = async () => { if (!lyr.text.trim()) return; toast(await copyText(plainLyrics()) ? "Lyrics copied" : "Could not copy: select the text and copy it"); };
$("#lyrEdit").onclick = () => { $("#lyrText").value = lyr.text; $("#lyrText").hidden = false; $("#lyrEditBtns").hidden = false; $("#lyrics").hidden = true; $("#lyrText").focus(); };
$("#lyrCancel").onclick = () => { $("#lyrText").hidden = true; $("#lyrEditBtns").hidden = true; $("#lyrics").hidden = false; };
$("#lyrSave").onclick = () => {
  if (!st.id) return;
  const t = $("#lyrText").value;
  if (t.trim()) lib.lyrics[st.id] = t; else delete lib.lyrics[st.id];
  save("lyrics"); $("#lyrCancel").onclick();
  if (t.trim()) showLyrics(t, "mine", st.id); else findLyrics(st.id, { name: st.name, blob: new Blob() });
};
$("#notes").oninput = () => { if (st.id) { lib.notes[st.id] = $("#notes").value; save("notes"); } };
$("#newList").onclick = () => newPlaylist();
$("#recBtn").onclick = recordStart; $("#recPause").onclick = recordPause;
$("#recStop").onclick = () => recordStop(true);
$("#recCancel").onclick = async () => { const was = rec && rec.paused; if (rec && !was) recordPause(); if (await confirmBox("Throw this take away?", "It has not been saved.", "Discard", "Keep recording")) recordStop(false); else if (rec && !was) recordPause(); };
$("#filter").oninput = renderList;
window.addEventListener("resize", () => { drawWave(); drawLoud(); drawEq(); });
document.addEventListener("keydown", e => { if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return; if (e.code === "Space") { e.preventDefault(); togglePlay(); } if (e.key === "ArrowLeft") seek(st.pos - 5); if (e.key === "ArrowRight") seek(st.pos + 5); });

// clock
let lastDraw = 0;
function tick(now) {
  if (rec && now - lastDraw > 33) {
    lastDraw = now;
    drawRecording();
    const lv = rec.paused ? 0 : (rec.level || 0);
    $("#recLevel").style.width = Math.min(100, Math.max(0, (20 * Math.log10(lv + 1e-6) + 48) / 48 * 100)) + "%";
    $("#recPeak").textContent = "peak " + (20 * Math.log10(rec.peak + 1e-6)).toFixed(1) + " dB" + (rec.clip ? " · CLIP" : "");
    $("#recTime").textContent = fmtTime(rec.frames / rec.sr);
  } else if (st.buffer && st.playing && now - lastDraw > 40) {
    lastDraw = now; $("#tnow").textContent = fmtTime(st.pos); lyricsTick(st.pos); if ($("#tab-eq").classList.contains("on")) drawEq(); $("#seek").value = Math.round(st.pos / st.duration * 1000); drawWave();
    if ($("#tab-loud").classList.contains("on")) drawLoud();
    const i = st.sections.findIndex(s => st.pos >= s.start && st.pos < s.end);
    document.querySelectorAll(".sec").forEach((d, k) => d.classList.toggle("now", k === i));
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function fmtTime(s) { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`; }
let toastTimer = 0;
window.addEventListener("error", e => toast("Something went wrong: " + (e.message || e.error || "unknown")));
window.addEventListener("unhandledrejection", e => toast("Something went wrong: " + (e.reason && (e.reason.message || e.reason) || "unknown")));
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove("on"), 3500); }

renderList(); drawWave(); refreshSave();
if (lib.queue.length && lib.index >= 0 && songs[lib.queue[lib.index]]) { $("#title").textContent = songs[lib.queue[lib.index]].name.replace(/\.[^.]+$/, ""); $("#listen").textContent = "Tap play to continue"; }
if (!ANDROID && "serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => { });

// ---------------------------------------------------------------- install
// Opened as an installed app: nothing to offer.  In Chrome: Chrome's own
// installer behind our button.  Elsewhere (an app's built-in browser, a
// home-screen shortcut): say how to get the real install.
const standalone = !!ANDROID || matchMedia("(display-mode: standalone)").matches || navigator.standalone;
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
// Songs handed to the app: Android's Share sheet (the service worker keeps
// them in an inbox) and, on desktop, "Open with" for the installed app.
async function takeInbox() {
  if (!("caches" in window)) return;
  const inbox = await caches.open("avb-inbox");
  const keys = await inbox.keys();
  if (!keys.length) return;
  const files = [];
  for (const k of keys.sort((x, y) => x.url.localeCompare(y.url))) {
    const r = await inbox.match(k);
    files.push(new File([await r.blob()], decodeURIComponent(r.headers.get("X-Name") || "Shared song"),
      { type: r.headers.get("Content-Type") || "", lastModified: +(r.headers.get("X-Modified") || Date.now()) }));
    await inbox.delete(k);
  }
  history.replaceState(null, "", location.pathname);
  await addFiles(files, true);
}
await takeInbox();
// The Android app: songs from "Open with" / "Share" arrive as URLs the app streams from the phone's storage.
async function takeAndroid() {
  if (!ANDROID) return;
  const items = JSON.parse(ANDROID.takePending() || "[]");
  if (!items.length) return;
  $("#listen").textContent = items.length > 1 ? `Opening ${items.length} songs…` : `Opening ${items[0].name}…`;
  const files = [];
  for (const it of items) {
    try {
      const blob = await (await fetch(it.url)).blob();
      files.push(new File([blob], it.name, { type: it.type || blob.type || "", lastModified: it.size > 0 ? it.size : Date.now() }));
    } catch (err) { toast("Could not open " + it.name); }
  }
  if (files.length) await addFiles(files, true);
}
window.avbTakeAndroid = takeAndroid;
// All music and Recordings come from the phone itself (MediaStore), streamed when played.
function phoneEntries(json, kind, prefix) {
  const out = [];
  for (const m of JSON.parse(json || "[]")) {
    const id = prefix + m.id;
    songs[id] = { id, name: m.name, title: m.title, artist: m.artist, album: m.album, duration: m.duration / 1000, size: m.size,
                  type: m.mime, url: m.url, folder: m.folder, kind, added: m.added };
    out.push(id);
  }
  return out;
}
function loadPhone(ask) {
  if (!ANDROID || !ANDROID.listMusic) return;
  const r = ANDROID.listMusic(!!ask);
  if (r === "PERMISSION") { phoneState = "denied"; renderList(); return; }       // the app asked; avbPhoneReady() follows
  phoneIds = phoneEntries(r, "phone", "m:"); phoneState = "ok"; renderList();
}
function loadRecordings() {
  if (!ANDROID || !ANDROID.listRecordings) return;
  const r = ANDROID.listRecordings();
  if (r === "PERMISSION") return;
  recordingIds = phoneEntries(r, "recording", "r:"); renderList(); if ($("#page-recs").classList.contains("on")) renderRecList();
}
window.avbPhoneReady = () => { loadPhone(false); loadRecordings(); };
if (ANDROID) { $("#viewPhone").hidden = false; setTimeout(() => { loadPhone(true); loadRecordings(); }, 300); }
else recordingIds = Object.values(songs).filter(x => x.kind === "recording").sort((a, b) => b.added - a.added).map(x => x.id);
if (ANDROID && ANDROID.askDefault) { $("#makeDefault").hidden = false; $("#makeDefault").onclick = () => ANDROID.askDefault(); }
window.avbBack = () => {
  if ($("#sheet").classList.contains("on")) { $("#sheet").classList.remove("on"); return true; }
  if (!$("#installHint").hidden) { $("#installHint").hidden = true; return true; }
  if ($("#page-recs").classList.contains("on")) { showPage("music"); return true; }
  return false;
};
await takeAndroid();
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map(h => h.getFile()));
    await addFiles(files, true);
  });
}

// a test hook: ?demo=<url> loads a file without a file picker (used only on localhost)
const demo = new URLSearchParams(location.search).get("demo");
if (demo && ["localhost", "127.0.0.1"].includes(location.hostname)) {
  const r = await fetch(demo); const blob = await r.blob();
  const f = new File([blob], decodeURIComponent(demo.split("/").pop()), { type: blob.type, lastModified: 1 });
  await addFiles([f]);
}
window.avb = { st, lib, shareSong, loadSong, applyChange, saveCopy, seek, play, pause, markButton, loopRange };
