// The playback engine: walks a Float32 buffer (the song, or a rendered
// tempo/key version of it), loops between A and B, reports its position.
// Positions crossing the port are always in SONG frames (the original timeline).
class AVBPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null;          // [Float32Array, ...] what is playing
    this.speed = 1;          // song frames per buffer frame
    this.pos = 0;            // frame in ch
    this.playing = false;
    this.loop = null;        // [a, b] in song frames
    this.volume = 1;
    this.ended = false;
    this.tick = 0;
    this.port.onmessage = e => this.handle(e.data);
  }
  songFrame() { return Math.round(this.pos * this.speed); }
  handle(m) {
    switch (m.cmd) {
      case "load": this.ch = m.channels; this.speed = 1; this.pos = 0; this.ended = false; this.loop = null; break;
      case "swap": {                                   // a rendered version takes over at the same song moment
        const song = this.songFrame();
        this.ch = m.channels; this.speed = m.speed;
        this.pos = Math.min(Math.round(song / this.speed), this.ch[0].length);
        break;
      }
      case "play": this.playing = true; if (this.ch && this.pos >= this.ch[0].length) this.pos = 0; this.ended = false; break;
      case "pause": this.playing = false; break;
      case "seek": if (this.ch) { this.pos = Math.max(0, Math.min(this.ch[0].length, Math.round(m.frame / this.speed))); this.ended = false; } break;
      case "loop": this.loop = m.loop; break;
      case "volume": this.volume = m.volume; break;
      case "unload": this.ch = null; this.playing = false; this.pos = 0; break;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
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
    for (let c = 0; c < out.length; c++) {
      const src = this.ch[Math.min(c, this.ch.length - 1)];
      const o = out[c];
      for (let i = 0; i < take; i++) o[i] = src[this.pos + i] * this.volume;
      for (let i = take; i < n; i++) o[i] = 0;
    }
    this.pos += take;
    if (take < n) {
      if (this.loop && lb > la) this.pos = la;
      else { this.playing = false; this.ended = true; this.port.postMessage({ ended: true }); }
    }
    if (++this.tick % 8 === 0) this.port.postMessage({ frame: this.songFrame() });
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
