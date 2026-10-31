// Zero-dependency WAV decoder.
//
// Reads PCM 8/16/24/32-bit integer and IEEE float 32/64-bit, any channel count,
// including WAVE_FORMAT_EXTENSIBLE. It walks the RIFF chunks (odd-sized chunks are
// padded, LIST/fact/etc. before "data" are skipped) and works in blocks, so a long
// file never has to fit in memory at once.
import fs from "node:fs/promises";

export class WavError extends Error {
  /** @param {string} message @param {"INVALID"|"UNSUPPORTED"|"NOT_WAV"} code */
  constructor(message, code = "INVALID") {
    super(message);
    this.name = "WavError";
    this.code = code;
  }
}

const TAG_PCM = 0x0001;
const TAG_FLOAT = 0x0003;
const TAG_EXTENSIBLE = 0xfffe;

/** A random-access byte source over a Buffer. */
export function bufferSource(buf) {
  return { size: buf.length, read: async (pos, len) => buf.subarray(pos, Math.min(buf.length, pos + len)) };
}

/** A random-access byte source over a file; call close() when done. */
export async function fileSource(path) {
  const fh = await fs.open(path, "r");
  const { size } = await fh.stat();
  return {
    size,
    async read(pos, len) {
      const out = Buffer.allocUnsafe(Math.max(0, Math.min(len, size - pos)));
      const { bytesRead } = await fh.read(out, 0, out.length, pos);
      return out.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}

/**
 * Parse the header. Returns what a decoder needs to stream the samples.
 * @returns {Promise<{kind:"pcm"|"float", bytesPerSample:number, channels:number, sampleRate:number, blockAlign:number, dataOffset:number, dataBytes:number, frames:number}>}
 */
export async function readHeader(source) {
  const head = await source.read(0, 12);
  if (head.length < 12) throw new WavError("not a WAV file (too short)", "NOT_WAV");
  const magic = head.toString("latin1", 0, 4);
  if (magic === "RF64" || magic === "BW64") {
    throw new WavError(`${magic} files are not supported by the built-in decoder`, "UNSUPPORTED");
  }
  if (magic !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") throw new WavError("not a WAV file (no RIFF/WAVE header)", "NOT_WAV");

  let fmt = null;
  let pos = 12;
  while (pos + 8 <= source.size) {
    const ch = await source.read(pos, 8);
    const id = ch.toString("latin1", 0, 4);
    const size = ch.readUInt32LE(4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16) throw new WavError("fmt chunk is too short");
      fmt = parseFmt(await source.read(body, Math.min(size, 40)), size);
    } else if (id === "data") {
      if (!fmt) throw new WavError("data chunk comes before the fmt chunk");
      // Streaming writers (ffmpeg to a pipe, some recorders) leave 0xFFFFFFFF or a size bigger than the file.
      const dataBytes = Math.min(size, source.size - body);
      const frames = Math.floor(dataBytes / fmt.blockAlign);
      if (frames < 1) throw new WavError("the file contains no audio frames");
      return { ...fmt, dataOffset: body, dataBytes: frames * fmt.blockAlign, frames };
    }
    pos = body + size + (size & 1); // chunks are word-aligned: an odd size is followed by one pad byte
  }
  throw new WavError(fmt ? "no data chunk found" : "no fmt chunk found");
}

function parseFmt(b, size) {
  if (b.length < 16) throw new WavError("fmt chunk is cut off");
  let tag = b.readUInt16LE(0);
  const channels = b.readUInt16LE(2);
  const sampleRate = b.readUInt32LE(4);
  const blockAlign = b.readUInt16LE(12);
  const bits = b.readUInt16LE(14);
  if (tag === TAG_EXTENSIBLE) {
    if (size < 40 || b.length < 26) throw new WavError("WAVE_FORMAT_EXTENSIBLE fmt chunk is too short");
    tag = b.readUInt16LE(24); // first two bytes of the sub-format GUID are the plain format tag
  }
  if (tag !== TAG_PCM && tag !== TAG_FLOAT) {
    throw new WavError(`unsupported WAV encoding (format tag 0x${tag.toString(16).padStart(4, "0")})`, "UNSUPPORTED");
  }
  if (channels < 1) throw new WavError("the file declares zero channels");
  if (!(sampleRate > 0)) throw new WavError("the file declares a sample rate of zero");
  // the container size per sample comes from blockAlign when it is consistent, else from the bit depth
  let bytesPerSample = Math.ceil(bits / 8);
  if (blockAlign >= channels && blockAlign % channels === 0 && blockAlign / channels >= bytesPerSample) {
    bytesPerSample = blockAlign / channels;
  }
  const kind = tag === TAG_FLOAT ? "float" : "pcm";
  const ok = kind === "pcm" ? [1, 2, 3, 4] : [4, 8];
  if (!ok.includes(bytesPerSample)) {
    throw new WavError(`unsupported sample size: ${bits}-bit ${kind} in a ${bytesPerSample * 8}-bit container`, "UNSUPPORTED");
  }
  return { kind, bytesPerSample, channels, sampleRate, blockAlign: bytesPerSample * channels };
}

/** Convert `frames` frames starting at `offset` in `buf` into one Float32Array per channel. */
export function decodeFrames(buf, offset, frames, header) {
  const { kind, bytesPerSample: bps, channels: C, blockAlign } = header;
  const out = Array.from({ length: C }, () => new Float32Array(frames));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let c = 0; c < C; c++) {
    const dst = out[c];
    let p = offset + c * bps;
    if (kind === "float") {
      if (bps === 4) for (let i = 0; i < frames; i++, p += blockAlign) dst[i] = dv.getFloat32(p, true);
      else for (let i = 0; i < frames; i++, p += blockAlign) dst[i] = dv.getFloat64(p, true);
    } else if (bps === 1) {
      for (let i = 0; i < frames; i++, p += blockAlign) dst[i] = (dv.getUint8(p) - 128) / 128; // 8-bit WAV is unsigned
    } else if (bps === 2) {
      for (let i = 0; i < frames; i++, p += blockAlign) dst[i] = dv.getInt16(p, true) / 32768;
    } else if (bps === 3) {
      for (let i = 0; i < frames; i++, p += blockAlign) {
        dst[i] = (((dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16)) << 8) >> 8) / 8388608;
      }
    } else {
      for (let i = 0; i < frames; i++, p += blockAlign) dst[i] = dv.getInt32(p, true) / 2147483648;
    }
  }
  return out;
}

