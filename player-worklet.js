// The playback engine: walks a Float32 buffer (the song, or a rendered
// tempo/key version of it), loops between A and B, reports its position.
// Positions crossing the port are always in SONG frames (the original timeline).
const XF = 384;              // A/B: the frames one side fades into the other (8 ms at 48 kHz)
class AVBPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null;          // [Float32Array, ...] what is playing
    this.speed = 1;          // song frames per buffer frame
    this.pos = 0;            // frame in ch
    this.playing = false;
    this.loop = null;        // [a, b] in song frames
    this.volume = 1;
    this.alt = null; this.useAlt = false; this.altGain = 1;   // A/B: a second song, played in the first one's place at the same moment
    this.from = null; this.fromGain = 1; this.xf = 0;         // the side just left, faded out over XF frames (no click)
    this.ended = false;
    this.tick = 0;
    this.last = 0; this.stalls = 0; this.worst = 0;   // the playback check: moments the sound thread was held up
    this.port.onmessage = e => this.handle(e.data);
  }
  songFrame() { return Math.round(this.pos * this.speed); }
  handle(m) {
    switch (m.cmd) {
      case "load": this.ch = m.channels; this.speed = 1; this.pos = 0; this.ended = false; this.loop = null; this.useAlt = false; this.xf = 0; break;
      case "alt": this.alt = m.channels || null; this.altGain = m.gain || 1; if (!this.alt) { this.useAlt = false; this.xf = 0; } break;
      case "altgain": this.altGain = m.gain || 1; break;
      case "ab": {
        const on = !!m.on && !!this.alt && this.speed === 1;
        if (on !== this.useAlt) { this.from = this.useAlt ? this.alt : this.ch; this.fromGain = this.useAlt ? this.altGain : 1; this.xf = XF; this.useAlt = on; }
        break;
      }
      case "swap": {                                   // a rendered version takes over at the same song moment
        const song = this.songFrame();
        this.ch = m.channels; this.speed = m.speed;
        if (this.speed !== 1) { this.useAlt = false; this.xf = 0; }
        this.pos = Math.min(Math.round(song / this.speed), this.ch[0].length);
        break;
      }
      case "play": this.playing = true; if (this.ch && this.pos >= this.ch[0].length) this.pos = 0; this.ended = false; break;
      case "pause": this.playing = false; break;
      case "seek": if (this.ch) { this.pos = Math.max(0, Math.min(this.ch[0].length, Math.round(m.frame / this.speed))); this.ended = false; } break;
      case "loop": this.loop = m.loop; break;
      case "volume": this.volume = m.volume; break;
      case "give": { const ch = this.ch || []; this.ch = null; this.playing = false; this.port.postMessage({ given: ch, speed: this.speed, pos: this.pos }, ch.map(c => c.buffer)); break; }   // the sound output is being reopened
      case "restore": this.ch = m.channels; this.speed = m.speed; this.pos = m.pos; this.ended = false; break;
      case "unload": this.ch = null; this.playing = false; this.pos = 0; this.useAlt = false; this.xf = 0; break;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const now = Date.now(), gap = this.last ? now - this.last : 0; this.last = now;
    if (this.ch && this.playing && gap > 60) { this.stalls++; if (gap > this.worst) this.worst = gap; }
    if (!this.ch || !this.playing) {
      for (const o of out) o.fill(0);
      return true;
    }
    const len = this.ch[0].length;
    let la = 0, lb = len;
    if (this.loop) {
      la = Math.round(this.loop[0] / this.speed); lb = Math.min(len, Math.round(this.loop[1] / this.speed));
      if (lb > la && (this.pos >= lb || this.pos < la)) this.pos = la;
    }
    const end = this.loop && lb > la ? lb : len;
    const take = Math.max(0, Math.min(n, end - this.pos));
    const cur = this.useAlt && this.alt ? this.alt : this.ch, g = (this.useAlt && this.alt ? this.altGain : 1) * this.volume;
    const xf = this.from ? Math.min(this.xf, take) : 0;
    for (let c = 0; c < out.length; c++) {
      const src = cur[Math.min(c, cur.length - 1)], sl = src.length;
      const o = out[c];
      for (let i = 0; i < take; i++) { const p = this.pos + i; o[i] = p < sl ? src[p] * g : 0; }   // a shorter B is silent past its end
      if (xf) {
        const old = this.from[Math.min(c, this.from.length - 1)], ol = old.length, og = this.fromGain * this.volume;
        for (let i = 0; i < xf; i++) { const p = this.pos + i, w = (this.xf - i) / XF; o[i] = o[i] * (1 - w) + (p < ol ? old[p] * og : 0) * w; }
      }
      for (let i = take; i < n; i++) o[i] = 0;
    }
    if (this.xf) { this.xf -= xf; if (this.xf <= 0 || !xf) { this.xf = 0; this.from = null; } }
    this.pos += take;
    if (take < n) {
      if (this.loop && lb > la) this.pos = la;
      else { this.playing = false; this.ended = true; this.port.postMessage({ ended: true }); }
    }
    if (++this.tick % 8 === 0) { this.port.postMessage({ frame: this.songFrame(), stalls: this.stalls, worst: this.worst }); this.stalls = this.worst = 0; }
    return true;
  }
}
registerProcessor("avb-player", AVBPlayer);


// Recording: passes the input blocks to the page as they come (~23 ms each).
class AVBTap extends AudioWorkletProcessor {
  // pause / end act here, on the audio clock: a paused moment is never captured,
  // and "end" is answered after every captured block has been posted
  constructor() {
    super();
    this.paused = false; this.ended = false;
    this.port.onmessage = e => {
      const d = e.data;
      if (d.cmd === "pause") this.paused = !!d.on;
      if (d.cmd === "end") { this.ended = true; this.port.postMessage({ done: true }); }
    };
  }
  process(inputs) {
    if (this.ended) return false;
    const inp = inputs[0];
    if (!this.paused && inp && inp.length && inp[0].length) {
      const channels = inp.map(ch => ch.slice());
      this.port.postMessage({ channels }, channels.map(c => c.buffer));
    }
    return true;
  }
}
registerProcessor("avb-tap", AVBTap);
