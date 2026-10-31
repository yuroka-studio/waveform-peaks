// Optional decoding of MP3 / M4A / FLAC / ... through a decoder that is already
// installed on this machine. Nothing is downloaded and nothing is installed:
// we look for `ffmpeg` on PATH, then (macOS) /usr/bin/afconvert, and ask it to
// write a temporary WAV, which the built-in decoder then reads.
//
// Hardening (the input file is untrusted):
//   * processes are started with execFile and an argument array: there is no shell anywhere;
//   * the input is resolved to an absolute path, so a name like "-x.mp3" can never become an option
//     (afconvert has no "--" separator, absolute paths are how it is made safe);
//   * ffmpeg gets "-protocol_whitelist file" and the input as "file:<absolute path>", so it can
//     neither parse the name as a URL nor open network (or pipe, concat:, ...) protocols;
//   * ffmpeg also gets "-format_whitelist" with plain audio demuxers only. That is the real defence against
//     playlist-style inputs (HLS/M3U8, ffconcat, DASH, SDP ...) that make a decoder open other URLs or local
//     files: ffmpeg's content probe is not allowed to pick them, whatever the file is called or starts with;
//   * on top of that, a signature check refuses files that look like such playlists before an external decoder
//     starts (files the built-in WAV decoder reads never reach one, so they are not scanned);
//   * the temporary WAV lives in a private folder that is removed when decoding ends, fails, or the process is
//     interrupted with SIGINT / SIGTERM.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class NoDecoderError extends Error {
  constructor(file) {
    super(
      `Cannot decode "${path.basename(file)}": the command line tool reads WAV natively, and for other formats ` +
        `it uses a decoder that is already installed (ffmpeg on PATH, or afconvert on macOS). None was found, ` +
        `and nothing is ever downloaded. Either convert the file to WAV, or open the browser page ` +
        `(docs/index.html in the source repository; run "node scripts/serve-docs.mjs" there to serve it), which decodes MP3/M4A/FLAC locally in your browser.`,
    );
    this.name = "NoDecoderError";
  }
}

export class UnsafeInputError extends Error {
  constructor(file, why) {
    super(`Refusing to decode "${path.basename(file)}": ${why}`);
    this.name = "UnsafeInputError";
  }
}

export class DecoderFailedError extends Error {
  constructor(decoder, file, detail) {
    super(`${decoder} could not decode "${path.basename(file)}"${detail ? `: ${detail}` : ""}`);
    this.name = "DecoderFailedError";
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Find a decoder that is already on this machine. Pure lookup, nothing is run. */
/** Demuxers ffmpeg may use: plain audio containers that never open nested files. Everything else (hls, concat, dash, sdp ...) is off. */
export const FFMPEG_FORMAT_WHITELIST = "mp3,mov,mp4,m4a,3gp,3g2,mj2,flac,ogg,wav,aiff,aac,matroska,webm,caf";

export function findDecoder({ env = process.env, platform = process.platform, isExec = isExecutable } = {}) {
  const exts = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `ffmpeg${ext}`);
      if (isExec(candidate)) {
        return {
          name: "ffmpeg",
          bin: candidate,
          // `input` is already absolute. "file:" pins the file protocol, and the two whitelists (input options, so they
          // must come before -i) forbid every other protocol and every demuxer that is not a plain audio container. Float32 keeps lossy decoder output that overshoots full scale;
          // channels and sample rate are left as they are.
          args: (input, output) => [
            "-nostdin", "-v", "error",
            "-protocol_whitelist", "file",
            "-format_whitelist", FFMPEG_FORMAT_WHITELIST,
            "-i", `file:${input}`,
            "-map", "0:a:0", "-vn", "-sn", "-dn",
            "-c:a", "pcm_f32le", "-f", "wav", "-y", output,
          ],
        };
      }
    }
  }
  if (platform === "darwin" && isExec("/usr/bin/afconvert")) {
    return {
      name: "afconvert",
      bin: "/usr/bin/afconvert",
      // `input` is absolute, so it starts with "/" and can never be read as an option
      args: (input, output) => ["-f", "WAVE", "-d", "LEF32", input, output],
    };
  }
  return null;
}

const PLAYLIST_WINDOW = 64 * 1024;
// Text that only playlist-style inputs contain. Matched anywhere in the window, case-insensitively, with any
// bytes (including non-ASCII ones) around it. "<?xml" and SDP are matched at the start of the content only:
// real audio files (BWF/iXML in a WAV, XMP in a FLAC or MP4) legitimately carry XML further in.
const PLAYLIST_SIGNATURES = ["#extm3u", "#ext-x-", "#extinf", "ffconcat", "[playlist]"];
// The XML roots of DASH (<MPD ...>) and ASX (<asx ...>) are only four characters, which random compressed audio
// contains now and then. A real tag name ends with whitespace, ">" or "/", so require that as well.
const XML_PLAYLIST_ROOT = /<(?:mpd|asx)[ \t\r\n>/]/;

