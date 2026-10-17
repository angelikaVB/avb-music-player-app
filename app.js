// AVB Player - phone version.  Everything runs on the phone: songs you
// open are copied into the app's own storage, analyzed in a worker, played by
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
  recent: await kvGet("recent", []), playlists: await kvGet("playlists", []), notes: await kvGet("notes", {}), lyrics: await kvGet("lyrics", {}), eq: await kvGet("eq", null), lyrH: await kvGet("lyrH", 300), lyrFold: await kvGet("lyrFold", false), mkOpen: await kvGet("mkOpen", true), mkCat: await kvGet("mkCat", "idea"), recInput: await kvGet("recInput", ""), recFmt: await kvGet("recFmt", { sr: 48000, bits: 24 }), shuffle: await kvGet("shuffle", false), mono: false,
  balance: await kvGet("balance", 0), fix: await kvGet("fix", {}), marks: await kvGet("marks", {}), hidden: await kvGet("hidden", []), seenVersion: await kvGet("seenVersion", ""), sort: await kvGet("sort", "default"), mmOffered: await kvGet("mmOffered", false), renamed: await kvGet("renamed", {}),
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
  setVolume();
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
    if (d.stage === "checks") { st.checks = d; fillStats(); drawWave(); }
    if (d.stage === "tempo") { st.music = { ...(st.music || {}), ...d }; refreshMusic(); }
    if (d.stage === "key") { st.music = { ...(st.music || {}), ...d }; refreshMusic(); }
    if (d.stage === "sections") { st.sections = d.sections; drawWave(); fillSections(); $("#listen").textContent = `analyzed in ${((performance.now() - t0) / 1000).toFixed(0)} s`; }
  };
  $("#listen").textContent = "Listening…";
  worker.postMessage({ channels: chans, sampleRate: st.sr, columns: 1600 }, chans.map(c => c.buffer));
}

