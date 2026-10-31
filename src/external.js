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
//   * files that are plain text (HLS/M3U8, ffconcat, PLS, SDP, DASH/XML playlists ...) are refused before
//     any decoder runs: real audio is binary, and playlist-style demuxers are how a crafted file would
//     make a decoder reach for other URLs or local files.
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
        `(docs/index.html in this repository, also published on GitHub Pages), which decodes MP3/M4A/FLAC locally in your browser.`,
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
export function findDecoder({ env = process.env, platform = process.platform, isExec = isExecutable } = {}) {
  const exts = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `ffmpeg${ext}`);
      if (isExec(candidate)) {
        return {
          name: "ffmpeg",
          bin: candidate,
          // `input` is already absolute. "file:" pins the file protocol, and the whitelist (an input option, so it must
          // come before -i) forbids every other one. Float32 keeps lossy decoder output that overshoots full scale;
          // channels and sample rate are left as they are.
          args: (input, output) => [
            "-nostdin", "-v", "error",
            "-protocol_whitelist", "file",
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

/**
 * Refuse anything that is not a regular, binary file. Playlists and other text formats are the way a crafted
 * "song.mp3" would steer a decoder to fetch URLs or read other local files, and no audio container is plain text.
 */
export async function assertSafeInput(file) {
  const st = await fs.promises.stat(file); // ENOENT surfaces as-is
  if (!st.isFile()) throw new UnsafeInputError(file, "it is not a regular file.");
  const fh = await fs.promises.open(file, "r");
  try {
    const head = Buffer.alloc(512);
    const { bytesRead } = await fh.read(head, 0, 512, 0);
    const text = bytesRead > 0 && head.subarray(0, bytesRead).every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
    if (text) {
      throw new UnsafeInputError(file, "it is a plain text file (a playlist or similar), not audio. Playlists can point a decoder at other files or URLs, so they are never passed on.");
    }
  } finally {
    await fh.close();
  }
}

/**
 * Decode `file` to a temporary WAV and call `fn(wavPath)`. The temp folder is always removed.
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "waveform-peaks-"));
  try {
    const out = path.join(dir, "decoded.wav");
    await new Promise((resolve, reject) => {
      execFile(decoder.bin, decoder.args(input, out), { shell: false, timeout: 10 * 60 * 1000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new DecoderFailedError(decoder.name, file, (stderr || err.message).toString().trim().split("\n").slice(-2).join(" ")));
        else resolve();
      });
    });
    return await fn(out);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