/** @param {Buffer} window the first bytes of the audio data, after any ID3v2 tag @returns {string|null} what matched */
export function looksLikePlaylist(window) {
  const text = window.toString("latin1").toLowerCase();
  for (const sig of PLAYLIST_SIGNATURES) if (text.includes(sig)) return sig;
  const root = text.match(XML_PLAYLIST_ROOT);
  if (root) return root[0].slice(0, 4);
  const start = text.replace(/^\u00ef\u00bb\u00bf/, "").replace(/^\s+/, "");
  if (start.startsWith("<?xml")) return "<?xml";
  if (/^v=0\r?\n/.test(start)) return "v=0 (SDP)";
  return null;
}

/** Length in bytes of the ID3v2 tag at the start of `head` (header, body and footer), or 0 if there is none. */
function id3v2Length(head) {
  if (head.length < 10 || head.toString("latin1", 0, 3) !== "ID3" || head[3] === 0xff || head[4] === 0xff) return 0;
  if ((head[6] | head[7] | head[8] | head[9]) & 0x80) return 0; // size bytes are 7-bit "syncsafe"
  const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
  return 10 + size + (head[5] & 0x10 ? 10 : 0);
}

/** Refuse directories and other non-regular files (a FIFO or device could block the open that follows). ENOENT surfaces as-is. */
export async function assertRegularFile(file) {
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw new UnsafeInputError(file, "it is not a regular file.");
}

/**
 * assertRegularFile, plus: refuse files that look like playlists. This is the check that runs before an external
 * decoder starts. ffmpeg skips ID3v2 tags while probing, so a playlist can hide behind one: skip them here too
 * (also several in a row).
 */
export async function assertSafeInput(file) {
  await assertRegularFile(file);
  const fh = await fs.promises.open(file, "r");
  try {
    let pos = 0;
    for (let i = 0; i < 16; i++) {
      const head = Buffer.alloc(10);
      const { bytesRead } = await fh.read(head, 0, 10, pos);
      const len = id3v2Length(head.subarray(0, bytesRead));
      if (len === 0) break;
      pos += len;
    }
    const buf = Buffer.alloc(PLAYLIST_WINDOW);
    const { bytesRead } = await fh.read(buf, 0, PLAYLIST_WINDOW, pos);
    const hit = looksLikePlaylist(buf.subarray(0, bytesRead));
    if (hit) {
      throw new UnsafeInputError(file, `it looks like a playlist or manifest (found "${hit}"), not audio. Those can point a decoder at other files or URLs, so they are never passed on.`);
    }
  } finally {
    await fh.close();
  }
}

// Decodes that are running right now: { dir, child }. While there are any, SIGINT and SIGTERM must not leave the
// (possibly huge) decoded WAV behind, because a `finally` block does not run when a signal ends the process.
const running = new Set();
const INTERRUPTS = ["SIGINT", "SIGTERM"];
const interruptHandlers = INTERRUPTS.map((signal) => [signal, () => onInterrupt(signal)]);

function removeDir(dir) {
  // retries cover the instant between SIGKILL and the decoder really being gone
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function onInterrupt(signal) {
  for (const job of running) {
    job.child?.kill("SIGKILL");
    try {
      removeDir(job.dir);
    } catch {
      // nothing more to do about it
    }
  }
  running.clear();
  for (const [name, handler] of interruptHandlers) process.removeListener(name, handler);
  // Installing a handler switched off Node's default "die on Ctrl-C". Put that back, unless the application has handlers of its own.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function track(job) {
  if (running.size === 0) for (const [name, handler] of interruptHandlers) process.on(name, handler);
  running.add(job);
}

function untrack(job) {
  running.delete(job);
  if (running.size === 0) for (const [name, handler] of interruptHandlers) process.removeListener(name, handler);
}

/**
 * Decode `file` to a temporary WAV and call `fn(wavPath)`. The temp folder is removed afterwards, also when decoding
 * fails and when the process is stopped with SIGINT / SIGTERM (not with SIGKILL, which nothing can catch).
 * @template T
 * @param {string} file
 * @param {(wavPath: string) => Promise<T>} fn
 * @param {{decoder?: ReturnType<typeof findDecoder>}} [options]
 * @returns {Promise<T>}
 */
export async function withDecodedWav(file, fn, { decoder = findDecoder() } = {}) {
  if (!decoder) throw new NoDecoderError(file);
  await assertSafeInput(file);
  const input = path.resolve(file);
  const job = { dir: await fs.promises.mkdtemp(path.join(os.tmpdir(), "waveform-peaks-")), child: null };
  track(job);
  try {
    const out = path.join(job.dir, "decoded.wav");
    await new Promise((resolve, reject) => {
      job.child = execFile(decoder.bin, decoder.args(input, out), { shell: false, timeout: 10 * 60 * 1000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new DecoderFailedError(decoder.name, file, (stderr || err.message).toString().trim().split("\n").slice(-2).join(" ")));
        else resolve();
      });
    });
    return await fn(out);
  } finally {
    untrack(job);
    await fs.promises.rm(job.dir, { recursive: true, force: true });
  }
}