let loadSeq = 0;
async function loadSong(id, autoplay = true) {
  // show it at once: a big WAV takes seconds to read from the phone
  const token = ++loadSeq;
  if (st.playing) pause();
  send({ cmd: "unload" });
  st.id = id; st.buffer = null; st.loadErr = ""; st.duration = 0; st.peaks = null;
  if (songs[id]) $("#title").textContent = songs[id].name.replace(/\.[^.]+$/, "");
  $("#npArtist").textContent = ""; setMiniPlay(false);
  cutMode = false; cutFmt = "";
  updateMini(); placeWave(); renderList(); if ($("#page-recs").classList.contains("on")) renderRecList();
  let rec = null;
  if (songs[id] && songs[id].url) {
    // a song on the phone (All music / Recordings): read it where it is
    try {
      const blob = await (await fetch(songs[id].url)).blob();
      rec = { ...songs[id], blob, size: songs[id].size > 0 ? songs[id].size : blob.size };
    } catch (err) { if (token === loadSeq) { st.loadErr = "Cannot read this song"; updateMini(); drawWave(); toast("Cannot read that song from the phone"); } return; }
  } else rec = await songGet(id).catch(() => null);
  if (token !== loadSeq) return;                                   // another song was tapped meanwhile
  if (!rec || !rec.blob) { st.loadErr = "No longer in the app"; updateMini(); toast("That song is no longer in the app"); return; }
  await audio();
  if (token !== loadSeq) return;
  st.id = id; st.name = rec.name; st.playing = false; st.pos = 0; st.a = st.b = null; st.loopOn = false; st.bpmScale = 1; st.changed = false;
  st.music = null; st.sections = []; st.peaks = null; st.loud = null; st.checks = null; st.tags = null; st.view = { a: 0, b: 1 }; st.vzoom = 1;
  send({ cmd: "unload" }); send({ cmd: "loop", loop: null });
  $("#title").textContent = rec.name.replace(/\.[^.]+$/, "");
  $("#npArtist").textContent = songs[id] && songs[id].artist && !/^<unknown>$/i.test(songs[id].artist) ? songs[id].artist : "";
  setMiniPlay(false);
  $("#listen").textContent = "Reading…";
  $("#cover").style.background = coverFor(rec.name);
  syncMarkers(); refreshMusic(); fillSections(); drawWave();
  let buf;
  try {
    const ab = await rec.blob.arrayBuffer();
    try { buf = await ctx.decodeAudioData(ab.slice(0)); }
    catch (err) {
      const pcm = decodePcm(ab);                                   // AIFF / AIFF-C, 64-bit float WAV ...
      if (!pcm) throw new Error(/\.m4a$/i.test(rec.name) ? "Apple Lossless (ALAC) is not supported yet" : "this format cannot be opened");
      buf = await toContextBuffer(pcm);
    }
  } catch (err) {
    st.loadErr = "Cannot play this file"; updateMini(); drawWave();
    toast("Cannot play this file: " + (err && err.message || "unknown format")); $("#listen").textContent = ""; return;
  }
  if (st.id !== id || token !== loadSeq) return;
  st.buffer = buf; st.sr = buf.sampleRate; st.duration = buf.duration;
  const hdr = await sniffHeader(rec.blob, rec.name);
  st.info = { fmt: fmtOf(rec.name), rate: hdr.rate || buf.sampleRate, channels: buf.numberOfChannels, size: rec.size, bits: hdr.bits || bitsOf(rec) };
  fillBadges(); fillStats();
  const chans = channelsOf(buf);
  send({ cmd: "load", channels: chans });
  $("#tdur").textContent = fmtTime(buf.duration); $("#hDur").textContent = fmtTime(buf.duration); $("#hNow").textContent = "0:00";
  if (mkEditing && mkEditing.ctx === songMk) closeMarkEdit();
  $("#notes").value = lib.notes[id] || "";
  renderMarks();
  readTags(rec.blob, rec.name).catch(() => ({})).then(tags => { if (st.id !== id) return; st.tags = tags; if (tags.artist) $("#npArtist").textContent = tags.artist; if (tags.title && !lib.renamed[id]) $("#title").textContent = tags.title; showCover(id, tags); updateMini(); mediaReport(); findLyrics(id, rec, tags); });
  if (!isRecording(id)) { lib.recent = [id, ...lib.recent.filter(x => x !== id)].slice(0, 60); save("recent"); }
  if ($("#page-recs").classList.contains("on")) renderRecList();
  analyse();
  if (st.speed !== 1 || st.semis) applyChange();            // the sliders carry over to the next song
  if (autoplay) play();
  updateMini(); placeWave();
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: $("#title").textContent, artist: "AVB Player" });
  mediaReport();
  renderList();
}
// ---- our own reader for uncompressed files the browser engine refuses
function decodePcm(ab, headerOnly) {
  const v = new DataView(ab), u8 = new Uint8Array(ab);
  const tag = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  let fmt = null, data = null;
  if (tag(0) === "RIFF" && tag(8) === "WAVE") {
    for (let p = 12; p + 8 <= u8.length;) {
      const id = tag(p), size = v.getUint32(p + 4, true);
      if (id === "fmt ") {
        let code = v.getUint16(p + 8, true);
        if (code === 0xFFFE && size >= 40) code = v.getUint16(p + 32, true);   // WAVE_FORMAT_EXTENSIBLE: the real code
        fmt = { ch: v.getUint16(p + 10, true), sr: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true), float: code === 3, le: true };
      } else if (id === "data") { data = { off: p + 8, len: Math.min(size, u8.length - p - 8) }; }
      p += 8 + size + (size & 1);
    }
  } else if (tag(0) === "FORM" && (tag(8) === "AIFF" || tag(8) === "AIFC")) {
    const aifc = tag(8) === "AIFC";
    for (let p = 12; p + 8 <= u8.length;) {
      const id = tag(p), size = v.getUint32(p + 4, false);
      if (id === "COMM") {
        const ch = v.getUint16(p + 8, false), bits = v.getUint16(p + 14, false);
        // 80-bit extended sample rate
        const ex = v.getUint16(p + 16, false), hi = v.getUint32(p + 18, false), lo = v.getUint32(p + 22, false);
        const sr = Math.round((hi * 4294967296 + lo) * Math.pow(2, (ex & 0x7fff) - 16383 - 63));
        const comp = aifc ? tag(p + 26) : "NONE";
        fmt = { ch, sr, bits, float: comp === "fl32" || comp === "FL32" || comp === "fl64" || comp === "FL64", le: comp === "sowt" };
        if (comp === "fl64" || comp === "FL64") fmt.bits = 64; if (comp === "fl32" || comp === "FL32") fmt.bits = 32;
        if (aifc && !["NONE", "sowt", "fl32", "FL32", "fl64", "FL64"].includes(comp)) return null;
      } else if (id === "SSND") { const offset = v.getUint32(p + 8, false); data = { off: p + 16 + offset, len: Math.min(size - 8 - offset, u8.length - p - 16 - offset) }; }
      p += 8 + size + (size & 1);
    }
  }
  if (!fmt || !fmt.ch || !fmt.sr) return null;
  if (headerOnly) return { channels: [], sampleRate: fmt.sr, bits: fmt.bits };
  if (!data) return null;
  const bps = fmt.bits / 8, frames = Math.floor(data.len / (bps * fmt.ch));
  const out = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
  for (let i = 0, p = data.off; i < frames; i++) for (let c = 0; c < fmt.ch; c++, p += bps) {
    let x;
    if (fmt.float) x = bps === 8 ? v.getFloat64(p, fmt.le) : v.getFloat32(p, fmt.le);
    else if (bps === 1) x = fmt.le ? (u8[p] - 128) / 128 : v.getInt8(p) / 128;      // WAV 8-bit is unsigned, AIFF signed
    else if (bps === 2) x = v.getInt16(p, fmt.le) / 32768;
    else if (bps === 3) { const b0 = u8[fmt.le ? p : p + 2], b1 = u8[p + 1], b2 = u8[fmt.le ? p + 2 : p]; let n = b0 | (b1 << 8) | (b2 << 16); if (n & 0x800000) n -= 0x1000000; x = n / 8388608; }
    else x = v.getInt32(p, fmt.le) / 2147483648;
    out[c][i] = x;
  }
  return { channels: out, sampleRate: fmt.sr, bits: fmt.bits };
}
async function toContextBuffer(pcm) {
  // the player runs at the phone's rate: convert, the way the browser engine would
  const n = pcm.channels[0].length, nch = pcm.channels.length;
  const off = new OfflineAudioContext(nch, Math.max(1, Math.round(n * ctx.sampleRate / pcm.sampleRate)), ctx.sampleRate);
  const b = off.createBuffer(nch, n, pcm.sampleRate);
  pcm.channels.forEach((c, i) => b.copyToChannel(c, i));
  const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start();
  return off.startRendering();
}
function coverFor(name) {
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = RUN[h % 6], b = RUN[((h >>> 3) + 1 + (h % 5)) % 6];
  return `linear-gradient(135deg, ${a}66, ${b}cc), #1e1b4b`;
}
const fmtOf = n => (n.split(".").pop() || "").toUpperCase();
function bitsOf(rec) {
  // only WAV/AIFF/FLAC headers say their depth; others are compressed
  const f = fmtOf(rec.name);
  if (f === "WAV" || f === "AIFF" || f === "AIF" || f === "AIFC" || f === "FLAC") return rec.bits || 0;
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
    if ((f === "AIFF" || f === "AIF" || f === "AIFC") && head.getUint32(0, false) === 0x464f524d) {
      const pcm = decodePcm(await blob.slice(0, 4096).arrayBuffer(), true);
      if (pcm) return { rate: pcm.sampleRate, bits: pcm.bits };
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
function play() {
  if (!st.buffer) return;
  // the phone's audio first: other music apps pause; during a call Android says no
  if (ANDROID && ANDROID.mediaFocus && !ANDROID.mediaFocus()) { toast("A call is using the audio. Play again after it."); return; }
  audio().then(() => { send({ cmd: "play" }); st.playing = true; setMiniPlay(true); if (ANDROID) ANDROID.playing(true); if (navigator.mediaSession) navigator.mediaSession.playbackState = "playing"; mediaReport(); });
}
function pause() { send({ cmd: "pause" }); st.playing = false; setMiniPlay(false); if (ANDROID) ANDROID.playing(false); if (navigator.mediaSession) navigator.mediaSession.playbackState = "paused"; mediaReport(); }
// ---- the phone's side of playing (Android app): lock screen, notification, headset / car buttons, audio focus
let mediaTimer = 0, duck = 1;
function mediaReport() {
  if (!ANDROID || !ANDROID.mediaState) return;
  clearTimeout(mediaTimer);
  const s0 = st.id && songs[st.id];
  try {
    ANDROID.mediaState(JSON.stringify({
      playing: !!st.playing, loaded: !!s0, id: st.id || "",
      title: s0 ? $("#title").textContent : "", artist: s0 ? ($("#npArtist").textContent || "") : "",
      album: (st.tags && st.tags.album) || (s0 && s0.album) || "",
      duration: st.buffer ? st.duration : 0, position: st.pos || 0, speed: 1,
      shuffle: !!lib.shuffle, repeat: lib.repeat || "off",
    }));
  } catch (_) { }
}
const mediaReportSoon = (ms = 300) => { clearTimeout(mediaTimer); mediaTimer = setTimeout(mediaReport, ms); };
setInterval(() => { if (st.playing) mediaReport(); }, 15000);          // keeps the lock screen's clock honest
const setVolume = () => { if (node) node.port.postMessage({ cmd: "volume", volume: lib.volume * duck }); };
// what Android asks of the page (MediaHub.page)
window.avbMedia = (cmd, arg) => {
  if (cmd === "play") { if (!st.playing && (st.buffer || lib.queue.length)) togglePlay(); }
  else if (cmd === "pause") {
    if (arg === "device") { duck = 0; setVolume(); }                // silent at once: never out of the phone's speaker
    if (st.playing) pause();
    if (arg === "device") { setTimeout(() => { duck = 1; setVolume(); }, 400); toast("Paused: the headphones or speaker disconnected"); }
  }
  else if (cmd === "next") nextTrack(false);
  else if (cmd === "prev") prevTrack();
  else if (cmd === "seek") { seek(+arg); mediaReport(); }
  else if (cmd === "shuffle") $("#shuffle").click();
  else if (cmd === "repeat") $("#repeat").click();
  else if (cmd === "duck") { duck = +arg || 0.25; setVolume(); }       // a navigation prompt
  else if (cmd === "unduck") { duck = 1; setVolume(); }
};
function togglePlay() { if (!st.buffer) { if (lib.queue.length) playIndex(Math.max(0, lib.index), true); else $("#files2").click(); return; } st.playing ? pause() : play(); }
function seek(t) { if (!st.buffer) return; t = Math.max(0, Math.min(st.duration, t)); st.pos = t; send({ cmd: "seek", frame: Math.round(t * st.sr) }); drawWave(); mediaReportSoon();
  $("#miniProg").style.width = (t / st.duration * 100) + "%"; $("#tnow").textContent = fmtTime(t); $("#hNow").textContent = fmtTime(t); $("#seek").value = Math.round(t / st.duration * 1000); }
function onEnded() {
  st.playing = false; setMiniPlay(false); if (ANDROID) ANDROID.playing(false);
  mediaReportSoon(1500);                                 // the next song usually starts before this reports "stopped"
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
  if (lib.shuffle && lib.queue.length > 1) {
    let n; do { n = Math.floor(Math.random() * lib.queue.length); } while (n === lib.index);
    playIndex(n, auto || st.playing); return;
  }
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
  updateCut();
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
    // back to the original: a change still being made must not land afterwards
    if (st.rendering) { st.rendering.terminate(); st.rendering = null; }
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
    $("#changeStatus").textContent = "";
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
const fixOf = () => (st.id && lib.fix[st.id]) || {};
function effBpm() { const f = fixOf(); return f.bpm || ((st.music && st.music.bpm || 0) * st.bpmScale); }
function effKey() { const f = fixOf(); return f.key || (st.music && st.music.key) || ""; }
// (the teal circle in the tempo slider marks the original tempo once it has moved; tap it to go back)
function refreshMusic() {
  const m = st.music || {}; const sp = +$("#speed").value; const fx = fixOf();
  $("#speedval").textContent = sp + "%"; $("#speedBtn").textContent = `${+(sp / 100).toFixed(2)}×`; $("#speedBtn").classList.toggle("on", sp !== 100);
  { const b0 = effBpm(); $("#speedBpm").textContent = (b0 ? `${(b0 * sp / 100).toFixed(1)} BPM` : "— BPM") + (sp !== 100 ? ` · ${sp}%` : ""); }
  $("#speedBpm").classList.toggle("moved", sp !== 100);
  fillHomeSub();              // the song's own tempo teal, a changed one yellow
  $("#semis").textContent = st.semis ? `${st.semis > 0 ? "+" : ""}${st.semis} st` : "±0 st";
  $("#tempoReset").classList.toggle("on", sp !== 100); $("#tempoMid").hidden = sp === 100; $("#keyReset").classList.toggle("on", !!st.semis);
  const bpm = effBpm();
  $("#bpm").textContent = bpm ? (bpm * sp / 100).toFixed(1) : "—";
  $("#bpmnote").textContent = bpm ? (sp !== 100 ? `${bpm.toFixed(1)} as recorded, at ${sp}%` : fx.bpm ? (fx.bpmHow === "tap" ? "tapped by you" : "set by you") : `beat ${m.confidence || ""}`) : "";
  $("#fixReset").hidden = !(fx.bpm || fx.key);
  $("#bpmTarget").value = bpm ? (bpm * sp / 100).toFixed(1) : ""; $("#bpmTarget").disabled = !bpm;
  $("#bpmFrom").textContent = bpm ? `of ${bpm.toFixed(1)}` : "";
  const key0 = effKey();
  if (key0) {
    const k = st.semis ? shiftKey(key0, st.semis) : key0;
    $("#key").textContent = k; $("#keynote").textContent = `${CAMELOT[k] || ""}  ·  ${fx.key ? "set by you" : "certainty " + Math.round((m.keyConfidence || 0) * 100) + "%"}`;
    $("#keyResult").textContent = k; $("#keyResult").title = st.semis ? `${key0} → ${k}` : key0;   // the key it plays in now
    $("#keyResult").classList.toggle("moved", !!st.semis);
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
    + stat("BARS", m.downbeats ? m.downbeats.length : "—") + stat("BEATS", m.beats ? m.beats.length : "—")
    + (st.checks ? stat("TRUE PEAK", (st.checks.truePeakDb > -0.05 ? "⚠ " : "") + f(st.checks.truePeakDb, 1, " dBTP"))
      + stat("CLIPPING", st.checks.clipEvents ? `<a href="#" id="clipJump">⚠ ${st.checks.clipEvents} place${st.checks.clipEvents === 1 ? "" : "s"}</a>` : "none")
      + stat("STEREO", st.checks.correlation === null ? "mono" : `${st.checks.correlation >= 0 ? "+" : ""}${st.checks.correlation.toFixed(2)}${st.checks.correlation < 0.2 ? " ⚠" : ""}`) : "");
  const cj = $("#clipJump");
  if (cj) cj.onclick = e => { e.preventDefault(); const t = st.checks.clipTimes.find(x => x > st.pos + 0.5) ?? st.checks.clipTimes[0]; seek(Math.max(0, t - 1)); toast(`Clipping at ${fmtTime(t)}`); };
  $("#loudstats").innerHTML = l ? stat("INTEGRATED", f(l.integrated, 1, " LUFS")) + stat("SHORT-TERM MAX", f(l.shortTermMax, 1, " LUFS")) + stat("LOUDNESS RANGE", l.lra !== null ? f(l.lra, 1, " LU") : "—")
    + (st.checks ? stat("TRUE PEAK", f(st.checks.truePeakDb, 1, " dBTP")) : "") : "";
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
// The verse / chorus names were guesses from loudness and repetition, often wrong: the user
// rightly called them made up. Not shown anywhere (the analysis still runs for tempo and key).
const showSections = () => false;
function drawWave() {
  const dpr = sizeCanvas(wave); const w = wave.width / dpr, h = wave.height / dpr;
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.fillStyle = "#0E0D26"; wctx.fillRect(0, 0, w, h);
  if (!st.buffer) {
    wctx.fillStyle = "#9592BF"; wctx.font = "600 14px system-ui"; wctx.textAlign = "center";
    wctx.fillText(st.id ? (st.loadErr || "Loading…") : "Pick a song in your library", w / 2, h / 2);
    return;
  }
  const top = showSections() ? SECT_H + 4 : 16, bottom = h - RULER_H, mid = (top + bottom) / 2, amp = (bottom - top) / 2 - 2;
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
  // waveform in the color run, played part brighter
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
  // the user's markers: small colored flags along the top of the wave
  for (const mk of (lib.marks[st.id] || [])) {
    const x = xOf(mk.t, w); if (x < -6 || x > w + 6) continue;
    const c = mkColor(mk);
    wctx.globalAlpha = .5; wctx.fillStyle = c; wctx.fillRect(x - 0.5, top, 1, bottom - top); wctx.globalAlpha = 1;
    wctx.fillRect(x - 1, top, 2, 14); wctx.beginPath(); wctx.moveTo(x + 1, top); wctx.lineTo(x + 10, top + 3.5); wctx.lineTo(x + 1, top + 7); wctx.fill();
  }
  if (st.checks && st.checks.clipTimes) for (const t of st.checks.clipTimes) { const x = xOf(t, w); if (x >= 0 && x <= w) { wctx.fillStyle = "rgba(239,68,68,.8)"; wctx.fillRect(x - 1, bottom - 6, 2, 6); } }
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
  // a flag: show its time and note (the song keeps playing)
  if (y < SECT_H + 26) {
    const hit = (lib.marks[st.id] || []).map(m => [m, Math.abs(xOf(m.t, w) + 4 - x)]).filter(([, d]) => d < 14).sort((p, q) => p[1] - q[1])[0];
    if (hit) { fingers.delete(e.pointerId); showMarkPop(songMk, hit[0].id, r.top + 40); return; }
  }
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
  // gray out the formats the rules do not allow for this song
  for (const o of $("#fmt").querySelectorAll("option")) { const [k, n] = o.value.split("-"); o.disabled = !!st.buffer && !!saveReason("whole", { kind: k, n: +n }) && !saveReason(part, { kind: k, n: +n }).startsWith("Mark"); }
  const reason = saveReason(part, f);
  $("#saveBtn").disabled = !st.buffer || !!reason || !!saving;
  $("#saveName").textContent = st.buffer ? (reason || "Saves as  " + saveName(part, f)) : "";
}
function saveName(part, f) {
  const stem = st.name.replace(/\.[^.]+$/, ""); const tags = [];
  const clock = (t, up) => { const s = up ? Math.ceil(t - 1e-6) : Math.floor(t + 1e-6); return `${Math.floor(s / 60)}.${String(s % 60).padStart(2, "0")}`; };
  if (part !== "whole" && st.a !== null && st.b !== null) tags.push((part === "remove" ? "without " : "") + `${clock(st.a)}–${clock(st.b, true)}`);
  const bpm = effBpm();
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
  if ((playNow || !st.buffer) && ids.length) { playIndex(lib.queue.indexOf(ids[0])); showPage("music"); if (playNow) openNP("listen"); }
  else if (ids.length) toast(`Added ${lib.queue.length - before} to the queue`);
  renderList();
}
let view = ANDROID ? "phone" : "queue", listName = "";
let phoneIds = [], recordingIds = [], phoneState = ANDROID ? "loading" : "web";
function subLine(s) {
  // the format as a colored tag (WAV blue, MP3 pink …), then artist, length, size
  const f = fmtOf(s.name), kind = { WAV: "wav", MP3: "mp3", FLAC: "flac", M4A: "m4a", AAC: "m4a", MP4: "m4a", OGG: "ogg", OPUS: "ogg", AIFF: "aif", AIF: "aif", AIFC: "aif" }[f] || "other";
  const bits = [];
  if (s.artist && !/unknown/i.test(s.artist)) bits.push(esc(s.artist));
  if (s.duration) bits.push(fmtTime(s.duration));
  if (s.size > 0) bits.push((s.size / 1e6).toFixed(1) + " MB");
  return `<span class="ft ft-${kind}">${esc(f)}</span>` + bits.join(" · ");   // no folder: the user does not want "Download" anywhere
}
function emptyText() {
  if (view === "phone") return phoneState === "denied" ? "Allow AVB Player to see your music: tap All music again, then Allow."
    : phoneState === "loading" ? "Looking for music on your phone…" : "No music found on this phone.";
  if (view === "recordings") return "No recordings yet: tap ● Record on the Play page.";
  if (view === "queue") return ANDROID ? "Pick songs in All music, or + Open files." : "Open files to start.";
  if (view === "favorites") return "No favorites yet: tap ♡ on a song.";
  if (view === "recent") return "Nothing played yet.";
  return "Empty playlist. Use ⋯ on a song to add it.";
}
let groupBy = "artist", groupName = "";
function renderGroups(key, filter) {
  const groups = new Map();
  for (const id of phoneIds) { if (lib.hidden.includes(id) || !songs[id]) continue; const g = (songs[id][key] && !/^<unknown>$/i.test(songs[id][key])) ? songs[id][key] : "Unknown"; groups.set(g, (groups.get(g) || 0) + 1); }
  const rows = [...groups.entries()].filter(([g]) => g.toLowerCase().includes(filter)).sort((a, b) => a[0] === "Unknown" ? 1 : b[0] === "Unknown" ? -1 : a[0].localeCompare(b[0]));
  const el = $("#list");
  el.innerHTML = rows.map(([g, n]) => `<li class="grouprow" data-g="${encodeURIComponent(g)}"><div class="n"><div class="name">${g.replace(/</g, "&lt;")}</div><div class="sub">${n} song${n === 1 ? "" : "s"}</div></div></li>`).join("")
    || `<li class="muted">${phoneState === "ok" ? "Nothing here." : "Allow AVB Player to see your music first (All music)."}</li>`;
  el.querySelectorAll("li[data-g]").forEach(li => li.onclick = () => { groupBy = key; groupName = decodeURIComponent(li.dataset.g); openDrill("group", "", groupName); });
  $("#storage").textContent = `${rows.length} ${key === "artist" ? "artist" : "album"}${rows.length === 1 ? "" : "s"}`;
  $("#views").querySelectorAll(":scope > button").forEach(b => { b.classList.toggle("on", b.dataset.view === view); b.onclick = () => { view = b.dataset.view; listName = b.dataset.name || ""; if (view === "phone" && phoneState === "denied") loadPhone(true); renderList(); }; });
}
const HEART = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 20.3s-7.6-4.6-9.2-9.3C1.7 7.6 4 4.5 7.3 4.5c2 0 3.4 1.1 4.7 2.8 1.3-1.7 2.7-2.8 4.7-2.8 3.3 0 5.6 3.1 4.5 6.5-1.6 4.7-9.2 9.3-9.2 9.3z"/></svg>`;
// sorting the song list (remembered); "default" keeps each list's own order (newest added, last played, playlist order)
const FORMAT_ORDER = ["WAV", "AIFF", "AIF", "FLAC", "ALAC", "M4A", "MP3", "AAC", "OGG", "OPUS"];
const SORTS = {
  default: { label: "Default order", short: "Sort" },
  newest: { label: "Newest first", short: "Newest", cmp: (a, b) => (b.added || 0) - (a.added || 0) },
  oldest: { label: "Oldest first", short: "Oldest", cmp: (a, b) => (a.added || 0) - (b.added || 0) },
  az: { label: "Name A–Z", short: "A–Z", cmp: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) },
  za: { label: "Name Z–A", short: "Z–A", cmp: (a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" }) },
  largest: { label: "Largest first", short: "Largest", cmp: (a, b) => (b.size || 0) - (a.size || 0) },
  smallest: { label: "Smallest first", short: "Smallest", cmp: (a, b) => (a.size || 0) - (b.size || 0) },
  longest: { label: "Longest first", short: "Longest", cmp: (a, b) => (b.duration || 0) - (a.duration || 0) },
  format: { label: "Format: WAV, AIFF, FLAC, M4A, MP3…", short: "Format", cmp: (a, b) => {
    const r = f => { const i = FORMAT_ORDER.indexOf(fmtOf(f.name)); return i < 0 ? 99 : i; };
    return r(a) - r(b) || (b.added || 0) - (a.added || 0);
  } },
};
function sortIds(ids) {
  const s = SORTS[lib.sort];
  if (!s || !s.cmp) return ids;
  return ids.slice().sort((x, y) => s.cmp(songs[x], songs[y]));
}
$("#sortMusic").onclick = () => sheet(Object.entries(SORTS).map(([k, s]) => ({
  label: s.label + (lib.sort === k ? "  ✓" : ""), run: () => { lib.sort = k; save("sort"); renderList(); },
})), "Sort songs");
function renderList() {
  renderShelves();
  const filter = $("#filter").value.toLowerCase();
  if (view === "artists" || view === "albums") { renderGroups(view === "artists" ? "artist" : "album", filter); return; }
  let ids = view === "group" ? phoneIds.filter(x => !lib.hidden.includes(x) && (songs[x][groupBy] || "Unknown") === groupName)
    : view === "phone" ? phoneIds.filter(x => !lib.hidden.includes(x)) : view === "recordings" ? recordingIds : view === "queue" ? lib.queue : view === "favorites" ? lib.favorites
    : view === "added" ? Object.keys(songs).filter(id => !songs[id].url && !isRecording(id)).sort((a, b) => (songs[b].added || 0) - (songs[a].added || 0))
    : view === "recent" ? lib.recent : (lib.playlists.find(p => p.name === listName) || { items: [] }).items;
  ids = ids.filter(id => !isRecording(id) && !String(id).startsWith("r:"));
  ids = ids.filter(id => songs[id] && ((songs[id].name + " " + (songs[id].artist || "") + " " + (songs[id].album || "")).toLowerCase().includes(filter)));
  ids = sortIds(ids);
  $("#sortMusic").textContent = lib.sort === "default" ? "Sort" : SORTS[lib.sort].short + " ▾";
  const el = $("#list");
  el.innerHTML = ids.map((id, i) => { const s = songs[id]; return `<li data-id="${id}" class="${id === st.id ? "now" : ""}"><div class="nf"><div class="num">${i + 1}</div><button class="fav${lib.favorites.includes(id) ? " on" : ""}" title="Favorite">${HEART}</button></div><div class="n"><div class="name">${s.name.replace(/\.[^.]+$/, "")}</div><div class="sub">${subLine(s)}</div></div>${rowEnd(id, "music")}</li>`; }).join("")
    || `<li class="muted">${emptyText()}</li>`;
  shownIds.music = ids; el.style.setProperty("--numw", String(ids.length).length + "ch");
  el.querySelectorAll("li[data-id]").forEach(li => {
    li.querySelector(".n").onclick = () => { if (pickRow(li, "music")) return;
      const id = li.dataset.id;
      if (st.id === id && st.buffer) { if (!st.playing) play(); return; }        // the loaded song: carry on, never restart
      if (view === "queue") playIndex(lib.queue.indexOf(id), true); else { lib.queue = ids.slice(); save("queue"); playIndex(ids.indexOf(id), true); } };
    wireRow(li, "music");
    li.querySelector(".fav").onclick = e => { e.stopPropagation(); const on = !lib.favorites.includes(li.dataset.id); toggleFav(li.dataset.id); toast(on ? "Added to Favorites" : "Removed from Favorites"); };
  });
  el.classList.toggle("selecting", sel.where === "music"); updateSelbar();
  $("#listTabs").innerHTML = lib.playlists.map((p, i) => `<button data-pl="list" data-i="${i}" class="${view === "list" && listName === p.name ? "on" : ""}">${esc(p.name)}</button>`).join("") + `<button data-pl="new">＋ Playlist</button>`;
  $("#views").querySelectorAll(":scope > button").forEach(b => { b.classList.toggle("on", b.dataset.view === view && (view !== "list" || b.dataset.name === listName)); b.onclick = () => { selEnd(true); if (drill) { drill = null; document.body.classList.remove("drill"); $("#libName").textContent = "Library"; $("#libBack").hidden = true; } view = b.dataset.view; listName = b.dataset.name || ""; if (view === "phone" && phoneState === "denied") loadPhone(true); if (view === "recordings" && ANDROID) loadRecordings(); renderList(); }; });
  $("#listTabs").querySelectorAll("button").forEach(b => b.onclick = () => {
    if (b.dataset.pl === "new") return newPlaylist();
    const p = lib.playlists[+b.dataset.i]; if (p) { selEnd(true); view = "list"; listName = p.name; renderList(); }
  });
  if (ANDROID) $("#viewAdded").hidden = !Object.keys(songs).some(id => !songs[id].url && !isRecording(id));
  const n = ids.length;
  if (view === "phone") $("#storage").textContent = phoneState === "ok" ? `${n} song${n === 1 ? "" : "s"} on this phone` : "";
  else if (view === "added") $("#storage").textContent = `${n} song${n === 1 ? "" : "s"} opened with +, kept in the app`;
  else if (drill || view === "group") $("#storage").textContent = `${n} song${n === 1 ? "" : "s"}`;
  else if (view === "recordings") $("#storage").textContent = ANDROID ? `${n} recording${n === 1 ? "" : "s"} · saved in Recordings/AVB Music Player on your phone` : `${n} recording${n === 1 ? "" : "s"} · kept in the app`;
  else if (!ANDROID && navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => $("#storage").textContent = `${Object.keys(songs).length} songs stored in the app · ${(e.usage / 1e6).toFixed(0)} MB of ${(e.quota / 1e9).toFixed(1)} GB`);
  else $("#storage").textContent = "";
}
// ---------------------------------------------------------------- selecting many
// Long-press a song (or tap Select), tick more, then act on all of them from the bar.
const sel = { where: null, ids: new Set() };
const shownIds = { music: [], recs: [] };
let longAt = 0;
function rowEnd(id, where) {
  return sel.where === where ? `<span class="check">✓</span>` : `<button class="icon more" title="More">⋯</button>`;
}
function wireRow(li, where) {
  const id = li.dataset.id;
  li.classList.toggle("sel", sel.where === where && sel.ids.has(id));
  const more = li.querySelector(".more"); if (more) more.onclick = () => songMenu(id);
  const chk = li.querySelector(".check"); if (chk) chk.onclick = () => pickRow(li, where);
  let timer = null, x0 = 0, y0 = 0;
  li.addEventListener("contextmenu", e => e.preventDefault());
  li.addEventListener("pointerdown", e => {
    x0 = e.clientX; y0 = e.clientY;
    timer = setTimeout(() => { timer = null; longAt = Date.now(); if (navigator.vibrate) navigator.vibrate(15); selStart(where, id); }, 480);
  });
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  li.addEventListener("pointermove", e => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
  li.addEventListener("pointerup", stop); li.addEventListener("pointercancel", stop);
}
function pickRow(li, where) {
  if (Date.now() - longAt < 800) return true;                          // the click that ends a long-press
  if (sel.where !== where) return false;
  const id = li.dataset.id;
  if (sel.ids.has(id)) sel.ids.delete(id); else sel.ids.add(id);
  li.classList.toggle("sel", sel.ids.has(id));
  updateSelbar();
  return true;
}
function selStart(where, id) {
  if (sel.where !== where) { sel.where = where; sel.ids.clear(); }
  if (id) sel.ids.add(id);
  document.body.classList.add("selecting"); updateMini();
  where === "music" ? renderList() : renderRecList();
}
function selEnd(quiet) {
  if (!sel.where) return;
  const where = sel.where; sel.where = null; sel.ids.clear();
  document.body.classList.remove("selecting"); $("#selbar").hidden = true; updateMini();
  if (!quiet) where === "music" ? renderList() : renderRecList();
}
function updateSelbar() {
  const bar = $("#selbar");
  bar.hidden = !sel.where;
  $("#selMusic").textContent = sel.where === "music" ? "Done" : "Select";
  $("#selRecs").textContent = sel.where === "recs" ? "Done" : "Select";
  if (!sel.where) return;
  for (const id of [...sel.ids]) if (!songs[id]) sel.ids.delete(id);
  const n = sel.ids.size, all = shownIds[sel.where].length;
  $("#selCount").textContent = `${n} selected`;
  $("#selAll").textContent = n && n === all ? "None" : "All";
  $("#selDel").disabled = !n; $("#selMore").disabled = !n; $("#selRemove").disabled = !n;
  const webRecs = !ANDROID && sel.where === "recs";              // in the browser a recording lives only in the app
  $("#selRemove").hidden = webRecs;
  $("#selDel").textContent = ANDROID ? "Delete from phone" : "Delete";
}
$("#selMusic").onclick = () => sel.where === "music" ? selEnd() : selStart("music");
$("#selRecs").onclick = () => sel.where === "recs" ? selEnd() : selStart("recs");
$("#selClose").onclick = () => selEnd();
$("#selAll").onclick = () => {
  const ids = shownIds[sel.where] || [];
  if (sel.ids.size === ids.length) sel.ids.clear(); else ids.forEach(id => sel.ids.add(id));
  sel.where === "music" ? renderList() : renderRecList();
};
$("#selDel").onclick = () => deleteMany([...sel.ids]);
$("#selRemove").onclick = () => removeMany([...sel.ids]);
// "Remove from player": phone files are only hidden (they stay on the phone, Undo brings them back);
// a copy kept inside the app (opened with +) is let go, the original file is untouched
async function removeMany(ids) {
  ids = ids.filter(id => songs[id]); if (!ids.length) return;
  const n = ids.length, recs = ids.every(isRecording);
  const word = recs ? (n === 1 ? "recording" : "recordings") : (n === 1 ? "song" : "songs");
  const hiddenOnly = ids.every(id => songs[id].url);
  for (const id of ids) await removeFromApp(id, true);
  selEnd(true); renderList(); renderRecList();
  snack(`${n} ${word} removed from the player. The files are still on your phone.`, hiddenOnly ? "Undo" : "", () => {
    lib.hidden = lib.hidden.filter(x => !ids.includes(x)); save("hidden"); renderList(); renderRecList();
  });
}
$("#selMore").onclick = () => {
  const ids = [...sel.ids]; if (!ids.length) return;
  const n = ids.length, word = sel.where === "recs" ? (n === 1 ? "recording" : "recordings") : (n === 1 ? "song" : "songs");
  const allFav = ids.every(id => lib.favorites.includes(id));
  const items = [{ label: `Share ${n} ${word}`, run: () => shareMany(ids) }];
  if (n === 1) items.push({ label: "Rename", run: () => { selEnd(true); renameSong(ids[0]); } });
  if (sel.where === "music") {
    items.push({ label: allFav ? "Remove from favorites" : "Add to favorites", run: () => {
      if (allFav) lib.favorites = lib.favorites.filter(x => !ids.includes(x)); else lib.favorites = [...ids.filter(x => !lib.favorites.includes(x)), ...lib.favorites];
      save("favorites"); $("#heart").textContent = lib.favorites.includes(st.id) ? "♥" : "♡"; selEnd(); toast(allFav ? `${n} removed from favorites` : `${n} added to favorites`);
    } });
    for (const p of lib.playlists) items.push({ label: `Add to ${p.name}`, run: () => { for (const id of ids) if (!p.items.includes(id)) p.items.push(id); save("playlists"); selEnd(); toast(`${n} added to ${p.name}`); } });
    items.push({ label: `New playlist with these ${n}`, run: () => { selEnd(true); newPlaylist(ids); } });
    if (view === "queue") items.push({ label: "Remove from queue", run: () => {
      const cur = lib.queue[lib.index]; lib.queue = lib.queue.filter(x => !ids.includes(x)); lib.index = lib.queue.indexOf(cur);
      save("queue"); save("index"); selEnd();
    } });
    if (view === "list") items.push({ label: "Remove from this playlist", run: () => { const p = lib.playlists.find(p => p.name === listName); p.items = p.items.filter(x => !ids.includes(x)); save("playlists"); selEnd(); } });
  }
  sheet(items, `${n} ${word} selected`);
};
async function deleteMany(ids) {
  ids = ids.filter(id => songs[id]); if (!ids.length) return;
  const n = ids.length, recs = ids.every(isRecording);
  const word = recs ? (n === 1 ? "recording" : "recordings") : (n === 1 ? "song" : "songs");
  // what is on the phone: phone songs / recordings themselves, or the phone file behind an app copy
  const target = new Map(ids.map(id => [id, /^[mr]:/.test(id) ? id : phoneTwin(id)]));
  const onPhone = [...new Set([...target.values()].filter(Boolean))];
  const appOnly = ids.filter(id => !target.get(id));
  const names = ids.slice(0, 4).map(id => `“${songs[id].name}”`).join(", ") + (n > 4 ? ` and ${n - 4} more` : "");
  // one question only: Android's own when it will ask (files other apps made), else ours
  const androidAsks = ANDROID && onPhone.length && !phoneManaged();
  if (!androidAsks && !(await confirmBox(ANDROID && onPhone.length ? `Delete ${n} ${word} from your phone completely?` : `Delete ${n} ${word}?`,
      `${names} ${n === 1 ? "is" : "are"} erased${ANDROID && onPhone.length ? " from the phone itself, not only from this app" : ""}. This cannot be undone.`, "Delete", "Cancel"))) return;
  if (ANDROID && onPhone.length) {
    const token = ++deleteToken;
    const done = new Promise(r => deleteWaiters[token] = r);
    ANDROID.deletePhone(onPhone.map(x => x.slice(2)).join(","), token);
    if (!(await done)) { toast("Not deleted"); return; }
  }
  const gone = new Set([...ids, ...onPhone]);
  erasing = true;
  for (const x of gone) {
    if (songs[x] && !songs[x].url) await tx("songs", "readwrite", s2 => s2.delete(x));
    forget(x); delete songs[x];
  }
  erasing = false;
  phoneIds = phoneIds.filter(x => !gone.has(x)); recordingIds = recordingIds.filter(x => !gone.has(x));
  selEnd(true); renderList(); renderRecList();
  toast(`Deleted ${n} ${word}${ANDROID && onPhone.length ? " from your phone" : ""}`);
  if (androidAsks) offerManaged();
}
async function shareMany(ids) {
  if (ANDROID && ANDROID.shareMediaMany) {
    const media = [...new Set(ids.map(id => /^[mr]:/.test(id) ? id : phoneTwin(id)).filter(Boolean))];
    if (media.length < ids.length) toast(`${ids.length - media.length} of them ${ids.length - media.length === 1 ? "is" : "are"} not on the phone and ${ids.length - media.length === 1 ? "was" : "were"} left out`);
    if (media.length) ANDROID.shareMediaMany(media.map(x => x.slice(2)).join(","));
    selEnd(); return;
  }
  const files = [];
  for (const id of ids) { const rec = await songGet(id).catch(() => null); if (rec && rec.blob) files.push(new File([rec.blob], songs[id].name, { type: rec.blob.type || "audio/*" })); }
  if (files.length && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); } catch (err) { if (err && err.name !== "AbortError") toast("Sharing failed: " + err.message); }
  } else toast("This browser cannot share several files at once");
  selEnd();
}
// swipe a menu (or the marker editor) down to close it; a short drag springs back
function swipeToClose(el, close) {
  let y0 = 0, t0 = 0, dy = 0, dragging = false, startedAtTop = false;
  el.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; dragging = false;
    startedAtTop = el.scrollTop <= 0 && !e.target.closest("textarea");   // typing in a note never drags
  }, { passive: true });
  el.addEventListener("touchmove", e => {
    if (!startedAtTop) return;
    dy = e.touches[0].clientY - y0;
    if (!dragging && dy > 8) { dragging = true; el.style.transition = "none"; }
    if (!dragging) return;
    e.preventDefault();
    el.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  el.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false;
    const fast = dy / Math.max(1, performance.now() - t0) > 0.6;      // a flick
    el.style.transition = "transform .18s ease-out";
    if (dy > 80 || fast) {
      el.style.transform = "translateY(110%)";
      setTimeout(() => { el.style.transform = ""; el.style.transition = ""; close(); }, 180);
    } else { el.style.transform = ""; setTimeout(() => el.style.transition = "", 200); }
  });
}
swipeToClose($("#sheet"), () => $("#sheet").classList.remove("on"));
swipeToClose($("#mkEdit"), () => closeMarkEdit());
// a tap outside a menu closes it (and does nothing else)
$("#shade").addEventListener("click", e => { e.preventDefault(); $("#sheet").classList.remove("on"); });
function sheet(items, title) {
  const s = $("#sheet");
  s.innerHTML = (title ? `<div class="sheettitle">${title.replace(/</g, "&lt;")}</div>` : "") + items.map((it, i) => `<button class="${it.danger ? "danger" : ""}" data-i="${i}">${it.label}</button>`).join("") + `<button data-i="-1">Cancel</button>`;
  s.classList.add("on");
  s.querySelectorAll("button").forEach(b => b.onclick = () => { s.classList.remove("on"); const i = +b.dataset.i; if (i >= 0) items[i].run(); });
}
function songMenu(id) {
  const fav = lib.favorites.includes(id);
  const items = [
    { label: fav ? "Remove from favorites" : "Add to favorites", run: () => toggleFav(id) },
    ...lib.playlists.map(p => ({ label: `Add to ${p.name}`, run: () => { if (!p.items.includes(id)) p.items.push(id); save("playlists"); renderList(); } })),
    { label: "New playlist with this song", run: () => newPlaylist([id]) },
  ];
  if (view === "queue") items.push({ label: "Remove from queue", run: () => { const i = lib.queue.indexOf(id); if (i >= 0) { lib.queue.splice(i, 1); if (i < lib.index) lib.index--; else if (i === lib.index) lib.index = -1; } save("queue"); save("index"); renderList(); } });
  if (view === "list") items.push({ label: "Remove from this playlist", run: () => { const p = lib.playlists.find(p => p.name === listName); p.items = p.items.filter(x => x !== id); save("playlists"); renderList(); } });
  items.unshift({ label: "Share", run: () => shareSong(id) }, { label: "Rename", run: () => renameSong(id) });
  const rec = isRecording(id);
  const twin = phoneTwin(id);                         // the phone file behind an app copy, when it can be found
  if (!rec || (ANDROID && songs[id] && songs[id].url)) items.push({ label: "Remove from player (the file stays on your phone)", run: () => removeFromApp(id) });
  if (ANDROID && (id.startsWith("m:") || id.startsWith("r:") || twin))
    items.push({ label: rec ? "Delete this recording from the phone" : "Delete from phone completely", danger: true, run: () => deleteFromPhone(twin || id, id) });
  else if (rec) items.push({ label: "Delete this recording", danger: true, run: async () => {
    if (await confirmBox("Delete this recording?", `“${songs[id].name}” is erased. This cannot be undone.`, "Delete")) { erasing = true; await removeFromApp(id, true); erasing = false; }
  } });
  const s0 = songs[id];
  sheet(items, s0 ? s0.name.replace(/\.[^.]+$/, "") : "");
}
// rename a song or recording: a phone file is renamed on the phone itself (Android may ask first
// for files other apps made); a copy kept in the app is renamed in the app; the extension stays
const renameWaiters = {};
let renameToken = 0;
window.avbRenamed = (token, name) => { const f = renameWaiters[token]; delete renameWaiters[token]; if (f) f(name || ""); };
async function renameSong(id) {
  const s0 = songs[id]; if (!s0) return;
  const ext = (s0.name.match(/\.[^.]+$/) || [""])[0], stem = s0.name.slice(0, s0.name.length - ext.length);
  let v = await ask(isRecording(id) ? "Rename recording" : "Rename song", "", stem, "Rename");
  if (v == null) return;
  v = v.replace(/[\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (!v || v === stem) return;
  let name = v + ext;
  if (/^[mr]:/.test(id) && ANDROID) {
    if (!ANDROID.renamePhone) { toast("Update AVB Player to rename files on the phone"); return; }
    const token = ++renameToken;
    const done = new Promise(r => renameWaiters[token] = r);
    ANDROID.renamePhone(id.slice(2), name, token);
    name = await done;
    if (!name) { toast("Not renamed"); return; }
  } else {
    await tx("songs", "readwrite", store => { const g = store.get(id); g.onsuccess = () => { if (g.result) { g.result.name = name; store.put(g.result); } }; return g; });
  }
  s0.name = name;
  lib.renamed[id] = true; save("renamed");
  if (st.id === id) { st.name = name; $("#title").textContent = name.replace(/\.[^.]+$/, ""); updateMini(); }
  renderList(); renderRecList();
  toast(`Renamed to “${name.replace(/\.[^.]+$/, "")}”`);
}
// an app copy (opened through + Open files / Share) and the same file in All music: same name and size
function phoneTwin(id) {
  const s0 = songs[id]; if (!s0 || s0.url) return null;
  return phoneIds.find(m => songs[m] && songs[m].name === s0.name && songs[m].size === s0.size) || null;
}
function forget(id) {
  lib.queue = lib.queue.filter(x => x !== id); lib.favorites = lib.favorites.filter(x => x !== id); lib.recent = lib.recent.filter(x => x !== id);
  lib.playlists.forEach(p => p.items = p.items.filter(x => x !== id)); delete lib.notes[id]; delete lib.lyrics[id]; if (lib.renamed[id]) { delete lib.renamed[id]; save("renamed"); }
  if (erasing && lib.marks[id]) { delete lib.marks[id]; save("marks"); }      // kept when only removed from the app
  if (erasing) {                                    // deleted for good: its tapped tempo / key and "removed" mark go too
    if (lib.fix[id]) { delete lib.fix[id]; save("fix"); }
    if (lib.hidden.includes(id)) { lib.hidden = lib.hidden.filter(x => x !== id); save("hidden"); }
  }
  lib.index = st.id && lib.queue.includes(st.id) ? lib.queue.indexOf(st.id) : -1;
  for (const k of ["queue", "index", "favorites", "recent", "playlists", "notes", "lyrics"]) save(k);
  if (st.id === id) { pause(); send({ cmd: "unload" }); st.buffer = null; st.id = null; st.peaks = null; mediaReport(); $("#title").textContent = "No song loaded"; $("#badges").innerHTML = ""; drawWave(); closeNP(); }
}
async function removeFromApp(id, quiet) {
  if (!songs[id]) return;
  if (songs[id].url) { if (!lib.hidden.includes(id)) lib.hidden.push(id); save("hidden"); }     // a phone song: hidden from All music
  else { await tx("songs", "readwrite", s2 => s2.delete(id)); delete songs[id]; recordingIds = recordingIds.filter(x => x !== id); }
  forget(id);
  renderList(); renderRecList();
  if (!quiet) toast("Removed from AVB Player. The file is still on your phone.");
}
let erasing = false;      // forget() inside a delete: the markers go as well
// "Media management" (Android 12+): once the user turns it on, Android deletes and renames without its question
const phoneManaged = () => { try { return !!(ANDROID && ANDROID.canManageMedia && ANDROID.canManageMedia()); } catch (_) { return false; } };
const canAskManaged = () => !!(ANDROID && ANDROID.askManageMedia) && !phoneManaged();
function offerManaged() {
  if (!canAskManaged() || lib.mmOffered) return;          // offered once; it stays in Settings
  lib.mmOffered = true; save("mmOffered");
  setTimeout(() => snack("Skip Android's question when you delete or rename?", "Turn on", () => ANDROID.askManageMedia()), 1200);
}
// deleting a file from the phone: our question first, then Android's own confirmation
const deleteWaiters = {};
let deleteToken = 0;
window.avbDeleted = (token, ok) => { const f = deleteWaiters[token]; delete deleteWaiters[token]; if (f) f(!!ok); };
async function deleteFromPhone(phoneId, shownId) {
  const s0 = songs[shownId] || songs[phoneId];
  const androidAsks = !phoneManaged();                  // Android shows its own question: ours is skipped
  if (!androidAsks && !(await confirmBox(isRecording(shownId) ? "Delete this recording from your phone?" : "Delete from your phone completely?",
      `“${s0.name}” is erased from the phone itself, not only from this app. This cannot be undone.`, "Delete", "Cancel"))) return;
  const token = ++deleteToken;
  const done = new Promise(r => deleteWaiters[token] = r);
  ANDROID.deletePhone(phoneId.slice(2), token);
  if (!(await done)) { toast("Not deleted"); return; }
  erasing = true;
  for (const x of new Set([phoneId, shownId])) {
    if (songs[x] && !songs[x].url) await tx("songs", "readwrite", s2 => s2.delete(x));
    forget(x); delete songs[x];
  }
  erasing = false;
  phoneIds = phoneIds.filter(x => x !== phoneId && x !== shownId); recordingIds = recordingIds.filter(x => x !== phoneId && x !== shownId);
  renderList(); renderRecList();
  toast(`Deleted “${s0.name}” from your phone`);
  if (androidAsks) offerManaged();
}
function toggleFav(id) { if (!id) return; const i = lib.favorites.indexOf(id); if (i >= 0) lib.favorites.splice(i, 1); else lib.favorites.unshift(id); save("favorites"); if (id === st.id) $("#hHeart").classList.toggle("on", lib.favorites.includes(id)); $("#heart").textContent = lib.favorites.includes(st.id) ? "♥" : "♡"; renderList(); }
function newPlaylist(items = []) {
  ask("New playlist", "", `Playlist ${lib.playlists.length + 1}`, "Create").then(name => { if (!name) return; newPlaylistNamed(name, items); });
}
function newPlaylistNamed(name, items) {
  lib.playlists.push({ name: name.trim(), items: items.slice() }); save("playlists"); selEnd(true); view = "list"; listName = name.trim(); renderList();
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
    const body = raw.replace(/\[[^\]]*\]/g, "");
    // word times: "<00:12.34>word" (enhanced LRC)
    const wt = [...body.matchAll(/<(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)>\s*([^<]*)/g)].map(m => ({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), w: m[3].trim() })).filter(x => x.w);
    const words = body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (tags.length) {
      timed = true;
      for (const t of tags) lines.push({ t: +t[1] * 60 + parseFloat(t[2].replace(":", ".")), text: words, wt: wt.length ? wt : null });
    } else if (!/^\[(ar|ti|al|by|offset|length|re|ve):/i.test(raw)) lines.push({ t: null, text: words });
  }
  if (timed) lines.sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
  return { lines, timed };
}
var lyrShownFor = null;            // the song the lyrics box shows (a new song starts with the box closed)
function showLyrics(text, source, id) {
  lyr = { id, text: text || "", source, ...parseLrc(text || "") };
  const el = $("#lyrics");
  if (!lyr.text.trim()) {
    el.innerHTML = `<div class="empty">${source === "searching" ? "Looking for lyrics…" : "No lyrics found."}</div>`;
  } else {
    el.innerHTML = lyr.lines.map((l, i) => l.text ? `<div class="l" data-i="${i}">${l.text.split(" ").map(w => `<span class="w">${w.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join(" ")}</div>` : `<div class="l gap"></div>`).join("");
    lyr.wordTimes = lyricWordTimes();
    if (lyr.timed) el.querySelectorAll(".l[data-i]").forEach(d => d.onclick = () => { const t = lyr.lines[+d.dataset.i].t; if (t != null) seek(t); });
  }
  const none = !lyr.text.trim();
  if (id !== lyrShownFor) { lyrShownFor = id; document.body.classList.remove("lyrforce"); }   // a new song starts with the chip
  $("#tab-lyrics").classList.toggle("nolyr", none);                // no lyrics: one slim line
  document.body.classList.toggle("nolyrics", none);                // home: a Lyrics chip instead of a bar
  if (!none) document.body.classList.remove("lyrforce");
  $("#lyrSource").textContent = none ? (source === "searching" ? "Looking…" : "No lyrics found") : "";      // where they came from is not shown
  $("#lyrSync").hidden = !lyr.text.trim() || lyr.timed;            // no times yet: tap along once to time them
  $("#lyrCopy").disabled = !lyr.text.trim();
}
function tagTitleArtist(name) {
  // "Artist - Title.mp3" -> both; otherwise the title only
  const stem = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = stem.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1], title: m[2] } : { artist: "", title: stem };
}
async function findLyrics(id, rec, preTags) {
  // every step is noted, so a tap on "No lyrics found" can say what was tried
  const why = [];
  showLyrics("", "searching", id);
  if (lib.lyrics[id]) { showLyrics(lib.lyrics[id], "mine", id); openLyricsTab(); return; }
  let tags = {};
  if (preTags) tags = preTags; else try { tags = await readTags(rec.blob, rec.name); } catch (err) { why.push("Could not read the file's tags: " + (err && err.message || err)); }
  if (st.id !== id) return;
  // file lyrics with times: done; without times: shown now, but a timed version is looked for online
  let filePlain = null;
  if (tags.lyrics && tags.lyrics.trim()) {
    const text = tags.lyrics.replace(/(\\r)?\\n/g, "\n");                 // some tools write line breaks as the text \n
    showLyrics(text, "file", id); openLyricsTab();
    if (parseLrc(text).timed) return;
    filePlain = text;
  } else why.push(`Inside the file (${fmtOf(rec.name)}): no lyrics.`);
  const guess = tagTitleArtist(rec.name);
  const unknown = a => !a || /^<?unknown>?$/i.test(a.trim());
  const title = tags.title || songs[id]?.title || guess.title;
  const artistRaw = tags.artist || songs[id]?.artist || guess.artist, artist = unknown(artistRaw) ? "" : artistRaw;
  const done = () => { if (st.id === id && !filePlain) { showLyrics("", "none", id); lyr.why = why; } };
  if (isRecording(id)) { why.push("Recordings are not looked up online."); return done(); }
  if (!navigator.onLine) { why.push("Online search skipped: the phone is offline."); return done(); }
  if (!title) { why.push("Online search skipped: the song has no title."); return done(); }
  const dur0 = songs[id]?.duration || st.duration || 0;
  if (dur0 && dur0 < 30) { why.push("Online search skipped: shorter than 30 seconds."); return done(); }
  try {
    const q = new URLSearchParams({ track_name: title });
    if (artist) q.set("artist_name", artist);
    let r = await fetch("https://lrclib.net/api/get?" + q, { headers: { "Accept": "application/json" } });
    // only lyrics for a song of the same length: a name alone matches the wrong songs
    const dur = () => (st.id === id && st.duration) || songs[id]?.duration || 0;
    const fits = x => x && (x.syncedLyrics || x.plainLyrics) && (!dur() || !x.duration || Math.abs(x.duration - dur()) <= 4);
    let d = r.ok ? await r.json() : null;
    let seen = d && (d.syncedLyrics || d.plainLyrics) ? 1 : 0;
    if (!fits(d) || !d.syncedLyrics) {
      // a timed version of the same length beats an untimed one
      r = await fetch("https://lrclib.net/api/search?" + new URLSearchParams({ q: `${artist} ${title}`.trim() }));
      const list = (r.ok ? await r.json() : null) || [];
      seen += list.filter(x => x.syncedLyrics || x.plainLyrics).length;
      d = list.find(x => fits(x) && x.syncedLyrics) || (fits(d) ? d : null) || list.find(fits) || null;
    }
    if (st.id !== id) return;
    if (d && d.syncedLyrics) { showLyrics(d.syncedLyrics, "lrclib", id); openLyricsTab(); return; }
    if (filePlain) return;                                               // no timed version online: the file's own stay
    if (d && d.plainLyrics) { showLyrics(d.plainLyrics, "lrclib", id); openLyricsTab(); return; }
    why.push(`Online (LRCLIB) for “${title}”${artist ? " by " + artist : ""}: ` + (seen ? `${seen} result${seen === 1 ? "" : "s"}, none the same length as this song (${fmtTime(dur())}).` : "nothing found."));
  } catch (err) { why.push("Online search failed: " + (err && err.message || err)); }
  done();
}
function openLyricsTab() { /* lyrics live under the controls in Now Playing → Listen */ }
let syncing = null;
function syncStart() {
  if (!st.buffer || !lyr.text.trim()) return;
  const idx = lyr.lines.map((l, i) => l.text ? i : -1).filter(i => i >= 0);
  if (!idx.length) return;
  syncing = { idx, n: 0, times: [] };
  $("#lyrSyncBar").hidden = false; $("#lyrSync").hidden = true;
  seek(0); if (!st.playing) play();
  syncShow();
}
function syncShow() {
  const s = syncing; if (!s) return;
  $("#lyrics").querySelectorAll(".l").forEach(d => d.classList.remove("now", "next", "past"));
  const i = s.idx[s.n];
  const el = i != null && $("#lyrics").querySelector(`.l[data-i="${i}"]`);
  if (el) { el.classList.add("next"); const box = $("#lyrics"); box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 3; }
  $("#syncInfo").textContent = s.n < s.idx.length ? `Line ${s.n + 1} of ${s.idx.length}: tap Next line when it starts` : "All lines timed: tap Save";
  $("#syncNext").disabled = s.n >= s.idx.length; $("#syncUndo").disabled = !s.n;
}
function syncEnd(saveIt) {
  const s = syncing; syncing = null;
  $("#lyrSyncBar").hidden = true;
  if (!s) return;
  if (saveIt && s.times.length) {
    const lrc = lyr.lines.map((l, i) => { const k = s.idx.indexOf(i); return k >= 0 && s.times[k] != null ? `[${lrcTime(s.times[k])}]${l.text}` : l.text; }).join("\n");
    lib.lyrics[st.id] = lrc; save("lyrics"); showLyrics(lrc, "mine", st.id); toast("Lyrics timed: the words now light up as they are sung");
  } else showLyrics(lyr.text, lyr.source, st.id);
}
const lrcTime = t => `${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(2).padStart(5, "0")}`;
$("#lyrSync").onclick = syncStart;
$("#lyrSource").onclick = () => { if ($("#tab-lyrics").classList.contains("nolyr") && lyr.why && lyr.why.length) confirmBox("Why no lyrics", lyr.why.join("\n") + "\n\nTap Edit to paste them; they stay with the song.", "OK", ""); };
$("#syncNext").onclick = () => { const s = syncing; if (!s || s.n >= s.idx.length) return; s.times[s.n] = Math.max(0, st.pos - 0.1); s.n++; syncShow(); };
$("#syncUndo").onclick = () => { const s = syncing; if (!s || !s.n) return; s.n--; s.times.length = s.n; seek(Math.max(0, (s.times[s.n - 1] ?? 0))); syncShow(); };
$("#syncSave").onclick = () => syncEnd(true);
$("#syncCancel").onclick = () => syncEnd(false);
// fold the lyrics down to their one-line header (remembered), tap again to open them
const setLyrFold = () => $("#tab-lyrics").classList.toggle("folded", !!lib.lyrFold);
$("#lyrFold").onclick = $("#lyrTitle").onclick = () => { if (syncing) return; lib.lyrFold = !lib.lyrFold; save("lyrFold"); setLyrFold(); };
setLyrFold();
// drag the handle under the lyrics to make the box taller or shorter
(function lyricsHandle() {
  const h = $("#lyrHandle"), box = $("#lyrics");
  box.style.setProperty("--lyrh", lib.lyrH + "px");
  let y0 = 0, h0 = 0, on = false;
  h.addEventListener("pointerdown", e => { on = true; y0 = e.clientY; h0 = box.getBoundingClientRect().height; try { h.setPointerCapture(e.pointerId); } catch (_) { } e.preventDefault(); });
  h.addEventListener("pointermove", e => { if (!on) return; const v = Math.max(120, Math.min(window.innerHeight * 1.5, h0 + e.clientY - y0)); box.style.setProperty("--lyrh", v + "px"); lib.lyrH = Math.round(v); });
  const up = () => { if (!on) return; on = false; save("lyrH"); };
  h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
  h.addEventListener("dblclick", () => { lib.lyrH = lib.lyrH > 600 ? 300 : 2000; box.style.setProperty("--lyrh", lib.lyrH + "px"); save("lyrH"); });
})();
function lyricsTick(t) {
  const seen = !$("#homeLyrics").hidden || (!$("#np").hidden && npMode === "listen");   // home screen or Listen
  if (!lyr.timed || !seen || syncing) return;
  let k = -1;
  for (let i = 0; i < lyr.lines.length; i++) if (lyr.lines[i].t != null && lyr.lines[i].t <= t + 0.15) k = i;
  if (k !== lyr.now) {
    lyr.now = k;
    $("#lyrics").querySelectorAll(".l.now").forEach(d => { d.classList.remove("now"); d.querySelectorAll(".w.sung").forEach(w => w.classList.remove("sung")); });
    // lines already sung stay lit (a jump back un-lights the ones after it)
    $("#lyrics").querySelectorAll(".l[data-i]").forEach(d => d.classList.toggle("past", +d.dataset.i < k));
    const cur = $("#lyrics").querySelector(`.l[data-i="${k}"]`);
    if (cur) { cur.classList.add("now"); const box = $("#lyrics"); box.scrollTop = cur.offsetTop - box.offsetTop - box.clientHeight / 3; }
  }
  // the words of the current line turn orange as they are sung
  const times = lyr.wordTimes && lyr.wordTimes[k], cur = k >= 0 && $("#lyrics").querySelector(`.l[data-i="${k}"]`);
  if (times && cur) cur.querySelectorAll(".w").forEach((w, j) => w.classList.toggle("sung", times[j] != null && times[j] <= t + 0.05));
}
// when each word starts: the lyrics' own word times, or the line's words spread over the
// time to the next line (by their length, at most ~0.45 s a syllable-ish character group)
function lyricWordTimes() {
  if (!lyr.timed) return null;
  return lyr.lines.map((l, i) => {
    if (!l.text || l.t == null) return null;
    const words = l.text.split(" ");
    if (l.wt && l.wt.length === words.length) return l.wt.map(x => x.t);
    const next = lyr.lines.slice(i + 1).find(x => x.t != null);
    const span = Math.max(0.6, Math.min((next ? next.t : l.t + 6) - l.t, 0.32 * l.text.length + 0.8) * 0.92);
    const total = words.reduce((a, w) => a + w.length + 1, 0);
    let acc = 0;
    return words.map(w => { const at = l.t + span * acc / total; acc += w.length + 1; return at; });
  });
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

// ---- cover art: the picture inside the file, else the phone's album art, else the generated one
let coverUrl = null;
async function showCover(id, tags) {
  const el = $("#cover");
  if (coverUrl) { URL.revokeObjectURL(coverUrl); coverUrl = null; }
  let blob = tags && tags.picture && tags.picture.size > 100 ? tags.picture : null;
  if (!blob && ANDROID && ANDROID.albumArt && /^[mr]:/.test(id)) {
    const b64 = ANDROID.albumArt(id.slice(2));
    if (b64) blob = await (await fetch("data:image/jpeg;base64," + b64)).blob();
  }
  if (st.id !== id) return;
  if (blob && blob === (tags && tags.picture) && ANDROID && ANDROID.mediaArt && blob.size < 4e6) {
    const fr = new FileReader(); fr.onload = () => { if (st.id === id) ANDROID.mediaArt(id, String(fr.result).split(",")[1] || ""); }; fr.readAsDataURL(blob);
  }
  if (blob) { coverUrl = URL.createObjectURL(blob); el.style.background = `center / cover no-repeat url("${coverUrl}")`; el.classList.add("art"); }
  else { el.style.background = coverFor(songs[id] ? songs[id].name : ""); el.classList.remove("art"); }
}
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
    if (fid === "APIC" && !out.picture) { let k = 1; while (k < body.length && body[k]) k++; const mime = dec(body.subarray(1, k), 0); k += 2; k = afterTerm(body, k); out.picture = new Blob([body.slice(k)], { type: mime || "image/jpeg" }); }
    if (fid === "USLT") { const k = afterTerm(body, 4); out.lyrics = dec(body.subarray(k), enc).replace(/\0+$/, ""); }
    else if (fid === "TIT2") out.title = dec(body.subarray(1), enc).replace(/\0+$/, "");
    else if (fid === "TPE1") out.artist = dec(body.subarray(1), enc).replace(/\0+$/, "");
    else if (fid === "TXXX") { const k = afterTerm(body, 1); const key = dec(body.subarray(1, k - zero), enc).toUpperCase(); if (/LYRIC|USLT|SYLT/.test(key) && !out.lyrics) out.lyrics = dec(body.subarray(k), enc).replace(/\0+$/, ""); }
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
    if (/LYRIC|USLT/.test(k) && !out.lyrics) out.lyrics = v;          // LYRICS, UNSYNCEDLYRICS, UNSYNCED LYRICS, USLT …
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
    let p = 4, flacTags = {};
    while (p + 4 < head.length) {
      const last = head[p] & 0x80, type = head[p] & 0x7f, len = (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3];
      if (type === 4) flacTags = { ...flacTags, ...vorbis(head, p + 4) };
      if (type === 6 && !flacTags.picture) {                                  // PICTURE block
        const dv2 = new DataView(head.buffer, p + 4); let q = 4; const ml = dv2.getUint32(q); const mime = new TextDecoder().decode(head.subarray(p + 4 + q + 4, p + 4 + q + 4 + ml)); q += 4 + ml;
        const dl = dv2.getUint32(q); q += 4 + dl + 16; const plen = dv2.getUint32(q); q += 4;
        flacTags.picture = new Blob([head.slice(p + 4 + q, p + 4 + q + plen)], { type: mime || "image/jpeg" });
      }
      p += 4 + len; if (last) break;
    }
    return flacTags;
  }
  if (f === "WAV" || f === "AIFF" || f === "AIF" || f === "AIFC") {                                       // an "id3 " chunk inside the file
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
    i = find([0x63, 0x6F, 0x76, 0x72]);                                              // covr
    if (i >= 0 && String.fromCharCode(...head.subarray(i + 8, i + 12)) === "data") { const len = new DataView(head.buffer).getUint32(i + 4); out.picture = new Blob([head.slice(i + 20, i + 4 + len)], { type: "image/jpeg" }); }
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
  if (outStage) for (const n of Object.values(outStage)) try { n.disconnect(); } catch (_) { }
  eqNodes = lib.eq.bands.map(b => { const n = ctx.createBiquadFilter(); setBiquad(n, b, ctx); return n; });
  eqOut = ctx.createGain();
  eqAnalyser = eqAnalyser || ctx.createAnalyser(); eqAnalyser.fftSize = 4096; eqAnalyser.smoothingTimeConstant = 0.8;
  let last = node;
  if (lib.eq.on) for (const n of eqNodes) { last.connect(n); last = n; }
  last.connect(eqOut); eqOut.gain.value = lib.eq.on ? Math.pow(10, lib.eq.out / 20) : 1;
  buildOutputStage();
}
// after the EQ: mono check (both speakers get (L+R)/2) and balance, then the speakers
let outStage = null;
function buildOutputStage() {
  if (outStage) for (const n of Object.values(outStage)) try { n.disconnect(); } catch (_) { }
  try { eqOut.disconnect(); } catch (_) { }
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2), gL = ctx.createGain(), gR = ctx.createGain();
  const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = "explicit"; mono.channelInterpretation = "speakers";
  if (lib.mono) { eqOut.connect(mono); mono.connect(gL); mono.connect(gR); }
  else { eqOut.connect(split); split.connect(gL, 0); split.connect(gR, 1); }
  gL.connect(merge, 0, 0); gR.connect(merge, 0, 1);
  merge.connect(ctx.destination); merge.connect(eqAnalyser);
  outStage = { split, merge, gL, gR, mono };
  setBalance();
}
function setBalance() {
  if (!outStage) return;
  const p = (lib.balance || 0) / 100;
  outStage.gL.gain.setTargetAtTime(p > 0 ? 1 - p : 1, ctx.currentTime, 0.01);
  outStage.gR.gain.setTargetAtTime(p < 0 ? 1 + p : 1, ctx.currentTime, 0.01);
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
  // the drawn line, kept faintly after the fit to compare with
  if (eqGhost && !eqStroke) {
    c.setLineDash([5, 5]); c.strokeStyle = "rgba(255,255,255,.55)"; c.lineWidth = 1.6; c.beginPath();
    eqGhost.forEach((p, i) => { const xx = eqX(p.f, w), yy = y(p.g); i ? c.lineTo(xx, yy) : c.moveTo(xx, yy); }); c.stroke(); c.setLineDash([]);
  }
  // the line being drawn
  if (eqStroke && eqStroke.length > 1) {
    c.strokeStyle = "#fff"; c.lineWidth = 3; c.lineJoin = c.lineCap = "round"; c.shadowColor = "#FF8A1E"; c.shadowBlur = 8;
    c.beginPath(); eqStroke.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.stroke(); c.shadowBlur = 0;
  }
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
// what the selected band does, in plain words, while it moves
function eqDescribe(b) {
  const hz = fmtHz(b.f);
  if (!b.on && (b.type === "highpass" || b.type === "lowpass")) return `${b.label} is off. Turn it on to ${b.type === "highpass" ? "remove rumble below a frequency" : "soften everything above a frequency"}.`;
  if (b.type === "highpass") return `Removing everything below ${hz}: ${b.f < 60 ? "rumble and handling noise go, the music stays" : b.f < 150 ? "rumble goes and the bass gets lighter" : "the bass thins out: sounds smaller, like a radio"}.`;
  if (b.type === "lowpass") return `Removing everything above ${hz}: ${b.f > 14000 ? "hiss softens, barely changes the music" : b.f > 6000 ? "darker and softer, less sparkle" : "muffled, like through a wall"}.`;
  const g = b.g, f = b.f;
  if (!b.on || Math.abs(g) < 0.2) return `${b.label} at ${hz}: no change. Drag up to boost, down to cut.`;
  const up = g > 0, amt = `${up ? "+" : ""}${g.toFixed(1)} dB`;
  const region = f < 60 ? ["sub-bass: the rumble you feel", "more weight and rumble; too much sounds boomy", "less rumble, tighter low end"]
    : f < 250 ? ["bass: kick drum and bass guitar", "warmer, punchier low end; too much sounds boomy", "leaner, less boom"]
    : f < 500 ? ["low mids: body of voices and guitars", "fuller body; too much sounds muddy", "clears mud, cleaner mix"]
    : f < 2000 ? ["mids: the core of most instruments", "more presence of the core sound; too much sounds boxy or honky", "less boxy, more open"]
    : f < 5000 ? ["upper mids: vocal clarity and bite", "vocals and leads come forward and cut through; too much sounds harsh", "smoother, less harsh, vocals sit back"]
    : f < 10000 ? ["brilliance: crisp detail, the 's' of singing", "crisper and brighter; too much sounds sharp on 's'", "softer, less sibilance"]
    : ["air: sparkle and openness", "airier, more sparkle; too much adds hiss", "darker, smoother top"];
  const eff = up ? region[1] : region[2];
  return `${up ? "Boosting" : "Cutting"} ${hz} (${amt}), the ${region[0].replace(":", " ·")}. ${eff[0].toUpperCase() + eff.slice(1)}.`;
}
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
  $("#eqHint").textContent = lib.eq.on ? eqDescribe(b) : "EQ is off: the song plays as it is.";
}
function eqWire() {
  const band = () => lib.eq.bands[eqSel];
  $("#eqOn").onchange = e => { lib.eq.on = e.target.checked; eqChanged(true); };
  $("#eqBandOn").onchange = e => { band().on = e.target.checked; eqChanged(true); };
  $("#eqF").oninput = e => { band().f = EQ_MIN * Math.pow(EQ_MAX / EQ_MIN, +e.target.value / 1000); eqChanged(false); };
  $("#eqG").oninput = e => { const b = band(); const was = eqBandActive(b); b.g = +e.target.value / 10; if (Math.abs(b.g) < 0.15) b.g = 0; eqChanged(was !== eqBandActive(b)); };
  $("#eqQ").oninput = e => { band().q = 0.2 * Math.pow(15 / 0.2, +e.target.value / 1000); eqChanged(false); };
  $("#eqOut").oninput = e => { lib.eq.out = +e.target.value / 10; eqChanged(false); };
  $("#eqFlat").onclick = () => {                     // Reset: bands, output and balance back to neutral
    lib.eq = EQ_DEFAULT(); eqGhost = null; eqChanged(true);
    lib.balance = 0; save("balance"); $("#balance").value = 0; $("#balanceV").textContent = "Center"; setBalance();
    toast("EQ reset");
  };
  $("#eqPreset").onchange = e => {
    const p = EQ_PRESETS[e.target.value]; e.target.value = ""; if (!p) return;
    lib.eq = EQ_DEFAULT();
    for (const [i, v] of p) Object.assign(lib.eq.bands[i], v);
    eqChanged(true);
  };
  // draw mode: trace a line with the finger, the bands follow it
  $("#eqDraw").onclick = () => { eqDrawMode = !eqDrawMode; $("#eqDraw").classList.toggle("on", eqDrawMode); if (eqDrawMode) toast("Draw a line across the curve: left is bass, right is treble"); };
  // drag the dots on the curve
  const cv = $("#eqCurve"); let dragging = null;
  cv.addEventListener("pointerdown", e => {
    if (eqDrawMode) {
      const r = cv.getBoundingClientRect(); eqStroke = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
      try { cv.setPointerCapture(e.pointerId); } catch (_) { } return;
    }
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, yy = e.clientY - r.top, w = r.width, h = r.height;
    const y = db => h / 2 - db / EQ_DB * (h / 2 - 14);
    let best = -1, bd = 1e9;
    lib.eq.bands.forEach((b, i) => { const cut = b.type === "highpass" || b.type === "lowpass"; const d = Math.hypot(eqX(b.f, w) - x, y(cut ? 0 : b.g) - yy); if (d < bd) { bd = d; best = i; } });
    if (best < 0 || bd > 40) return;
    eqSel = best; dragging = { w, h }; eqGhost = null; try { cv.setPointerCapture(e.pointerId); } catch (_) { }
    if (!lib.eq.bands[best].on) { lib.eq.bands[best].on = true; eqChanged(true); } else { fillEqEdit(); drawEq(); }
  });
  cv.addEventListener("pointermove", e => {
    if (eqStroke) { const r = cv.getBoundingClientRect(); eqStroke.push({ x: e.clientX - r.left, y: e.clientY - r.top }); drawEq(); return; }
    if (!dragging) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, yy = e.clientY - r.top, { w, h } = dragging;
    const b = lib.eq.bands[eqSel]; const was = eqBandActive(b);
    b.f = Math.round(eqF(x, w));
    if (!(b.type === "highpass" || b.type === "lowpass")) { b.g = Math.max(-EQ_DB, Math.min(EQ_DB, (h / 2 - yy) / (h / 2 - 14) * EQ_DB)); b.g = Math.round(b.g * 10) / 10; if (Math.abs(b.g) < 0.2) b.g = 0; }
    eqChanged(was !== eqBandActive(b));
  });
  const up = () => {
    dragging = null;
    if (eqStroke) { const r = cv.getBoundingClientRect(); const pts = eqStroke; eqStroke = null; if (pts.length > 3) fitEqToLine(pts, r.width, r.height); else drawEq(); }
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
}
var eqDrawMode = false, eqStroke = null;
// fit the six tone bands (low shelf, four bells, air shelf) to the drawn line: the same
// biquad math as the player (RBJ / Web Audio), searched band by band until the whole
// curve sits as close to the line as six smooth bands allow
function biquadDb(type, f0, g, q, f, fs) {
  const A = Math.pow(10, g / 40), w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sw = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === "peaking") {
    const al = sw / (2 * q); b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  } else {
    const al = sw / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    if (type === "lowshelf") { b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA); a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA; }
    else { b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA); a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA; }
  }
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / Math.max(1e-20, dr * dr + di * di));
}
var eqGhost = null;                  // the drawn line, kept faintly over the curve (as frequency / dB)
function fitEqToLine(pts, w, h) {
  const dbAt = yy => Math.max(-EQ_DB, Math.min(EQ_DB, (h / 2 - yy) / (h / 2 - 14) * EQ_DB));
  const line = pts.map(p => ({ f: eqF(p.x, w), g: dbAt(p.y) })).sort((a, b) => a.f - b.f);
  const fLo = line[0].f, fHi = line[line.length - 1].f;
  const target = f => {
    if (f < fLo || f > fHi) return 0;
    let i = 0; while (i < line.length - 1 && line[i + 1].f < f) i++;
    const a = line[i], b = line[Math.min(line.length - 1, i + 1)];
    const t = b.f === a.f ? 0 : Math.log(f / a.f) / Math.log(b.f / a.f);
    return a.g + (b.g - a.g) * Math.max(0, Math.min(1, t));
  };
  const fs = (ctx && ctx.sampleRate) || 48000;
  const N = 80, grid = [], want = [], weight = [];
  for (let i = 0; i < N; i++) { const f = EQ_MIN * Math.pow(EQ_MAX / EQ_MIN, (i + 0.5) / N); grid.push(f); want.push(target(f)); weight.push(f >= fLo && f <= fHi ? 1 : 0.25); }
  // bands 1..6: [type, f, g, q], with the range each may move in
  const P = [["lowshelf", 90, 0, .71, 25, 500], ["peaking", 220, 0, 1, 35, 18000], ["peaking", 650, 0, 1, 35, 18000],
             ["peaking", 1700, 0, 1, 35, 18000], ["peaking", 4300, 0, 1, 35, 18000], ["highshelf", 10000, 0, .71, 1500, 18000]]
    .map(([type, f, g, q, lo, hi]) => ({ type, f, g: target(f), q, lo, hi }));
  const err = () => {
    let e = 0;
    for (let j = 0; j < N; j++) { let r = 0; for (const b of P) r += biquadDb(b.type, b.f, b.g, b.q, grid[j], fs); const d = r - want[j]; e += weight[j] * d * d; }
    return e;
  };
  // search: nudge each band's frequency, gain and width while the error drops; smaller steps when stuck
  let best = err(), step = { f: 0.25, g: 3, q: 0.35 };
  for (let round = 0; round < 90 && step.g > 0.05; round++) {
    let improved = false;
    for (const b of P) for (const k of ["g", "f", "q"]) {
      if (k === "q" && b.type !== "peaking") continue;
      for (const dir of [1, -1]) {
        const old = b[k];
        if (k === "f") b.f = Math.max(b.lo, Math.min(b.hi, b.f * Math.pow(2, dir * step.f)));
        else if (k === "g") b.g = Math.max(-EQ_DB, Math.min(EQ_DB, b.g + dir * step.g));
        else b.q = Math.max(0.3, Math.min(6, b.q * Math.pow(2, dir * step.q)));
        const e = err();
        if (e < best - 1e-6) { best = e; improved = true; } else b[k] = old;
      }
    }
    if (!improved) { step.f /= 2; step.g /= 2; step.q /= 2; }
  }
  P.forEach((p, k) => Object.assign(lib.eq.bands[k + 1], { f: Math.round(p.f), g: Math.abs(p.g) < 0.2 ? 0 : Math.round(p.g * 10) / 10, q: Math.round(p.q * 100) / 100, on: true }));
  lib.eq.on = true; eqDrawMode = false; $("#eqDraw").classList.remove("on");
  eqGhost = line.filter((_, i) => i % 2 === 0 || i === line.length - 1);
  eqChanged(true);
  const rms = Math.sqrt(best / weight.reduce((a, x) => a + x, 0));
  toast(rms < 1 ? "The EQ follows your line. Drag a dot to fine-tune." : `As close as six bands can get (about ${rms.toFixed(1)} dB off). Drag a dot to fine-tune.`);
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
    $("#dlgNo").hidden = !no;
    $("#dlgYes").classList.toggle("danger", /^(Delete|Discard)/.test(yes));
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
let rec = null, lastTake = null;
async function recordStart() {
  if (rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("This device cannot record here"); return; }
  if (st.playing) pause();
  // a call holds the microphone: Android hands other apps silence, so say so before recording nothing
  if (ANDROID && ANDROID.inCall && ANDROID.inCall()) {
    const go = await confirmBox("A call is using the microphone",
      "While a phone or internet call is on, Android gives other apps silence, so this recording would be empty. Apps cannot record calls; if your Phone app has Record call, use that during the call.",
      "Record anyway", "Cancel");
    if (!go) return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2,
      ...(lib.recInput ? { deviceId: { exact: lib.recInput } } : {}) } });
  } catch (err) {
    if (err && err.name === "NotAllowedError") { toast("Microphone not allowed: " + (err.message || err.name)); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }         // the phone refused the stereo / raw settings
    catch (err2) { toast("The microphone did not start: " + (err2 && (err2.message || err2.name) || err2)); return; }
  }
  // its own audio engine for this take (closed on stop), so a second take never attaches to a spent one
  let rctx;
  try {
    try { rctx = new AudioContext({ latencyHint: "interactive", sampleRate: lib.recFmt.sr }); }
    catch (_) { rctx = new AudioContext({ latencyHint: "interactive" }); }                  // the phone's own rate
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
  renderRecMarks([]);
  rec = { stream, src, tap, rctx, chunks: [], nch, frames: 0, peak: 0, clip: 0, paused: false, started: Date.now(), peaks: [], sr: rctx.sampleRate, marks: [], shown: 0, block: 0.02 };
  const mine = rec;
  setTimeout(() => {                                          // nothing arriving: say so instead of "recording" silence
    if (rec === mine && !mine.paused && mine.frames === 0) { recordStop(false); toast("No sound is coming from the microphone. Close other apps that use it, then try again."); }
  }, 3000);
  const BLOCK = Math.round(rctx.sampleRate * 0.02);          // one waveform column per 20 ms
  let acc = 0, mn = 0, mx = 0;
  tap.port.onmessage = e => {
    const r = mine;                                 // blocks arrive in order, even after Stop: all are kept
    if (e.data.done) { r.ended && r.ended(); return; }
    const ch = e.data.channels; if (!ch) return;
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
    if (p > 0.0003) r.soundAt = r.frames / r.sr;               // something above digital silence
  };
  src.connect(tap);
  rec.block = BLOCK / rctx.sampleRate;
  rec.t0 = rctx.currentTime; rec.pausedSum = 0; rec.pausedAt = null;     // the recording clock: audio time minus pauses
  showPage("recs");
  $("#recName").value = takeName(rec.started);
  const micName = ((stream.getAudioTracks()[0] || {}).label || "").replace(/\s*\(.*?\)\s*$/, "");
  rec.infoText = `${micName ? micName + " · " : ""}${nch === 1 ? "Mono" : "Stereo"} · ${(rctx.sampleRate / 1000).toFixed(1).replace(".0", "")} kHz`;
  $("#recInfo").textContent = rec.infoText; $("#recInfo").classList.remove("warn");
  setFmtChip(rctx.sampleRate);
  setRecUi(); renderRecMarks();
}
function recordPause() {
  if (!rec) return;
  rec.paused = !rec.paused;
  const now = rec.rctx.currentTime;
  if (rec.paused) rec.pausedAt = now; else { rec.pausedSum += now - rec.pausedAt; rec.pausedAt = null; }
  rec.tap.port.postMessage({ cmd: "pause", on: rec.paused });
  setRecUi();
}
// how much audio has been recorded right now, on the audio clock (pauses excluded);
// the blocks themselves may still be on their way to this thread
function recordedNow(r) {
  if (!r) return 0;
  if (r.t0 === undefined) return r.frames / r.sr;
  const t = (r.paused ? r.pausedAt : r.rctx.currentTime) - r.t0 - r.pausedSum;
  return Math.max(0, t);
}
async function recordStop(keep) {
  if (!rec) return;
  const r = rec; rec = null; lastTake = r;
  r.stopAt = recordedNow(r);
  // the worklet answers "end" after its last block: wait for it so the tail is not cut
  await new Promise(ok => { r.ended = ok; try { r.tap.port.postMessage({ cmd: "end" }); } catch (_) { ok(); } setTimeout(ok, 2000); });
  try { r.src.disconnect(); r.tap.disconnect(); r.tap.port.onmessage = null; } catch (_) { }
  r.stream.getTracks().forEach(t => t.stop());
  r.rctx.close().catch(() => { });
  setRecUi(); drawRecorder();
  if (!keep || !r.frames) { if (mkEditing && mkEditing.ctx === recMk) closeMarkEdit(); renderRecMarks([]); if (keep) toast("Nothing was recorded"); return; }
  const n = r.frames;
  const chans = []; for (let c = 0; c < r.nch; c++) chans.push(new Float32Array(n));
  let p = 0; for (const ch of r.chunks) { for (let c = 0; c < r.nch; c++) chans[c].set(ch[Math.min(c, ch.length - 1)], p); p += ch[0].length; }
  const suggested = ($("#recName").value || "").trim() || takeName(r.started);
  let name = await ask("Name this recording", `${fmtTime(n / r.sr)} recorded`, suggested, "Save", "Discard");
  if (name === null) {
    if (await confirmBox("Throw this recording away?", "It has not been saved.", "Discard", "Keep it")) { toast("Recording discarded"); return; }
    name = suggested;
  }
  name = name.replace(/[\\/:*?"<>|]+/g, " ").trim().replace(/\.wav$/i, "") + ".wav";
  const blob = wavBlob(chans, r.sr, lib.recFmt.bits === 16 ? 16 : 24);
  const id = await saveRecording(blob, name, r.started, n / r.sr);
  if (id && r.marks.length) { lib.marks[id] = r.marks.map(m => ({ ...m })).sort((p, q) => p.t - q.t); save("marks"); }
  if (mkEditing && mkEditing.ctx === recMk) closeMarkEdit();
  $("#recName").value = ""; renderRecMarks([]);
  toast(`Saved “${name}” in Recordings (${fmtTime(n / r.sr)})`);
}
async function saveRecording(blob, name, started, seconds) {
  if (ANDROID && ANDROID.saveBegin) {
    await androidSave(blob, name, "recordings");            // Recordings/AVB Music Player on the phone
    loadRecordings();
    const id = recordingIds.find(x => songs[x].name === name) || recordingIds[0];
    if (id && !songs[id].duration) songs[id].duration = seconds;   // the phone may not have measured it yet
    showSavedTake(id);
    return id;
  }
  // web: kept in the app, in the Recordings library only
  const id = `rec|${name}|${started}`;
  await tx("songs", "readwrite", st2 => st2.put({ id, name, size: blob.size, type: "audio/wav", added: Date.now(), blob, bits: lib.recFmt.bits === 16 ? 16 : 24, kind: "recording", duration: seconds }));
  songs[id] = { id, name, size: blob.size, type: "audio/wav", added: Date.now(), kind: "recording", duration: seconds };
  recordingIds.unshift(id);
  showSavedTake(id);
  return id;
}
let freshTake = null, recAll = false;
$("#recSeeAll").onclick = () => { recAll = true; renderRecList(); };
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
  const ids = recordingIds.filter(id => songs[id] && !lib.hidden.includes(id));
  const when = t => { if (!t) return ""; const d = new Date(t); return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
  const shown = recAll || sel.where === "recs" ? ids : ids.slice(0, 5);
  $("#recSeeAll").hidden = ids.length <= 5 || recAll;
  el.innerHTML = shown.map((id, i) => { const s = songs[id]; return `<li data-id="${id}" class="${id === st.id ? "now" : ""} ${id === freshTake ? "fresh" : ""}"><div class="num">${i + 1}</div><div class="n"><div class="name">${esc(s.name.replace(/\.[^.]+$/, ""))}</div><div class="sub">${[when(s.added), s.duration ? clock(s.duration) : "", s.size > 0 ? (s.size / 1e6).toFixed(1) + " MB" : ""].filter(Boolean).join(" · ")}</div></div>${sel.where === "recs" ? "" : `<button class="rowplay" title="Play">▶</button>`}${rowEnd(id, "recs")}</li>`; }).join("")
    || `<li class="muted">No recordings yet: tap ● Record.</li>`;
  $("#recsInfo").textContent = ids.length ? (ANDROID ? `${ids.length} recording${ids.length === 1 ? "" : "s"} · Recordings/AVB Music Player on your phone` : `${ids.length} recording${ids.length === 1 ? "" : "s"}`) : "";
  shownIds.recs = ids; el.style.setProperty("--numw", String(shown.length).length + "ch");
  el.querySelectorAll("li[data-id]").forEach(li => {
    li.querySelector(".n").onclick = () => { if (pickRow(li, "recs")) return; loadSong(li.dataset.id, false); };
    const pb = li.querySelector(".rowplay"); if (pb) pb.onclick = () => { if (st.id === li.dataset.id && st.buffer) togglePlay(); else loadSong(li.dataset.id, true); };
    wireRow(li, "recs");
  });
  el.classList.toggle("selecting", sel.where === "recs"); updateSelbar();
}
// ---------------------------------------------------------------- the recorder
const clock = sec => { sec = Math.max(0, Math.floor(sec || 0)); const p = x => String(x).padStart(2, "0"); return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}`; };
function takeName(t) { const d = new Date(t), p = x => String(x).padStart(2, "0"); return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; }
function setFmtChip(rate) { $("#recFmtText").textContent = `${((rate || lib.recFmt.sr) / 1000).toFixed(1).replace(".0", "")} kHz · ${lib.recFmt.bits}-bit`; }
function setRecUi() {
  const on = !!rec, paused = on && rec.paused;
  $("#recIdle").hidden = on; $("#recCtl").hidden = !on;
  $("#recMarksBox").hidden = !on; $("#recNameBox").hidden = !on;
  $("#recInputBtn").disabled = on; $("#recFmtBtn").disabled = on;
  $("#recCard").classList.toggle("live", on && !paused); $("#recCard").classList.toggle("paused", paused);
  $("#recStatus").innerHTML = !on ? "READY TO RECORD" : paused ? "❚❚&nbsp; PAUSED" : `<span class="recdot"></span> RECORDING`;
  $("#recPauseLbl").textContent = paused ? "Resume" : "Pause";
  $("#recPause").innerHTML = paused ? `<svg viewBox="0 0 24 24" width="26" height="26"><circle cx="12" cy="12" r="7" fill="#EF4444"/></svg>` : `<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
  if (!on) { $("#recTime").textContent = clock(0); $("#recPeak").textContent = "—"; $("#recInfo").textContent = ""; $("#recInfo").classList.remove("warn"); setFmtChip(); }
  document.body.classList.toggle("recording", on);
  updateMini();
}
const RECCOL = ["#8B5CF6", "#A855F7", "#D946EF", "#EC4899", "#F43F5E", "#F97316"];
function drawRecorder() {
  const c = $("#recWave"); if (!c || !c.getBoundingClientRect().width) return;
  const dpr = sizeCanvas(c), w = c.width / dpr, h = c.height / dpr, g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const top = 6, bottom = h - 22, mid = (top + bottom) / 2, half = (bottom - top) / 2;
  const elapsed = rec ? rec.frames / rec.sr : 0;
  const span = Math.max(30, Math.ceil(elapsed * 1.25 / 30) * 30);          // always room ahead of the playhead
  const step = 5, bars = Math.floor(w / step), perBar = span / bars;
  const xHead = elapsed / span * w;
  // the center line ahead
  g.fillStyle = "rgba(255,255,255,.10)"; g.fillRect(xHead, mid - .5, w - xHead, 1);
  if (rec && rec.peaks.length) {
    const grad = g.createLinearGradient(0, 0, Math.max(xHead, 40), 0);
    RECCOL.forEach((col, i) => grad.addColorStop(i / (RECCOL.length - 1), col));
    g.fillStyle = grad;
    const pk = rec.peaks, per = rec.block;
    for (let k = 0; k < bars; k++) {
      const t0 = k * perBar; if (t0 >= elapsed) break;
      const i0 = Math.floor(t0 / per), i1 = Math.max(i0 + 1, Math.floor((t0 + perBar) / per));
      let a = 0; for (let i = i0; i < i1 && i * 2 + 1 < pk.length; i++) a = Math.max(a, -pk[i * 2], pk[i * 2 + 1]);
      const hh = Math.max(1.5, Math.pow(Math.min(1, a), 0.7) * half);
      g.beginPath(); g.roundRect ? g.roundRect(k * step, mid - hh, 3, hh * 2, 1.5) : g.rect(k * step, mid - hh, 3, hh * 2); g.fill();
    }
  }
  // markers
  if (rec) for (const m of rec.marks) { const x = m.t / span * w; g.fillStyle = mkColor(m); g.globalAlpha = .5; g.fillRect(x - .5, top, 1, bottom - top); g.globalAlpha = 1; g.fillRect(x - 1, top, 2, 14); g.beginPath(); g.moveTo(x + 1, top); g.lineTo(x + 10, top + 3.5); g.lineTo(x + 1, top + 7); g.fill(); }
  // the playhead
  if (rec) { g.fillStyle = "#F43F5E"; g.fillRect(xHead - 1, top, 2, bottom - top); g.beginPath(); g.arc(xHead, top + 2, 4, 0, Math.PI * 2); g.fill(); }
  // the ruler
  g.fillStyle = "rgba(255,255,255,.35)"; g.font = "600 11px Jakarta, system-ui"; g.textBaseline = "alphabetic";
  for (let i = 0; i <= 4; i++) {
    const t = span * i / 4, x = Math.min(w - 1, Math.max(0, t / span * w));
    g.fillRect(x, bottom + 3, 1, 4);
    g.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
    g.fillText(fmtTime(t), x, h - 2);
  }
}
function drawMeter() {
  const c = $("#recMeter"); if (!c || !c.getBoundingClientRect().width) return;
  const dpr = sizeCanvas(c), w = c.width / dpr, h = c.height / dpr, g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const lv = rec && !rec.paused ? (rec.level || 0) : 0;
  rec && (rec.shown = Math.max(lv, (rec.shown || 0) * 0.86));
  const shown = rec ? rec.shown : 0;
  const frac = Math.max(0, Math.min(1, (20 * Math.log10(shown + 1e-6) + 60) / 60));
  const n = Math.floor(w / 7), lit = Math.round(frac * n);
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    g.fillStyle = i < lit ? RECCOL[Math.min(RECCOL.length - 1, Math.floor(p * RECCOL.length))] : "rgba(255,255,255,.10)";
    g.beginPath(); g.roundRect ? g.roundRect(i * 7, 0, 4, h, 2) : g.rect(i * 7, 0, 4, h); g.fill();
  }
}
$("#recWave").addEventListener("pointerdown", e => {
  if (!rec || !rec.marks.length) return;
  const r = $("#recWave").getBoundingClientRect(), x = e.clientX - r.left, w = r.width;
  const elapsed = rec.frames / rec.sr, span = Math.max(30, Math.ceil(elapsed * 1.25 / 30) * 30);
  const hit = rec.marks.map(m => [m, Math.abs(m.t / span * w + 4 - x)]).filter(([, d]) => d < 16).sort((p, q) => p[1] - q[1])[0];
  if (hit) showMarkPop(recMk, hit[0].id, r.top + 30);
});
async function chooseInput() {
  if (rec) return;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput"); } catch (_) { }
  if (devs.length && !devs.some(d => d.label)) {
    // the names show only once the microphone has been allowed: ask once, then list
    try { const s2 = await navigator.mediaDevices.getUserMedia({ audio: true }); s2.getTracks().forEach(t => t.stop()); devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput"); } catch (_) { }
  }
  const nice = d => d.deviceId === "default" || !d.label ? "Phone microphone" : d.label.replace(/\s*\(.*?\)\s*$/, "") || "Microphone";
  // Automatic = Android's choice: a plugged-in headset, USB microphone or audio interface, else the phone's own
  const items = [{ label: `Automatic: any connected microphone, else the phone's${!lib.recInput ? "  ✓" : ""}`, run: () => { lib.recInput = ""; save("recInput"); $("#recInputName").textContent = "Automatic"; } }];
  for (const d of devs) if (d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
    items.push({ label: `${nice(d)}${lib.recInput === d.deviceId ? "  ✓" : ""}`, run: () => { lib.recInput = d.deviceId; save("recInput"); $("#recInputName").textContent = nice(d); } });
  sheet(items, "Record from");
}
function chooseFormat() {
  if (rec) return;
  const f = lib.recFmt;
  const items = [
    [48000, 24, "best: phones and video use 48 kHz, 24-bit has the most room before it distorts"],
    [48000, 16, "smaller files"],
    [44100, 24, "CD rate, more room before it distorts"],
    [44100, 16, "CD quality, smallest files"],
  ].map(([sr, bits, why]) => ({
    label: `${(sr / 1000).toFixed(1).replace(".0", "")} kHz · ${bits}-bit WAV (${why})${f.sr === sr && f.bits === bits ? "  ✓" : ""}`,
    run: () => { lib.recFmt = { sr, bits }; save("recFmt"); setFmtChip(); },
  }));
  sheet(items, "Recording quality for new recordings");
}
$("#recInputBtn").onclick = chooseInput; $("#recFmtBtn").onclick = chooseFormat;
$("#recMarkBtn").onclick = () => addMarker(recMk); $("#recMarkAdd").onclick = () => addMarker(recMk);
setFmtChip();
// a saved input that is gone falls back to the phone's microphone
if (lib.recInput && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) navigator.mediaDevices.enumerateDevices().then(ds => {
  const d = ds.find(x => x.deviceId === lib.recInput);
  if (!d) { lib.recInput = ""; save("recInput"); $("#recInputName").textContent = "Automatic"; } else if (d.label) $("#recInputName").textContent = d.label.replace(/\s*\(.*?\)\s*$/, "");
}).catch(() => { });
// settings
$("#settingsBtn").onclick = () => {
  updateRecheck(false);                                 // the update line below refreshes itself if a newer one appeared
  // the user's order: Home screen, default player, share, updates, open a song, markers and notes; then the rest
  const items = [];
  if (ANDROID && ANDROID.addToHome) items.push({ label: "Add AVB Player to the Home screen", run: () => {
    if (!ANDROID.addToHome()) toast("This home screen does not allow it: long-press AVB Player in the apps list and drag it to the Home screen");
  } });
  else if (!ANDROID && !$("#installBtn").hidden) items.push({ label: "Install the app on this phone", run: () => $("#installBtn").click() });
  if (ANDROID && ANDROID.askDefault) items.push({ label: "Make AVB Player your default player", run: () => ANDROID.askDefault() });
  if (ANDROID && ANDROID.shareApp) items.push({ label: "Share AVB Player (WhatsApp, text)", run: () => ANDROID.shareApp(APK_URL) });
  else if (/Android/.test(navigator.userAgent)) items.push({ label: "Download the Android app", run: () => { location.href = APK_URL; } });
  if (ANDROID && ANDROID.updateCheck) items.push(updateInfo
    ? { label: `Update to AVB Player ${updateInfo.name}`, run: startUpdate }
    : { label: "Check for updates", run: () => { updateManual = true; toast("Checking for updates"); ANDROID.updateCheck(); } });
  items.push({ label: ANDROID ? "Open a song from Drive or another app" : "Add music from your files", run: () => $("#files2").click() });
  items.push({ label: "Save the markers and notes of every song in one spreadsheet (to Downloads)", run: exportAllMarks });
  if (canAskManaged()) items.push({ label: "Delete and rename without Android asking", run: () => { ANDROID.askManageMedia(); toast("Turn on “Allow media management” for AVB Player, then come back"); } });
  if (lib.hidden.length) items.push({ label: `Show removed songs again (${lib.hidden.length})`, run: () => { const n = lib.hidden.length; lib.hidden = []; save("hidden"); renderList(); renderRecList(); toast(`${n} back in the player`); } });
  const ver = ANDROID && ANDROID.version ? ANDROID.version() : "";
  sheet(items, ver ? `Settings · AVB Player ${ver}` : "Settings");
};

// ---------------------------------------------------------------- home: shelves, mini player, Now Playing
const esc = t => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const songTitle = id => songs[id] ? (songs[id].title && !/^<unknown>$/i.test(songs[id].title) ? songs[id].title : songs[id].name.replace(/\.[^.]+$/, "")) : "";
const songArtist = id => songs[id] && songs[id].artist && !/^<unknown>$/i.test(songs[id].artist) ? songs[id].artist : "";
// album art from the phone, small, fetched once per song while it scrolls into view
const artCache = new Map();
function artFor(id, el) {
  if (!ANDROID || !ANDROID.albumArt || !/^[mr]:/.test(id)) return;
  if (artCache.has(id)) { const u = artCache.get(id); if (u) { el.style.background = `center / cover no-repeat url("${u}")`; } return; }
  artObserver.observe(el); el.dataset.art = id;
}
const artObserver = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    artObserver.unobserve(e.target);
    const id = e.target.dataset.art;
    setTimeout(() => {
      let url = null;
      try { const b64 = ANDROID.albumArt(id.slice(2)); if (b64) url = "data:image/jpeg;base64," + b64; } catch (_) { }
      artCache.set(id, url);
      if (url) e.target.style.background = `center / cover no-repeat url("${url}")`;
    }, 0);
  }
}, { rootMargin: "200px" }) : { observe() { }, unobserve() { } };

function renderShelves() {
  const hasSongs = Object.keys(songs).some(id => !isRecording(id) && !lib.hidden.includes(id));
  $("#hero").hidden = hasSongs || phoneState === "loading";
  const recent = lib.recent.filter(id => songs[id] && !isRecording(id)).slice(0, 12);
  $("#recentShelf").hidden = !recent.length;
  $("#recentTiles").innerHTML = recent.map(id => `<button class="tile" data-id="${esc(id)}"><div class="art" style="background:${coverFor(songs[id].name)}"></div><div class="tname">${esc(songTitle(id))}</div><div class="tsub">${esc(songArtist(id) || fmtOf(songs[id].name))}</div></button>`).join("");
  $("#recentTiles").querySelectorAll(".tile").forEach(t => {
    artFor(t.dataset.id, t.querySelector(".art"));
    t.onclick = () => { const id = t.dataset.id; if (!lib.queue.includes(id)) { lib.queue.push(id); save("queue"); } playIndex(lib.queue.indexOf(id)); openNP("listen"); };
  });
  const lists = [{ key: "favorites", name: "Favorites", n: lib.favorites.length, cls: "fav" }, ...lib.playlists.map(p => ({ key: "list", name: p.name, n: p.items.length }))];
  $("#listTiles").innerHTML = lists.map(p => `<button class="tile" data-view="${p.key}" data-name="${esc(p.name)}"><div class="art ${p.cls || ""}" style="${p.cls ? "" : "background:" + coverFor(p.name)}"><span>${p.cls ? "♥" : esc(p.name[0] || "♪").toUpperCase()}</span></div><div class="tname">${esc(p.name)}</div><div class="tsub">${p.n} song${p.n === 1 ? "" : "s"}</div></button>`).join("")
    + `<button class="tile" id="newList"><div class="art add"><span>+</span></div><div class="tname">New playlist</div><div class="tsub">&nbsp;</div></button>`;
  $("#listTiles").querySelectorAll(".tile[data-view]").forEach(t => t.onclick = () => openDrill(t.dataset.view, t.dataset.view === "list" ? t.dataset.name : "", t.dataset.view === "favorites" ? "Favorites" : t.dataset.name));
  $("#newList").onclick = () => newPlaylist();
}
// a playlist, Favorites, an artist or an album opens on its own; Back returns to all music
let drill = null;
const homeView = () => ANDROID ? "phone" : "queue";
function openDrill(v, name, title) {
  selEnd(true);
  drill = { from: view === "group" ? homeView() : (view === "artists" || view === "albums" ? view : homeView()) };
  view = v; listName = name || "";
  document.body.classList.add("drill");
  $("#libName").textContent = title; $("#libBack").hidden = false;
  renderList(); window.scrollTo({ top: 0 });
}
function closeDrill() {
  if (!drill) return false;
  view = drill.from; listName = ""; drill = null;
  document.body.classList.remove("drill");
  $("#libName").textContent = "Library"; $("#libBack").hidden = true;
  renderList(); window.scrollTo({ top: 0 });
  return true;
}
$("#libBack").onclick = closeDrill;
// under the song's name: format tag, artist, length, BPM (teal = the song's own, yellow = changed), size
function fillHomeSub() {
  if (!st.id || !songs[st.id]) return;
  $("#hHeart").innerHTML = HEART; $("#hHeart").classList.toggle("on", lib.favorites.includes(st.id));
  if (!st.buffer) { $("#hSub").textContent = st.loadErr || "Loading…"; return; }
  const s0 = songs[st.id], f = fmtOf(s0.name), sp = +$("#speed").value, b = effBpm();
  const kind = { WAV: "wav", MP3: "mp3", FLAC: "flac", M4A: "m4a", AAC: "m4a", MP4: "m4a", OGG: "ogg", OPUS: "ogg", AIFF: "aif", AIF: "aif", AIFC: "aif" }[f] || "other";
  const artist = $("#npArtist").textContent || (s0.artist && !/unknown/i.test(s0.artist) ? s0.artist : "");
  const parts = [artist && esc(artist), fmtTime(st.duration || s0.duration || 0),
    b ? `<b class="hbpm${sp !== 100 ? " moved" : ""}">${(b * sp / 100).toFixed(1)} BPM</b>` : "",
    s0.size > 0 ? (s0.size / 1e6).toFixed(1) + " MB" : ""].filter(Boolean);
  $("#hSub").innerHTML = `<span class="ft ft-${kind}">${esc(f)}</span>` + parts.join(" · ");
}
function updateMini() {
  const show = !!st.id && songs[st.id] && $("#np").hidden && !rec && !sel.where;
  $("#mini").hidden = !show; document.body.classList.toggle("hasmini", !!show);
  if (!st.id || !songs[st.id]) return;
  $("#miniTitle").textContent = $("#title").textContent;
  // the song's name at the top of the home screen, with its format tag and length
  $("#hTitle").textContent = $("#title").textContent;
  fillHomeSub();
  $("#miniSub").textContent = $("#npArtist").textContent || (isRecording(st.id) ? "Recording" : (st.info && st.info.fmt) || "");
  const dur = st.duration || songs[st.id].duration || 0, fmt = (st.info && st.info.fmt) || fmtOf(songs[st.id].name);
  $("#miniSub").textContent = !st.buffer ? (st.loadErr || "Loading…") : [$("#npArtist").textContent, fmt, dur ? fmtTime(dur) : ""].filter(Boolean).join(" · ");
  $("#mini").classList.toggle("loading", !st.buffer && !st.loadErr);
  setMiniPlay(st.playing);
}
// the round play / pause icon, and the equaliser moves only while music plays
function setMiniPlay(on) {
  // white icons on the glossy orange balls
  const pause = w => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="#fff"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>`;
  const playI = w => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="#fff"><path d="M8 5.2v13.6L19 12z"/></svg>`;
  $("#miniPlay").innerHTML = on ? pause(18) : playI(18);
  $("#hPlay").innerHTML = on ? pause(28) : playI(28);
  $("#play").innerHTML = on ? pause(32) : playI(32);
  $("#mini").classList.toggle("playing", !!on);
}

let npMode = "listen";
// one waveform (with pinch zoom, seek, A/B, flags): on the home screen, or in Studio while that is open
// the Tempo and Key rows live under the home waveform, and go back into Studio's Tempo & Key while it is open
const MIX_ROWS = ["rowTempo", "rowKey", "rowChange"].map(id => { const el = $("#" + id), a = document.createComment(id); el.before(a); return [el, a]; });
const LYR = (() => { const el = $("#tab-lyrics"), anchor = document.createComment("lyrics"); el.before(anchor); return { el, anchor }; })();
function placeWave() {
  const inStudio = !$("#np").hidden && npMode === "studio";
  const slot = inStudio ? $("#npWaveSlot") : $("#homeWave");
  const box = $("#waveBox"); if (box.parentElement !== slot) slot.appendChild(box);      // the waveform with its ±10 s buttons
  const show = !!st.id && !!songs[st.id] && !inStudio;
  $("#homeWave").hidden = !show; $("#homeMix").hidden = !show; $("#homeTransport").hidden = !show; $("#homeTitle").hidden = !show;
  $("#cutBar").hidden = !show || !cutMode;
  $("#homeTools").hidden = !show;
  // the lyrics: on the home screen, or in Now Playing > Listen while that is open
  const inListen = !$("#np").hidden && npMode === "listen";
  if (inListen) { if (LYR.el.previousSibling !== LYR.anchor) LYR.anchor.after(LYR.el); }
  else if (LYR.el.parentElement !== $("#homeLyrics")) $("#homeLyrics").appendChild(LYR.el);
  $("#homeLyrics").hidden = !show || inListen;
  for (const [el, anchor] of MIX_ROWS) {
    if (inStudio) { if (el.previousSibling !== anchor) anchor.after(el); }
    else if (el.parentElement !== $("#homeMix")) $("#homeMix").appendChild(el);
  }
  requestAnimationFrame(drawWave);
}
function setNpMode(m) {
  npMode = m;
  $("#np").classList.toggle("studio", m === "studio");
  placeWave();
  $("#npMode").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  requestAnimationFrame(() => { drawWave(); if ($("#tab-eq").classList.contains("on")) drawEq(); if ($("#tab-loud").classList.contains("on")) drawLoud(); });
}
function openNP(mode) {
  if (mode) setNpMode(mode);
  $("#np").hidden = false; document.body.classList.add("npopen"); placeWave();
  $("#npScroll").scrollTop = 0;
  updateMini(); requestAnimationFrame(() => { drawWave(); if (st.buffer && st.duration) { $("#tnow").textContent = fmtTime(st.pos); $("#seek").value = Math.round(st.pos / st.duration * 1000); } });
}
function closeNP() { $("#np").hidden = true; document.body.classList.remove("npopen"); updateMini(); placeWave(); }
$("#npClose").onclick = closeNP;
$("#npMode").querySelectorAll("button").forEach(b => b.onclick = () => setNpMode(b.dataset.mode));
$("#mini").onclick = e => { if (e.target.closest(".minibtn")) return; openNP(); };
// drag along the bottom player's progress line to move forward or back; the song jumps on release
var miniSeeking = false;
(function miniSeek() {
  const z = $("#miniSeek"); let t = 0;
  const at = e => { const r = $(".miniprog").getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (st.duration || 0); };
  const show = () => { $("#miniProg").style.width = (t / st.duration * 100) + "%"; $("#miniSub").textContent = `${fmtTime(t)} / ${fmtTime(st.duration)}`; };
  z.addEventListener("pointerdown", e => {
    if (!st.buffer || !st.duration) return;
    e.stopPropagation(); e.preventDefault();
    miniSeeking = true; $("#mini").classList.add("seeking");
    try { z.setPointerCapture(e.pointerId); } catch (_) { }
    t = at(e); show();
  });
  z.addEventListener("pointermove", e => { if (!miniSeeking) return; t = at(e); show(); });
  const up = () => { if (!miniSeeking) return; miniSeeking = false; seek(t); $("#mini").classList.remove("seeking"); updateMini(); };
  z.addEventListener("pointerup", up); z.addEventListener("pointercancel", up);
  z.addEventListener("click", e => e.stopPropagation());        // a drag never opens the player
})();
$("#miniPlay").onclick = e => { e.stopPropagation(); togglePlay(); };   // the bar's buttons never open Now Playing
$("#miniPrev").onclick = e => { e.stopPropagation(); prevTrack(); };
// ---- Cut: mark a piece on the home waveform, keep it or remove it, as a new file
var cutMode = false, cutFmt = "";   // var: syncMarkers can run before this line
function defaultCutFmt() {
  // the file's own format: a 24-bit WAV gives a 24-bit WAV, an MP3 an MP3 at (up to) its own rate
  const f = st.info && st.info.fmt, bits = st.info && st.info.bits;
  if (bits && (f === "FLAC")) return `flac-${bits > 16 ? 24 : 16}`;
  if (bits) return `wav-${bits >= 32 ? 32 : bits > 16 ? 24 : 16}`;
  const kb = sourceKbps() || 320;
  return "mp3-" + ([320, 256, 192, 128].find(n => n <= kb + 8) || 128);
}
const fmtLabel = v => { const o = $("#fmt").querySelector(`option[value="${v}"]`); return o ? o.textContent : v; };
function updateCut() {
  if (!$("#cutA")) return;
  const both = st.a !== null && st.b !== null;
  $("#cutA").classList.toggle("on", st.a !== null); $("#cutB").classList.toggle("on", st.b !== null);
  $("#cutLen").textContent = both ? `${fmtTime(st.a)} – ${fmtTime(st.b)}  ·  ${(st.b - st.a).toFixed(1)} s`
    : st.a !== null ? `Starts at ${fmtTime(st.a)}. Now play or tap to where it ends, then tap End here.` : "Play or tap to where the piece starts, then tap Start here.";
  $("#cutKeep").disabled = $("#cutRemove").disabled = !both || !!saving; $("#cutLoop").disabled = !both;
  $("#cutLoop").classList.toggle("on", both && st.loopOn);
  if (!cutFmt && st.buffer) cutFmt = defaultCutFmt();
  $("#cutFmt").textContent = cutFmt ? `as ${fmtLabel(cutFmt)} ▾` : "";
}
function openCut() {
  if (!st.buffer) { toast("Load a song first"); return; }
  cutMode = true; cutFmt = defaultCutFmt(); placeWave(); updateCut();
}
function closeCut() { cutMode = false; st.a = st.b = null; st.loopOn = false; syncMarkers(); placeWave(); }
$("#hCut").onclick = () => cutMode ? closeCut() : openCut();
// the heart and ⋯ beside the song's name at the top
$("#hHeart").onclick = () => { if (!st.id) return; const on = !lib.favorites.includes(st.id); toggleFav(st.id); toast(on ? "Added to Favorites" : "Removed from Favorites"); };
$("#hMore").onclick = () => { if (st.id && songs[st.id]) songMenu(st.id); };
// the tools, one tap from the home screen: Now Playing opens on that tool
$("#homeTools").querySelectorAll("button").forEach(b => b.onclick = () => {
  const t = b.dataset.tool;
  if (t === "lyrics") {
    // no lyrics for this song: the chip opens (or closes) the lyrics box, to see why or to add them
    if (document.body.classList.contains("nolyrics") && !document.body.classList.toggle("lyrforce")) return;
    $("#homeLyrics").scrollIntoView({ behavior: "smooth", block: "start" }); return;
  }
  openNP(t === "lyrics" ? "listen" : "studio");
  if (t !== "lyrics") selectTool(t);
  requestAnimationFrame(() => { const el = t === "lyrics" ? $("#tab-lyrics") : $(".toolsbox"); $("#npScroll").scrollTop = el.offsetTop - 70; });
});
$("#cutClose").onclick = closeCut;
$("#cutA").onclick = () => { if (!st.buffer) return; st.a = st.pos; if (st.b !== null && st.b <= st.a) st.b = null; syncMarkers(); };
$("#cutB").onclick = () => { if (!st.buffer) return; st.b = st.pos; if (st.a === null) st.a = 0; if (st.a > st.b) [st.a, st.b] = [st.b, st.a]; if (st.b - st.a < 0.05) { st.b = null; toast("The end must come after the start"); } syncMarkers(); };
$("#cutLoop").onclick = () => { if (st.a === null || st.b === null) return; st.loopOn = !st.loopOn; syncMarkers(); if (st.loopOn) { seek(st.a); if (!st.playing) play(); } };
$("#cutFmt").onclick = () => {
  const items = [];
  for (const o of $("#fmt").querySelectorAll("option")) {
    const [k, n] = o.value.split("-"), why = saveReason("keep", { kind: k, n: +n });
    if (why && !why.startsWith("Mark")) continue;                                // above the file's own quality
    items.push({ label: o.textContent + (o.value === cutFmt ? "  ✓" : ""), run: () => { cutFmt = o.value; updateCut(); } });
  }
  sheet(items, "Save the piece as");
};
async function cutSave(part) {
  if (st.a === null || st.b === null || saving) return;
  $("#part").value = part; $("#fmt").value = cutFmt; refreshSave();
  const why = saveReason(part, fmtChoice());
  if (why) { toast(why); return; }
  const mirror = setInterval(() => { $("#cutStatus").textContent = $("#saveStatus").textContent; }, 300);
  await saveCopy();
  clearInterval(mirror); $("#cutStatus").textContent = $("#saveStatus").textContent; updateCut();
}
$("#cutKeep").onclick = () => cutSave("keep");
$("#cutRemove").onclick = () => cutSave("remove");
$("#hPlay").onclick = () => togglePlay(); $("#hPrev").onclick = () => prevTrack(); $("#hNext").onclick = () => nextTrack(false);
$("#miniNext").onclick = e => { e.stopPropagation(); nextTrack(false); };
setMiniPlay(false);

// ---------------------------------------------------------------- ui wiring
function showPage(p) {
  if (p === "play" || p === "library") p = "music";
  document.querySelectorAll(".page").forEach(e => e.classList.toggle("on", e.id === "page-" + p));
  $("#pages").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.page === p));
  document.body.classList.toggle("onrecs", p === "recs");
  if (p === "recs") { if (ANDROID) loadRecordings(); renderRecList(); requestAnimationFrame(() => { drawRecorder(); drawMeter(); }); }
  window.scrollTo({ top: 0 });
}
$("#pages").querySelectorAll("button").forEach(b => b.onclick = () => showPage(b.dataset.page));
$("#tools").querySelectorAll("button").forEach(b => b.onclick = () => selectTool(b.dataset.tab));
$("#files2").onchange = e => { addFiles([...e.target.files], true); e.target.value = ""; };
$("#play").onclick = togglePlay; $("#prev").onclick = prevTrack; $("#next").onclick = () => nextTrack(false);
$("#back10").onclick = () => seek(st.pos - 10); $("#fwd10").onclick = () => seek(st.pos + 10);
$("#markA").onclick = () => markButton("A"); $("#markB").onclick = () => markButton("B");
const REPEAT_SVG = one => `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>${one ? `<text x="12" y="15.2" text-anchor="middle" font-size="8" font-weight="800" font-family="Jakarta, sans-serif">1</text>` : ""}</svg>`;
const setRepeatUi = () => { for (const b of [$("#repeat"), $("#hRepeat")]) { b.innerHTML = REPEAT_SVG(lib.repeat === "one"); b.classList.toggle("on", lib.repeat !== "off"); b.title = { off: "Repeat: off", all: "Repeat: all", one: "Repeat: this song" }[lib.repeat]; } };
$("#repeat").onclick = $("#hRepeat").onclick = () => { lib.repeat = { off: "all", all: "one", one: "off" }[lib.repeat]; save("repeat"); setRepeatUi(); mediaReport(); toast({ off: "Repeat off", all: "Repeat all", one: "Repeat this song" }[lib.repeat]); };
setRepeatUi();
$("#seek").oninput = e => seek(+e.target.value / 1000 * st.duration);
$("#heart").onclick = () => toggleFav(st.id);
$("#npMore").onclick = () => { if (st.id && songs[st.id]) songMenu(st.id); };
$("#shareBtn").onclick = () => shareSong();
const SHUFFLE_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`;
const setShuffleUi = () => { for (const b of [$("#shuffle"), $("#hShuffle")]) { b.innerHTML = SHUFFLE_SVG; b.classList.toggle("on", !!lib.shuffle); } };
$("#shuffle").onclick = $("#hShuffle").onclick = () => { lib.shuffle = !lib.shuffle; save("shuffle"); setShuffleUi(); mediaReport(); toast(lib.shuffle ? "Shuffle on" : "Shuffle off"); };
setShuffleUi();
$("#mono").onclick = () => { lib.mono = !lib.mono; $("#mono").classList.toggle("on", lib.mono); if (ctx && eqOut) buildOutputStage(); toast(lib.mono ? "Mono check: both speakers play the same sum" : "Stereo again"); };
const balText = v => v === 0 ? "Center" : v < 0 ? `L ${-v}` : `R ${v}`;
$("#balance").value = lib.balance; $("#balanceV").textContent = balText(lib.balance);
$("#balance").oninput = e => { let v = +e.target.value; if (Math.abs(v) < 4) v = 0; lib.balance = v; $("#balanceV").textContent = balText(v); setBalance(); };
$("#balance").onchange = () => save("balance");
$("#balance").ondblclick = () => { lib.balance = 0; $("#balance").value = 0; $("#balanceV").textContent = "Center"; setBalance(); save("balance"); };
// tap tempo: the median of the last taps; a pause of 2.5 s starts again
let taps = [];
$("#tapBtn").onclick = () => {
  if (!st.id) { toast("Load a song first"); return; }
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
  taps.push(now); if (taps.length > 12) taps.shift();
  $("#tapBtn").classList.add("hit"); setTimeout(() => $("#tapBtn").classList.remove("hit"), 90);
  if (taps.length < 4) { $("#tapBtn").textContent = `Tap tempo · ${4 - taps.length} more`; return; }
  const iv = taps.slice(1).map((t, i) => t - taps[i]).sort((a, b) => a - b);
  const bpm = Math.round(60000 / iv[Math.floor(iv.length / 2)] * 10) / 10;
  lib.fix[st.id] = { ...(lib.fix[st.id] || {}), bpm, bpmHow: "tap" }; save("fix");
  $("#tapBtn").textContent = `Tap tempo · ${bpm}`; refreshMusic(); refreshSave();
};
$("#bpmEdit").onclick = async () => {
  if (!st.id) return;
  const v = await ask("Tempo", "Type the song's tempo in BPM.", effBpm() ? effBpm().toFixed(1) : "", "Set");
  const bpm = parseFloat((v || "").replace(",", "."));
  if (!bpm || bpm < 20 || bpm > 400) { if (v) toast("A tempo between 20 and 400, please"); return; }
  lib.fix[st.id] = { ...(lib.fix[st.id] || {}), bpm, bpmHow: "typed" }; save("fix"); refreshMusic(); refreshSave();
};
$("#keyEdit").onclick = () => {
  if (!st.id) return;
  const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const items = [];
  for (const mode of ["minor", "major"]) for (const n of names) { const k = `${n} ${mode}`; items.push({ label: `${k}  ·  ${CAMELOT[k]}${k === effKey() ? "  ✓" : ""}`, run: () => { lib.fix[st.id] = { ...(lib.fix[st.id] || {}), key: k }; save("fix"); refreshMusic(); } }); }
  sheet(items, "The song's key");
};
$("#fixReset").onclick = () => { delete lib.fix[st.id]; save("fix"); $("#tapBtn").textContent = "Tap tempo"; taps = []; refreshMusic(); refreshSave(); };
// ---------------------------------------------------------------- markers & notes
// One tap drops a marker at the exact moment; a note, a category and the time can
// be changed later, all without pausing playback or recording.  Per song in
// lib.marks[id] = [{ id, t, text, cat }], sorted by time.
const MK_CATS = { idea: ["Idea", "#A78BFA"], fix: ["Fix", "#FB923C"], fav: ["Favorite", "#F472B6"], section: ["Section", "#22D3EE"] };
const mkColor = m => (MK_CATS[m.cat] || MK_CATS.idea)[1];
const mkCatName = m => (MK_CATS[m.cat] || MK_CATS.idea)[0];
const mkTime = t => { t = Math.max(0, t || 0); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = Math.floor(t % 60), d = Math.floor((t % 1) * 10); return `${h ? h + ":" + String(m).padStart(2, "0") : m}:${String(sec).padStart(2, "0")}.${d}`; };
const FLAG_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M5 22V3h12l-2 4.5L17 12H7v10z"/></svg>`;
// older markers ({t, text}) get an id and a category
for (const k of Object.keys(lib.marks)) for (const m of lib.marks[k]) { if (!m.id) m.id = Math.random().toString(36).slice(2, 10); if (!m.cat) m.cat = "idea"; if (m.text === undefined) m.text = ""; }
// where markers live: the loaded song, or the take being recorded
const songMk = {
  live: false,
  list() { return st.id ? (lib.marks[st.id] = lib.marks[st.id] || []) : []; },
  now() { return st.pos || 0; },
  dur() { return st.duration || 0; },
  seek(t) { seek(t); },
  changed() { const l = lib.marks[st.id]; if (l) { l.sort((a, b) => a.t - b.t); if (!l.length) delete lib.marks[st.id]; } save("marks"); renderMarks(); drawWave(); },
  title() { return st.id && songs[st.id] ? songTitle(st.id) : "Song"; },
};
const recMk = {
  live: true,
  list() { return rec ? rec.marks : (lastTake ? lastTake.marks : []); },
  now() { return rec ? recordedNow(rec) : (lastTake ? lastTake.stopAt || 0 : 0); },   // recorded audio only: pauses are not counted
  dur() { return rec ? recordedNow(rec) : (lastTake ? lastTake.stopAt || 0 : 0); },
  seek() { },                                                       // never touches the take
  changed() { if (rec) rec.marks.sort((a, b) => a.t - b.t); renderRecMarks(); drawRecorder(); },
  title() { return ($("#recName").value || "Recording").trim(); },
};
function addMarker(ctx) {
  if (ctx === songMk && !st.buffer) { toast("Load a song first"); return; }
  if (ctx === recMk && !rec) return;
  const m = { id: Math.random().toString(36).slice(2, 10), t: Math.round(ctx.now() * 100) / 100, text: "", cat: lib.mkCat || "idea" };
  ctx.list().push(m); ctx.changed();
  if (ctx === songMk && !lib.mkOpen) { lib.mkOpen = true; save("mkOpen"); renderMarks(); }
  snack(`${mkCatName(m)} marker at ${mkTime(m.t)}`, "Add note", () => editMarker(ctx, m.id, true));
}
function findMk(ctx, id) { return ctx.list().find(m => m.id === id); }
function deleteMarker(ctx, id) {
  const list = ctx.list(), i = list.findIndex(m => m.id === id); if (i < 0) return;
  const [gone] = list.splice(i, 1); ctx.changed();
  if (ctx === songMk && !lib.marks[st.id]) lib.marks[st.id] = [];
  const songId = st.id;
  snack(`Marker at ${mkTime(gone.t)} deleted`, "Undo", () => { if (ctx === songMk && st.id !== songId) return; ctx.list().push(gone); ctx.changed(); });
}
// the compact editor: a strip at the bottom, nothing stops, every change is kept at once
let mkEditing = null;
function editMarker(ctx, id, focus) {
  const m = findMk(ctx, id); if (!m) return;
  mkEditing = { ctx, id };
  hideMarkPop();
  const el = $("#mkEdit");
  el.innerHTML = `
    <div class="mkehead"><span class="mkdot" style="background:${mkColor(m)}"></span>
      <button class="mketime" id="mkeTime" title="${ctx.live ? "" : "Jump here"}">${mkTime(m.t)}</button>
      <span class="spacer"></span><button class="textbtn" id="mkeDone">Done</button></div>
    <div class="mkecats">${Object.entries(MK_CATS).map(([k, [n, c]]) => `<button data-cat="${k}" class="${m.cat === k ? "on" : ""}" style="--c:${c}">${n}</button>`).join("")}</div>
    <textarea id="mkeText" rows="2" placeholder="Note (optional): what happens here, what to fix…">${esc(m.text)}</textarea>
    <div class="mkemove"><span class="faint">Move</span>
      <button data-d="-1">−1 s</button><button data-d="-0.1">−0.1</button><button data-d="0.1">+0.1</button><button data-d="1">+1 s</button>
      <button data-d="now">${ctx.live ? "To now" : "To playhead"}</button>
      <span class="spacer"></span><button class="textbtn danger" id="mkeDel">Delete</button></div>`;
  el.hidden = false;
  const ta = $("#mkeText");
  ta.oninput = () => { m.text = ta.value; if (ctx === songMk) save("marks"); clearTimeout(editMarker.t); editMarker.t = setTimeout(() => ctx === songMk ? renderMarks() : renderRecMarks(), 250); };
  el.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => {
    m.cat = b.dataset.cat; lib.mkCat = m.cat; save("mkCat");
    el.querySelectorAll("[data-cat]").forEach(x => x.classList.toggle("on", x === b));
    el.querySelector(".mkdot").style.background = mkColor(m); ctx.changed();
  });
  el.querySelectorAll("[data-d]").forEach(b => b.onclick = () => {
    const d = b.dataset.d, max = ctx.dur() || m.t;
    m.t = Math.round(Math.max(0, Math.min(max, d === "now" ? ctx.now() : m.t + +d)) * 100) / 100;
    $("#mkeTime").textContent = mkTime(m.t); ctx.changed();
  });
  $("#mkeTime").onclick = () => { if (!ctx.live) ctx.seek(m.t); };
  $("#mkeDel").onclick = () => { closeMarkEdit(); deleteMarker(ctx, m.id); };
  $("#mkeDone").onclick = closeMarkEdit;
  if (focus) setTimeout(() => ta.focus(), 30);
}
function closeMarkEdit() { $("#mkEdit").hidden = true; if (mkEditing) { mkEditing.ctx.changed(); } mkEditing = null; }
// tapping a flag: its time and note, a jump (playback only) and Edit
function showMarkPop(ctx, id, anchorY) {
  const m = findMk(ctx, id); if (!m) return;
  const el = $("#mkPop");
  el.innerHTML = `<div class="mkprow"><span class="mkdot" style="background:${mkColor(m)}"></span><b>${mkTime(m.t)}</b><span class="mkpcat">${mkCatName(m)}</span></div>
    <div class="mkptext">${m.text ? esc(m.text) : `<span class="faint">No note</span>`}</div>
    <div class="mkpbtns">${ctx.live ? "" : `<button id="mkpJump">Jump here</button>`}<button id="mkpEdit">${m.text ? "Edit" : "Add note"}</button></div>`;
  el.style.top = Math.max(60, Math.min(window.innerHeight - 180, anchorY)) + "px";
  el.hidden = false;
  if (!ctx.live) $("#mkpJump").onclick = () => { ctx.seek(m.t); hideMarkPop(); };
  $("#mkpEdit").onclick = () => editMarker(ctx, m.id, true);
  clearTimeout(showMarkPop.t); showMarkPop.t = setTimeout(hideMarkPop, 6000);
}
function hideMarkPop() { $("#mkPop").hidden = true; }
document.addEventListener("pointerdown", e => { if (!$("#mkPop").hidden && !e.target.closest("#mkPop, #seekMarks, #wave, #recWave")) hideMarkPop(); });
// one list for the song (in Now Playing) and the take (in the recorder)
function markRows(ctx) {
  return ctx.list().map(m => `<li data-id="${m.id}"><button class="mkt" style="--c:${mkColor(m)}">${FLAG_SVG}<span>${mkTime(m.t)}</span></button>
    <button class="mkn"><span class="mkc" style="color:${mkColor(m)}">${mkCatName(m)}</span>${m.text ? esc(m.text) : `<span class="faint">Add a note</span>`}</button>
    <button class="mkx" title="Delete">✕</button></li>`).join("");
}
function wireRows(ul, ctx) {
  ul.querySelectorAll("li[data-id]").forEach(li => {
    const id = li.dataset.id;
    li.querySelector(".mkt").onclick = () => { if (ctx.live) editMarker(ctx, id); else { const m = findMk(ctx, id); if (m) ctx.seek(m.t); } };
    li.querySelector(".mkn").onclick = () => editMarker(ctx, id, true);
    li.querySelector(".mkx").onclick = () => deleteMarker(ctx, id);
  });
}
function renderMarks() {
  const list = st.id ? (lib.marks[st.id] || []) : [];
  $("#mkCount").textContent = list.length;
  $("#mkPanel").hidden = !lib.mkOpen;
  $("#mkChev").textContent = lib.mkOpen ? "⌃" : "⌄";
  $("#mkList").innerHTML = markRows(songMk) || `<li class="muted mkempty">Tap <b>⚑ Marker</b> at any moment: the music keeps playing. Add a note now or later.</li>`;
  wireRows($("#mkList"), songMk);
  $("#mkCopy").disabled = $("#mkExport").disabled = !list.length;
  // flags along the seek bar
  const d = st.duration || 0;
  $("#seekMarks").innerHTML = d ? list.map(m => `<button data-id="${m.id}" style="left:${(m.t / d * 100).toFixed(3)}%;--c:${mkColor(m)}" title="${mkTime(m.t)}"></button>`).join("") : "";
  $("#seekMarks").querySelectorAll("button").forEach(b => b.onclick = e => showMarkPop(songMk, b.dataset.id, b.getBoundingClientRect().top - 150));
}
function renderRecMarks(list) {
  const ctx = list ? { ...recMk, list: () => list } : recMk;
  $("#recMarks").innerHTML = markRows(ctx) || `<li class="muted">Tap <b>Add Marker</b> at a moment you want to find again. Recording never stops.</li>`;
  wireRows($("#recMarks"), ctx);
}
$("#mkAdd").onclick = () => addMarker(songMk);
$("#mkToggle").onclick = () => { lib.mkOpen = !lib.mkOpen; save("mkOpen"); renderMarks(); };
// export / copy
function marksText(title, list, notes) {
  const lines = list.map(m => `${mkTime(m.t).padEnd(9)} ${mkCatName(m).padEnd(10)} ${m.text || ""}`.trimEnd());
  return `${title}\n${"".padEnd(Math.min(60, title.length), "=")}\n\n${lines.join("\n") || "(no markers)"}${notes ? `\n\nNotes\n-----\n${notes}` : ""}\n`;
}
const csvCell = v => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
function marksCsv(rows) { return "File,Time,Seconds,Category,Note\r\n" + rows.map(([file, m]) => [file, mkTime(m.t), m.t.toFixed(2), mkCatName(m), m.text || ""].map(csvCell).join(",")).join("\r\n") + "\r\n"; }
async function saveTextFile(text, name, mime) {
  const blob = new Blob([mime === "text/csv" ? "\uFEFF" + text : text], { type: mime });   // the BOM lets Excel read accents
  try {
    if (ANDROID && ANDROID.saveBegin) { await androidSave(blob, name); toast(`Saved to Downloads: ${name}`); }
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); toast(`Saved ${name}`); }
  } catch (err) { toast("Could not save: " + (err && err.message || err)); }
}
function exportMarks(title, list, notes) {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").trim() + " - markers";
  sheet([
    { label: "Save as CSV (spreadsheet) in Downloads", run: () => saveTextFile(marksCsv(list.map(m => [title, m])), base + ".csv", "text/csv") },
    { label: "Save as TXT in Downloads", run: () => saveTextFile(marksText(title, list, notes), base + ".txt", "text/plain") },
    { label: "Share as text", run: () => deliverShare(new Blob([marksText(title, list, notes)], { type: "text/plain" }), base + ".txt") },
  ], `Export ${list.length} marker${list.length === 1 ? "" : "s"}`);
}
$("#mkCopy").onclick = async () => { const list = lib.marks[st.id] || []; toast(await copyText(marksText(songMk.title(), list, lib.notes[st.id] || "")) ? "Markers and notes copied" : "Could not copy"); };
$("#mkExport").onclick = () => exportMarks(songMk.title(), lib.marks[st.id] || [], lib.notes[st.id] || "");
// every song's notes and markers in one spreadsheet: per song its notes first (Category "Song notes"), then its markers in time order
function exportAllMarks() {
  const lines = [];
  const ids = [...new Set([...Object.keys(lib.notes).filter(id => (lib.notes[id] || "").trim()), ...Object.keys(lib.marks).filter(id => (lib.marks[id] || []).length)])];
  const nameOf = id => songs[id] ? songs[id].name : id.replace(/^[a-z]+[:|]/, "");
  ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: "base" }));
  for (const id of ids) {
    const note = (lib.notes[id] || "").trim();
    if (note) lines.push([nameOf(id), "", "", "Song notes", note].map(csvCell).join(","));
    for (const m of (lib.marks[id] || []).slice().sort((a, b) => a.t - b.t))
      lines.push([nameOf(id), mkTime(m.t), m.t.toFixed(2), mkCatName(m), m.text || ""].map(csvCell).join(","));
  }
  if (!lines.length) { toast("No markers or notes yet"); return; }
  saveTextFile("File,Time,Seconds,Category,Note\r\n" + lines.join("\r\n") + "\r\n", "AVB Player - all markers and notes.csv", "text/csv");
}
// the snack bar: a short message with one action (Add note, Undo)
let snackTimer = 0;
function snack(text, action, run) {
  const el = $("#snack"); $("#snackText").textContent = text;
  $("#snackBtn").textContent = action || ""; $("#snackBtn").hidden = !action;
  $("#snackBtn").onclick = () => { el.hidden = true; run && run(); };
  el.hidden = false; clearTimeout(snackTimer); snackTimer = setTimeout(() => el.hidden = true, 4500);
}
$("#half").onclick = () => { st.bpmScale = Math.max(0.25, st.bpmScale / 2); refreshMusic(); refreshSave(); };
$("#dbl").onclick = () => { st.bpmScale = Math.min(4, st.bpmScale * 2); refreshMusic(); refreshSave(); };
// the change happens by itself: when the finger lifts off the slider, or shortly after the last tap on − / +
let changeTimer = 0;
const changeSoon = (ms = 450) => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { applyChange(); refreshSave(); }, ms); };
$("#speed").oninput = () => { refreshMusic(); };
$("#speedBpm").onclick = async () => {
  const bpm = effBpm();
  if (!bpm) { toast("The tempo is not known yet: tap Tap tempo in Studio › Info, or wait for the analysis"); return; }
  const v = await ask("Tempo", `Type the BPM you want (the song is ${bpm.toFixed(1)} BPM). Between ${(bpm * .5).toFixed(0)} and ${(bpm * 1.5).toFixed(0)}.`, (bpm * +$("#speed").value / 100).toFixed(1), "Set");
  const want = parseFloat((v || "").replace(",", ".")); if (!want) return;
  $("#bpmTarget").value = want; $("#bpmTarget").dispatchEvent(new Event("change"));
};
$("#speed").onchange = () => changeSoon(50);
// speed: a button that opens the list (a dropdown drew no text in the phone's web view)
$("#speedBtn").onclick = () => {
  const cur = +$("#speed").value / 100;
  sheet([0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5].map(v => ({ label: `${v}×${v === 1 ? "  (original)" : ""}${Math.abs(v - cur) < .001 ? "  ✓" : ""}`,
    run: () => { $("#speed").value = Math.round(v * 100); applyChange(); refreshMusic(); refreshSave(); } })), "Speed");
};
$("#bpmTarget").onchange = e => { const bpm = effBpm(); if (bpm) { $("#speed").value = Math.max(50, Math.min(150, Math.round(+e.target.value / bpm * 100))); refreshMusic(); changeSoon(50); } };
$("#keyDown").onclick = () => { st.semis = Math.max(-12, st.semis - 1); refreshMusic(); changeSoon(); };
$("#keyUp").onclick = () => { st.semis = Math.min(12, st.semis + 1); refreshMusic(); changeSoon(); };

