// Tempo and key through Rubber Band (WebAssembly), off the main thread.
// In: {channels, sampleRate, speed, semitones, keepVoice, finer}
// Out: {progress} ... then {channels, speed}; or {error}
import { RubberBandInterface } from "./vendor/rubberband.esm.js";

let api = null;
const ready = (async () => {
  const wasm = await WebAssembly.compileStreaming(fetch("./vendor/rubberband.wasm"));
  api = await RubberBandInterface.initialize(wasm);
})();

const FormantPreserved = 16777216, PitchHighQuality = 33554432, EngineFiner = 536870912, ChannelsTogether = 268435456;

onmessage = async e => {
  const { channels, sampleRate, speed, semitones, keepVoice, finer } = e.data;
  try {
    await ready;
    const timeRatio = 1 / speed;
    const pitch = Math.pow(2, semitones / 12);
    let options = PitchHighQuality | ChannelsTogether;
    if (keepVoice) options |= FormantPreserved;
    if (finer) options |= EngineFiner;
    const nch = channels.length, nIn = channels[0].length;
    const state = api.rubberband_new(sampleRate, nch, options, timeRatio, pitch);
    api.rubberband_set_expected_input_duration(state, nIn);
    const block = api.rubberband_get_samples_required(state);
    const arrPtr = api.malloc(nch * 4);
    const ptrs = [];
    for (let c = 0; c < nch; c++) { const p = api.malloc(block * 4); ptrs.push(p); api.memWritePtr(arrPtr + c * 4, p); }
    const outLen = Math.ceil(nIn * timeRatio) + block * 4;
    const out = channels.map(() => new Float32Array(outLen));
    let write = 0, last = 0;
    const feed = (fn, phaseStart, phaseSpan) => {
      let read = 0;
      while (read < nIn) {
        const take = Math.min(block, nIn - read);
        for (let c = 0; c < nch; c++) api.memWrite(ptrs[c], channels[c].subarray(read, read + take));
        read += take;
        fn(state, arrPtr, take, read >= nIn ? 1 : 0);
        const now = Date.now();
        if (now - last > 200) { last = now; postMessage({ progress: phaseStart + phaseSpan * read / nIn }); }
      }
    };
    const drain = final => {
      for (;;) {
        const avail = api.rubberband_available(state);
        if (avail < 1 || (!final && avail < block)) break;
        const got = api.rubberband_retrieve(state, arrPtr, Math.min(block, avail));
        if (write + got > outLen) break;
        for (let c = 0; c < nch; c++) out[c].set(api.memReadF32(ptrs[c], got), write);
        write += got;
      }
    };
    feed((s, a, n, f) => api.rubberband_study(s, a, n, f), 0, 0.15);
    feed((s, a, n, f) => { api.rubberband_process(s, a, n, f); drain(false); }, 0.15, 0.85);
    drain(true);
    ptrs.forEach(p => api.free(p)); api.free(arrPtr); api.rubberband_delete(state);
    const trimmed = out.map(o => o.slice(0, write));
    postMessage({ channels: trimmed, speed }, trimmed.map(t => t.buffer));
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
  }
};
