# AVB Music Player - phone version

The same player as an installable web app for Android (and any modern
browser).  Nothing leaves the phone: songs you open are copied into the
app's own storage, analysed on the phone, and played by the browser's audio
engine.  Tempo and key changes run Rubber Band (GPL) compiled to
WebAssembly, in `vendor/` with its licence.

## Install on Android

1. Open the app's https link in Chrome.
2. Menu (⋮) → **Add to Home screen** (or the **Install app** prompt) → Install.
3. It opens full screen from its own icon and works offline from then on.

## What it does

Open files (several at once) → they join the queue.  Waveform with named
sections (a guess), tap to seek, A / B markers, loop, −10 / +10 s, speed
menu.  Music: tempo (½ / ×2), key with Camelot code, loudness (LUFS, range,
peak, RMS), bars/beats/sections.  Tempo & Key: 50–150 %, target BPM,
±12 semitones, keep the voice, faster or finer engine.  Save a copy: whole
song, A–B piece or the song with A–B cut out, as WAV 16/24/32-bit float, to
Downloads; never above the file's own depth; names say only what changed.
Notes per song, favourites, playlists, recent.  **Record** (Library page):
the microphone, or a USB audio interface the phone uses as its input, into
a 24-bit WAV that joins the queue; level meter, clip warning, running clock.

Not yet: FLAC/MP3 copies, Mix Compare, spectrogram.

## Develop

Static files, no build step.  Serve the folder over http (`python -m
http.server` inside it) and open it; the service worker caches the shell on
the first visit, so after changes bump `VERSION` in `sw.js`.