$("#resetChange").onclick = () => { st.semis = 0; $("#speed").value = 100; applyChange(); refreshMusic(); refreshSave(); };
// a reset for each: the tempo alone, the key alone
$("#tempoReset").onclick = $("#tempoMid").onclick = () => { if (+$("#speed").value === 100) return; $("#speed").value = 100; refreshMusic(); changeSoon(); };
$("#keyReset").onclick = () => { if (!st.semis) return; st.semis = 0; refreshMusic(); changeSoon(); };
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
$("#files3").onchange = e => { addFiles([...e.target.files], true); e.target.value = ""; };
$("#recBtn").onclick = recordStart; $("#recPause").onclick = recordPause;
$("#recStop").onclick = () => recordStop(true);
$("#recCancel").onclick = async () => { const was = rec && rec.paused; if (rec && !was) recordPause(); if (await confirmBox("Throw this take away?", "It has not been saved.", "Discard", "Keep recording")) recordStop(false); else if (rec && !was) recordPause(); };
// typing a search: the song panel steps aside so the matches show right under the box (the mini player keeps playing)
$("#filter").oninput = () => { document.body.classList.toggle("searching", !!$("#filter").value.trim()); renderList(); };
window.addEventListener("resize", () => { drawWave(); drawLoud(); drawEq(); drawRecorder(); drawMeter(); });
document.addEventListener("keydown", e => { if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return; if (e.code === "Space") { e.preventDefault(); togglePlay(); } if (e.key === "ArrowLeft") seek(st.pos - 5); if (e.key === "ArrowRight") seek(st.pos + 5); });

