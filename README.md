# waveform-peaks

Turn a song into compact waveform data for web players: **N normalised bars, peak and RMS**, as a tiny JSON file.

- **Command line** tool and **JavaScript library**, with **zero dependencies** (Node 18.3 or newer, ESM).
- Reads **WAV** by itself: PCM 8/16/24/32-bit, float 32/64-bit, mono, stereo or multichannel, including `WAVE_FORMAT_EXTENSIBLE`.
- **MP3, M4A, FLAC** and friends: the command line uses a decoder you already have (`ffmpeg`, or `afconvert` on macOS). It never downloads anything. Otherwise use the **browser page**.
- A **browser page** ([`docs/index.html`](docs/index.html), made for GitHub Pages) that does the same in your browser with the Web Audio API. Files never leave your machine.
- **Offline and private:** no network calls at runtime, no accounts, no telemetry, nothing paid.

The bars on the Yuroka EP tracklists were made this way.

## Quick start

```sh
git clone https://github.com/yuroka-studio/waveform-peaks
cd waveform-peaks
node bin/waveform-peaks.js --bars 96 song.wav            # prints JSON
node bin/waveform-peaks.js --bars 96 --out song.json song.m4a
npm link                                                 # optional: gives you a `waveform-peaks` command
```

Example output (`waveform-peaks --bars 8 stereo-pcm16.wav`, one of the synthetic test files):

```json
{
  "file": "stereo-pcm16.wav",
  "duration": 0.25,
  "sampleRate": 8000,
  "channels": 2,
  "bars": 8,
  "peaks": [0.983, 0.978, 0.973, 1, 0.971, 0.977, 0.998, 0.995],
  "rms": [0.529, 0.526, 0.501, 0.51, 0.523, 0.513, 0.5, 0.522],
  "peakDb": -6,
  "rmsDb": -11.4
}
```

| field | meaning |
| --- | --- |
| `file` | base name of the input (never a full path) |
| `duration` | seconds, 2 decimals |
| `sampleRate`, `channels` | of the decoded audio |
| `bars` | number of bars (never more than the number of frames in the file) |
| `peaks[i]` | largest absolute sample in bar *i*, 0 to 1, 3 decimals |
| `rms[i]` | root-mean-square level in bar *i*, 0 to 1, 3 decimals |
| `peakDb` | loudest single sample in the file, dBFS, 1 decimal, **before** normalisation. `null` for silence |
| `rmsDb` | RMS level of the whole file, dBFS, 1 decimal, **before** normalisation. `null` for silence |

One input file gives a JSON **object**; several give a JSON **array** of objects.

## Command line

```
waveform-peaks [--bars 96] [--mode peak|rms] [--normalize per-file|none] [--out file.json] <files...>
```

| option | default | |
| --- | --- | --- |
| `--bars <n>` | `96` | number of bars, 1 to 10000 |
| `--mode peak\|rms` | `peak` | which series the normalisation is scaled against (see below) |
| `--normalize per-file\|none` | `per-file` | `--no-normalize` is the same as `--normalize none` |
| `--out <file.json>` | stdout | write the JSON to a file |

Exit codes: `0` ok, `1` at least one file failed (the others are still written), `2` bad usage.

### How the numbers are made

1. **Downmix.** Every frame becomes the plain average of all its channels (stereo: `(L + R) / 2`). Out-of-phase stereo therefore cancels in the bars. `peakDb` and `rmsDb` are measured on the individual channels, not on the downmix.
2. **Bars.** Frame *f* belongs to bar `floor(f * bars / totalFrames)`, so every frame is used exactly once and bars never come out empty.
3. **Per bar.** `peaks` is the maximum absolute value, `rms` is `sqrt(mean(x²))`.
4. **Normalisation.** With `--normalize per-file`, both series are multiplied by one factor so that the loudest bar of the *reference series* is exactly `1.0`; values are clamped to 1.
   - `--mode peak` (default): reference is the loudest peak bar. `peaks` tops out at 1.0, and `rms` keeps its relation to it.
   - `--mode rms`: reference is the loudest RMS bar. `rms` tops out at 1.0, and most `peaks` clamp to 1.0.
   - `--normalize none`: nothing is scaled, so a full-scale square wave is `1.0`, and a full-scale sine has `rms ≈ 0.707`.
5. **Rounding.** Bars to 3 decimals, dB values to 1 decimal.

Which series to draw? Real masters are limited and loud, so the *peak* of nearly every 2-second bar sits close to full scale and the `peaks` bars look like a flat wall. The `rms` bars follow the music's loudness, which is what most players want to show. Use `--mode rms` and draw `rms`: that reproduces the look of the bars on the Yuroka tracklists.

### Other formats (MP3, M4A, FLAC, ...)