/** Async generator over the audio in blocks of up to `framesPerChunk` frames. */
export async function* readChunks(source, header, framesPerChunk = 1 << 16) {
  // at most about 8 MB of raw bytes per block, however many channels the header claims
  framesPerChunk = Math.max(1, Math.min(framesPerChunk, Math.floor((8 << 20) / header.blockAlign)));
  let done = 0;
  while (done < header.frames) {
    const want = Math.min(framesPerChunk, header.frames - done);
    const bytes = await source.read(header.dataOffset + done * header.blockAlign, want * header.blockAlign);
    const got = Math.floor(bytes.length / header.blockAlign);
    if (got < 1) throw new WavError("the file ended before the declared audio data did");
    yield decodeFrames(bytes, 0, got, header);
    done += got;
  }
}

/**
 * Decode a whole WAV held in memory (handy for tests and small files).
 * @param {Buffer|Uint8Array} bytes
 */
export async function decodeWav(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const source = bufferSource(buf);
  const header = await readHeader(source);
  const channels = Array.from({ length: header.channels }, () => new Float32Array(header.frames));
  let at = 0;
  for await (const chunk of readChunks(source, header)) {
    for (let c = 0; c < header.channels; c++) channels[c].set(chunk[c], at);
    at += chunk[0].length;
  }
  return { sampleRate: header.sampleRate, channels };
}
