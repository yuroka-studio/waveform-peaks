// Optional decoding of MP3 / M4A / FLAC / ... through a decoder that is already
// installed on this machine. Nothing is downloaded and nothing is installed:
// we look for `ffmpeg` on PATH, then (macOS) /usr/bin/afconvert, and ask it to
// write a temporary WAV, which the built-in decoder then reads.
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
          // float32 keeps lossy decoder output that overshoots full scale; channels and rate are left as they are
          args: (input, output) => ["-nostdin", "-v", "error", "-i", input, "-map", "0:a:0", "-vn", "-c:a", "pcm_f32le", "-f", "wav", "-y", output],
        };
      }
    }
  }
  if (platform === "darwin" && isExec("/usr/bin/afconvert")) {
    return {
      name: "afconvert",
      bin: "/usr/bin/afconvert",
      args: (input, output) => ["-f", "WAVE", "-d", "LEF32", input, output],
    };
  }
  return null;
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "waveform-peaks-"));
  try {
    const out = path.join(dir, "decoded.wav");
    await new Promise((resolve, reject) => {
      execFile(decoder.bin, decoder.args(file, out), { timeout: 10 * 60 * 1000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) reject(new DecoderFailedError(decoder.name, file, (stderr || err.message).toString().trim().split("\n").slice(-2).join(" ")));
        else resolve();
      });
    });
    return await fn(out);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
