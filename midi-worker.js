// MIDI files play (the user, 2026-11-12: "can you make AVB player play midi?"): a MIDI file is notes, not sound,
// so it is played once through a General MIDI synthesizer (SpessaSynth, Apache 2.0) with the GeneralUser GS
// sound bank, and the sound comes back as audio. After that it is a song like any other: waveform, tempo, key,
// cut, Save as. The bank is read once and kept while this worker lives.
import { BasicMIDI, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer, SpessaLog } from "./vendor/spessasynth.js";

SpessaLog.setLogLevel(false, false, false);
let bank = null;
async function soundBank() {
  if (!bank) {
    const r = await fetch("vendor/GeneralUser-GS.sf2");
    if (!r.ok) throw new Error("the instrument sounds could not be read");
    bank = SoundBankLoader.fromArrayBuffer(await r.arrayBuffer());
  }
  return bank;
}

self.onmessage = async e => {
  const { buffer, sampleRate } = e.data;
  try {
    const sb = await soundBank();
    const midi = BasicMIDI.fromArrayBuffer(buffer);
    if (!(midi.duration > 0)) throw new Error("this MIDI file has no notes");
    const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
    synth.soundBankManager.addSoundBank(sb, "main");
    await synth.ready;
    synth.setSystemParameter("autoAllocateVoices", true);
    const seq = new SpessaSynthSequencer(synth);
    seq.skipToFirstNoteOn = false;                 // the file's own timing: a part that starts on bar 5 starts on bar 5
    seq.loopCount = 0;
    seq.loadNewSongList([midi]);
    seq.play();
    // the song, then up to 4 s for the last notes to ring out (silence after them is trimmed)
    const n = Math.ceil(sampleRate * (midi.duration + 4)), L = new Float32Array(n), R = new Float32Array(n);
    let f = 0, k = 0;
    while (f < n) {
      seq.processTick();
      const b = Math.min(128, n - f);
      synth.process(L, R, f, b);
      f += b;
      if ((++k & 2047) === 0) postMessage({ progress: f / n });
    }
    let end = Math.ceil(sampleRate * midi.duration);
    for (let i = n - 1; i > end; i--) if (Math.abs(L[i]) > 1e-4 || Math.abs(R[i]) > 1e-4) { end = i + 1; break; }
    // as loud as a finished song: the loudest moment at -1 dBFS (a synthesizer plays far below full level)
    let peak = 0;
    for (let i = 0; i < end; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; }
    const gain = peak > 0 ? 0.891 / peak : 1;
    const outL = L.slice(0, end), outR = R.slice(0, end);
    for (let i = 0; i < end; i++) { outL[i] *= gain; outR[i] *= gain; }
    postMessage({ channels: [outL, outR], sampleRate, name: midi.getName ? midi.getName() : "" }, [outL.buffer, outR.buffer]);
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
  }
};