// clock
let lastDraw = 0;
function tick(now) {
  if (rec && now - lastDraw > 33) {
    lastDraw = now;
    drawRecorder(); drawMeter();
    $("#recPeak").innerHTML = rec.peak > 0 ? `<b>${(20 * Math.log10(rec.peak + 1e-9)).toFixed(1)}</b> dBFS peak${rec.clip ? ` <span class="clip">CLIP</span>` : ""}` : "—";
    $("#recTime").textContent = clock(recordedNow(rec));
    // only silence arriving: a call (or another app) holds the microphone
    const quiet = !rec.paused && rec.frames / rec.sr - (rec.soundAt || 0) > 3;
    if (quiet !== !!rec.quiet) {
      rec.quiet = quiet;
      $("#recInfo").classList.toggle("warn", quiet);
      $("#recInfo").textContent = quiet
        ? (ANDROID && ANDROID.inCall && ANDROID.inCall() ? "Only silence: a call is using the microphone. Android does not let apps record calls." : "Only silence is arriving: is another app or a call using the microphone?")
        : rec.infoText;
      if (quiet && !rec.warned) { rec.warned = true; if (navigator.vibrate) try { navigator.vibrate([60, 60, 60]); } catch (_) { } }
    }
  } else if (st.buffer && st.playing && now - lastDraw > 40) {
    lastDraw = now; $("#tnow").textContent = fmtTime(st.pos); $("#hNow").textContent = fmtTime(st.pos); if (!miniSeeking) $("#miniProg").style.width = (st.pos / st.duration * 100) + "%"; lyricsTick(st.pos); if ($("#tab-eq").classList.contains("on")) drawEq(); $("#seek").value = Math.round(st.pos / st.duration * 1000); drawWave();
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
window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; $("#installHint").hidden = true; toast("Installed: open AVB Player from its icon"); });
$("#installBtn").onclick = async () => {
  if (installEvent) { installEvent.prompt(); const r = await installEvent.userChoice; if (r.outcome === "accepted") $("#installBtn").hidden = true; installEvent = null; return; }
  showInstallHint();
};
$("#installClose").onclick = () => { $("#installHint").hidden = true; sessionStorage.setItem("hintClosed", "1"); };
const APK_URL = "https://angelikavb.github.io/avb-music-player-app/AVB-Player.apk";   // always the newest Android app
function showInstallHint() {
  const ua = navigator.userAgent;
  const inApp = /; wv\)|FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\//.test(ua);
  const chrome = /Chrome\//.test(ua) && !/EdgA|SamsungBrowser|OPR|YaBrowser/.test(ua);
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  $("#installText").innerHTML = ios
    ? (/CriOS|FxiOS|EdgiOS|WhatsApp|FBAN|Instagram/.test(ua)
        ? "Open this link in <b>Safari</b>, then tap <b>Share</b> (the square with the arrow) → <b>Add to Home Screen</b>."
        : "Tap <b>Share</b> (the square with the arrow, at the bottom) → <b>Add to Home Screen</b> → <b>Add</b>. AVB Player then opens from its icon.")
    : inApp
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
    if (/\.(midi?|kar|rmi)$/i.test(m.name || "") || /midi/i.test(m.mime || "")) continue;   // MIDI is notes, not sound
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
if (ANDROID) { $("#viewQueue").hidden = true; if (view === "queue") view = "phone"; $("#viewPhone").hidden = false; $("#viewArtists").hidden = false; $("#viewAlbums").hidden = false; setTimeout(() => { loadPhone(true); loadRecordings(); }, 300); }
else recordingIds = Object.values(songs).filter(x => x.kind === "recording").sort((a, b) => b.added - a.added).map(x => x.id);
if (ANDROID && ANDROID.askDefault) { $("#makeDefault").hidden = false; $("#makeDefault").onclick = () => ANDROID.askDefault(); }
window.avbBack = () => {
  if ($("#sheet").classList.contains("on")) { $("#sheet").classList.remove("on"); return true; }
  if (!$("#mkEdit").hidden) { closeMarkEdit(); return true; }
  if (!$("#mkPop").hidden) { hideMarkPop(); return true; }
  if (sel.where) { selEnd(); return true; }
  if (!$("#np").hidden && !rec) { closeNP(); return true; }
  if ($("#page-music").classList.contains("on") && closeDrill()) return true;
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
window.avb = { st, lib, eqResponse: f => eqResponse(f), fitEqToLine: (p, w, h) => fitEqToLine(p, w, h), songMk, recMk, addMarker, editMarker, marksCsv, marksText, shareSong, loadSong, applyChange, saveCopy, seek, play, pause, markButton, loopRange };

// ---------------------------------------------------------------- updates (Android app)
// version.json on the download page names the newest APK; Update downloads it inside the app and
// hands it to Android's installer (which asks once to allow installs from AVB Player)
var updateInfo = null, updateManual = false, updateBusy = false, updateAt = 0;
window.avbUpdateInfo = text => {
  let v = null;
  try { v = text ? JSON.parse(text) : null; } catch (_) { }
  const mine = ANDROID && ANDROID.versionCode ? +ANDROID.versionCode() : 0;
  updateInfo = v && +v.code > mine && v.url ? v : null;
  showUpdateBar();
  if (updateManual) {
    updateManual = false;
    if (updateInfo) startUpdate();                      // asked from Settings: go straight on
    else toast(v ? `AVB Player ${ANDROID.version ? ANDROID.version() : ""} is the newest version` : "Could not check for updates. Are you online?");
  }
};
// the first start after an update: the bar says so for a few seconds, then goes away by itself
var updateDoneUntil = 0;
function showUpdated(v) {
  updateDoneUntil = Date.now() + 5000;
  $("#updText").textContent = `Updated to AVB Player ${v} ✓`;
  $("#updBtn").hidden = true; $("#updLater").hidden = true;
  $("#updBar").classList.add("done"); $("#updBar").hidden = false;
  setTimeout(() => { updateDoneUntil = 0; $("#updBar").classList.remove("done"); showUpdateBar(); }, 5000);
}
function showUpdateBar(text) {
  if (Date.now() < updateDoneUntil) return;
  const later = updateInfo && sessionStorage.getItem("updLater") === String(updateInfo.code);
  $("#updBar").hidden = !updateInfo || (later && !updateBusy);
  $("#updText").textContent = text || (updateInfo ? `New version: AVB Player ${updateInfo.name}` : "");
  $("#updBtn").hidden = updateBusy; $("#updLater").hidden = updateBusy;
}
// an update that went quiet (Android's screen closed, a lost connection) never blocks the next tap
function updateStalled() { return updateBusy && Date.now() - updateAt > 45000; }
function startUpdate() {
  if (!updateInfo) { updateManual = true; toast("Checking for updates"); ANDROID.updateCheck(); return; }
  if (updateBusy && !updateStalled()) { toast($("#updText").textContent || "The update is on its way"); return; }
  updateBusy = false;
  const r = ANDROID.updateInstall(updateInfo.url, updateInfo.sha256 || "");
  if (r === "permission") {
    ask("Allow updates once", "Android needs your OK one time: turn on “Allow from this source” for AVB Player, come back here and tap Update again.", "", "Open settings", "Cancel", false)
      .then(ok => { if (ok) ANDROID.openInstallSettings(); });
    return;
  }
  if (r !== "ok") { ask("Update", "This update cannot be installed from here (" + r + "). Download it from the AVB Player page instead.", "", "Open the page", "Cancel", false).then(ok => { if (ok) location.href = APK_URL; }); return; }
  updateBusy = true; updateAt = Date.now(); showUpdateBar("Downloading the update… 0%");
}
window.avbUpdateProgress = pct => {
  updateBusy = true; updateAt = Date.now();
  showUpdateBar(+pct >= 100 ? "Installing… tap Update when Android asks. The app then closes: open it again." : `Downloading the update… ${pct}%`);
};
// problems are shown in a box (not a passing toast) so they can be read and reported
window.avbUpdateError = text => {
  updateBusy = false; showUpdateBar();
  if (/cancel/i.test(text || "")) toast(text); else ask("Update did not finish", text || "Update failed", "", "OK", "", false);
};
// back from Android's install screen without the new version: Update can be tapped again
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && updateBusy && /Installing/.test($("#updText").textContent)) setTimeout(() => { updateBusy = false; showUpdateBar(); }, 2500);
});
$("#updBtn").onclick = startUpdate;
$("#updLater").onclick = () => { try { sessionStorage.setItem("updLater", String(updateInfo && updateInfo.code)); } catch (_) { } showUpdateBar(); };
// checked at start, and again whenever the app comes back to the front (at most once a minute), so the offer is never stale
var updateCheckedAt = 0;
const updateRecheck = force => { if (!ANDROID || !ANDROID.updateCheck || updateBusy) return; if (!force && Date.now() - updateCheckedAt < 60000) return; updateCheckedAt = Date.now(); ANDROID.updateCheck(); };
if (ANDROID && ANDROID.updateCheck) setTimeout(() => updateRecheck(true), 3000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") updateRecheck(false); });
// the first start after an update says so (Android closes the app while it installs the new version)
if (ANDROID && ANDROID.version) {
  const nowVer = ANDROID.version();
  // (a version from before this was remembered: Android's own "last updated" time, within the last 10 minutes)
  const justUpdated = lib.seenVersion ? lib.seenVersion !== nowVer : (ANDROID.updatedAgo ? (t => t >= 0 && t < 600000)(+ANDROID.updatedAgo()) : false);
  if (nowVer && justUpdated) showUpdated(nowVer);
  if (nowVer && lib.seenVersion !== nowVer) { lib.seenVersion = nowVer; save("seenVersion"); }
}