The command line decodes WAV itself. For anything else it looks for a decoder that is **already installed**, in this order, and asks it for a temporary WAV (deleted afterwards):

1. `ffmpeg` on your `PATH`
2. `/usr/bin/afconvert` (macOS, built in; handles AAC/M4A, MP3 and FLAC)

It never downloads or installs anything (see [Security](#security) for how the decoder is started). If neither exists it stops with a message that points to the browser page. A temporary 32-bit float WAV keeps the channel count and sample rate of the source.

## Browser page

Open `docs/index.html` through any static web server (browsers do not load ES modules from `file://`):

```sh
node scripts/serve-docs.mjs      # http://127.0.0.1:8080/
```

or enable **GitHub Pages** for the `docs/` folder of your fork and open that URL. Drop or choose audio files, pick the number of bars and the mode, see the bars, then copy or download the JSON.

- Decoding uses `AudioContext.decodeAudioData`, then the **same algorithm** as the command line: [`docs/peaks.js`](docs/peaks.js) is one ES module imported by both. It lives in `docs/` because GitHub Pages only serves that folder.
- **Nothing is uploaded.** The page is static HTML, CSS and JS with no build step, no CDN and no external requests, and a strict Content-Security-Policy (`default-src 'none'`, `connect-src 'none'`) makes the browser enforce it.
- Browsers resample to the audio device rate while decoding, so `sampleRate` (and a few thousandths in the bars) can differ from the command line's numbers for the same file.
- Dark, keyboard-friendly, labelled controls, visible focus, and no motion when you ask your system for reduced motion.

## Render the bars as SVG

Framework free: one function, no dependencies. `progress` (0 to 1) fills the played part.

<!-- snippet: bars-svg -->
```js
function barsSvg(peaks, { width = 600, height = 64, gap = 2, progress = 0, base = "#4b4b6b", fill = "#5fd0c4" } = {}) {
  const n = peaks.length;
  const w = (width - gap * (n - 1)) / n;
  const bars = peaks.map((p, i) => {
    const h = Math.max(2, p * height);
    const color = (i + 0.5) / n < progress ? fill : base;
    return `<rect x="${(i * (w + gap)).toFixed(2)}" y="${((height - h) / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(w / 2, 2)}" fill="${color}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Waveform">${bars.join("")}</svg>`;
}
```

Use it with an `<audio>` element: draw once, redraw while it plays, click to seek.

```html
<div id="wave"></div>
<audio id="song" src="song.m4a" controls></audio>
<script type="module">
  const { rms } = await (await fetch("song.json")).json();
  const box = document.getElementById("wave");
  const audio = document.getElementById("song");
  const draw = () => (box.innerHTML = barsSvg(rms, { progress: audio.currentTime / (audio.duration || 1) }));
  audio.addEventListener("timeupdate", draw);
  box.addEventListener("click", (e) => {
    if (!Number.isFinite(audio.duration)) return; // metadata has not loaded yet
    const x = e.clientX - box.getBoundingClientRect().left; // measured from the box, whichever bar was clicked
    audio.currentTime = (x / box.clientWidth) * audio.duration;
  });
  draw();
</script>
```

(`barsSvg` is the function above.) A mirrored look, as on the browser page, is a matter of drawing each bar twice; the data is the same.

## Library

```js
import { analyzeFile, analyze } from "waveform-peaks";

// from a file: WAV, or anything an installed ffmpeg/afconvert can decode
const result = await analyzeFile("song.wav", { bars: 96, mode: "rms", normalize: "per-file" });

// from samples you already have (e.g. AudioBuffer.getChannelData in a browser)
const same = analyze({ channels: [left, right], sampleRate: 44100 }, { bars: 96 });
```

`waveform-peaks/peaks` exports only the algorithm (`analyze`, the streaming `Analyzer`, `downmixToMono`, and `formatJson`, which prints the result with each bar array on one line) and runs in a browser as well. Other exports: `decodeWav`, `readHeader`, `readChunks`, `findDecoder`, `withDecodedWav`.

WAV files are read in blocks, so long files do not have to fit in memory.

## Security

Audio files can come from anywhere, so the command line treats them as untrusted when it hands them to another program:

- **No shell.** The only process the tool ever starts is `ffmpeg` or `afconvert`, through `execFile` with an argument array. File names are never put into a command string.
- **No option injection.** The input is resolved to an absolute path first, so a file called `-something.mp3` cannot be read as a flag.
- **ffmpeg is limited to local files.** It runs with `-protocol_whitelist file` and the input is passed as `file:<absolute path>`, so it can neither treat the name as a URL nor open `http`, `tcp`, `pipe`, `concat:` or any other protocol.
- **ffmpeg is limited to plain audio demuxers.** It also runs with `-format_whitelist mp3,mov,mp4,m4a,3gp,3g2,mj2,flac,ogg,wav,aiff,aac,matroska,webm,caf`. Both whitelists are input options, so they come before `-i`. Playlist-style demuxers (HLS/M3U8, `concat`, DASH, SDP and the like) are not on the list, so ffmpeg's content probe cannot choose them, whatever the file is called or starts with. A crafted `song.mp3` that is really a playlist is therefore rejected by ffmpeg itself. (Formats outside the list, such as WMA/ASF, need the browser page or a conversion to WAV first.)
- **A signature check refuses playlists earlier still.** Before ffmpeg or afconvert is started, the first 64 KiB after any ID3v2 tag (several in a row are skipped, as ffmpeg does) is searched for `#EXTM3U`, `#EXT-X-`, `#EXTINF`, `ffconcat`, `[playlist]`, `<MPD` and `<asx` (the last two only as a real tag, followed by a space, `>` or `/`, so that compressed audio is not refused by chance), with any bytes, including non-ASCII ones, around them, and checked for a leading `<?xml` or SDP header. A match is refused with a clear message, and the decoder is never run. XML found further inside a file (iXML in a broadcast WAV, XMP in a FLAC) is normal and is not a match. Files that the built-in WAV decoder reads are not scanned at all, because no other program ever sees them. This check is an extra layer, not the defence: the whitelist above is. Directories and other non-regular files are refused too.
- **Temporary files** go into a private folder created with `mkdtemp`, and are removed even when decoding fails, and when you stop the tool with Ctrl-C or `kill` (SIGINT / SIGTERM: the decoder is stopped and the folder deleted before the tool exits). Only SIGKILL or a power cut can leave one behind. A decoder run is killed after 10 minutes. The size of the decoded temporary WAV is not capped, so a hostile file that expands enormously can use a lot of disk space until then; if that matters to you, convert untrusted files yourself first.

The built-in WAV decoder reads in blocks of at most about 8 MB and never allocates by a size declared in the header, so a hostile WAV cannot make it exhaust memory. The browser page decodes with the browser's own audio stack inside a strict Content-Security-Policy.

## Tests

```sh
npm test      # node --test, Node 18, 20 and 22 in CI
```

The test files in `test/fixtures` are **synthetic**: tones, square waves, silence and seeded noise written by [`scripts/make-fixtures.mjs`](scripts/make-fixtures.mjs) (`npm run fixtures` regenerates them byte for byte). No recordings are included. The tests cover every bit depth and format, `WAVE_FORMAT_EXTENSIBLE`, odd-sized chunks, streaming-style data sizes, the bar maths (silence is zeros, a full-scale square is 1.0, a sine's RMS is 0.707, stereo downmix), the command line, decoder discovery, and the README snippet above.

## Not included

- No AIFF, Ogg or MP3 decoder of its own (use ffmpeg/afconvert, or the browser page).
- No A-law/μ-law/ADPCM or RF64 WAV in the built-in decoder (they go to an installed ffmpeg if there is one).
- No true-peak (inter-sample) or loudness (LUFS) measurement: `peakDb` is the sample peak.

## License

MIT, © Yuroka Studio. See [LICENSE](LICENSE).

---

## Türkçe

**waveform-peaks**, bir şarkıyı web oynatıcıları için küçük bir dalga biçimi verisine çevirir: normalize edilmiş **N çubuk** (tepe ve RMS), tek bir JSON dosyası olarak.

- Komut satırı aracı ve JavaScript kütüphanesi; **hiç bağımlılığı yok** (Node 18.3+).
- **WAV** dosyalarını kendisi okur (8/16/24/32 bit tamsayı, 32/64 bit kayan nokta, mono/stereo/çok kanallı). MP3, M4A ve FLAC için bilgisayarınızda zaten kurulu olan `ffmpeg` ya da macOS'taki `afconvert` kullanılır; **hiçbir şey indirilmez**. Bunlar yoksa tarayıcı sayfasını kullanın.
- `docs/index.html`: ses dosyalarını **tarayıcınızda** (Web Audio API) çözüp aynı algoritmayla çubukları hesaplar. **Hiçbir dosya yüklenmez**, ağ isteği yapılmaz.
- Ücretli hizmet, hesap, ölçüm veya telemetri yoktur.

Kullanım:

```sh
node bin/waveform-peaks.js --bars 96 --mode rms --out sarki.json sarki.wav
```

Gerçek müzikte her çubuğun *tepe* değeri neredeyse hep tam ölçeğe yakındır; çizim için genelde `--mode rms` ve `rms` dizisi daha canlı görünür. Çubukları SVG olarak çizmek için yukarıdaki `barsSvg` işlevini kullanabilirsiniz. Lisans: MIT, © Yuroka Studio.
