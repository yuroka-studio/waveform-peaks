// Generates the synthetic test fixtures: tones, square waves, silence and seeded noise.
// Nothing here is a recording; every byte comes from the formulas below, so the files
// are identical on every run.   Usage: node scripts/make-fixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_RATE = 8000;
export const FRAMES = 2000; // 0.25 s

/** Small seeded PRNG (mulberry32), values in [0, 1). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ideal signals, as float64 per channel. Tests compare decoded files against these. */
export const signals = {
  sine: (amp, hz = 400) => (frames = FRAMES) => Float64Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)),
  square: (amp, period = 20) => (frames = FRAMES) => Float64Array.from({ length: frames }, (_, i) => (i % period < period / 2 ? amp : -amp)),
  silence: () => (frames = FRAMES) => new Float64Array(frames),
  noise: (amp, seed) => (frames = FRAMES) => {
    const r = prng(seed);
    return Float64Array.from({ length: frames }, () => amp * (r() * 2 - 1));
  },
  constant: (v) => (frames = FRAMES) => new Float64Array(frames).fill(v),
};

const GUID_TAIL = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Interleave and quantise channels (float64 arrays) into WAV sample bytes. */
function samplesBytes(channels, kind, bits) {
  const frames = channels[0].length;
  const bps = bits / 8;
  const out = Buffer.alloc(frames * channels.length * bps);
  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const x = Math.max(-1, Math.min(1, ch[i]));
      if (kind === "float") {
        if (bits === 32) out.writeFloatLE(x, p);
        else out.writeDoubleLE(x, p);
      } else if (bits === 8) out.writeUInt8(Math.round(x * 127) + 128, p);
      else if (bits === 16) out.writeInt16LE(Math.round(x * 32767), p);
      else if (bits === 24) {
        const v = Math.round(x * 8388607);
        out.writeUIntLE(v < 0 ? v + 0x1000000 : v, p, 3);
      } else out.writeInt32LE(Math.round(x * 2147483647), p);
      p += bps;
    }
  }
  return out;
}

/**
 * Build a WAV file.
 * @param {Float64Array[]} channels
 * @param {{kind?: "pcm"|"float", bits?: number, extensible?: boolean, beforeData?: Buffer[], streaming?: boolean, dataSizeExtra?: number}} o
 */
export function makeWav(channels, { kind = "pcm", bits = 16, extensible = false, beforeData = [], streaming = false, dataSizeExtra = 0 } = {}) {
  const C = channels.length;
  const bps = bits / 8;
  const tag = kind === "float" ? 3 : 1;
  const fmt = Buffer.alloc(extensible ? 40 : 16);
  fmt.writeUInt16LE(extensible ? 0xfffe : tag, 0);
  fmt.writeUInt16LE(C, 2);
  fmt.writeUInt32LE(SAMPLE_RATE, 4);
  fmt.writeUInt32LE(SAMPLE_RATE * C * bps, 8);
  fmt.writeUInt16LE(C * bps, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) {
    fmt.writeUInt16LE(22, 16); // cbSize
    fmt.writeUInt16LE(bits, 18); // valid bits
    fmt.writeUInt32LE(C === 2 ? 3 : C === 1 ? 4 : 0x3f, 20); // channel mask
    fmt.writeUInt16LE(tag, 24);
    GUID_TAIL.copy(fmt, 26);
  }
  const data = samplesBytes(channels, kind, bits);
  const dataChunk = chunk("data", data);
  if (streaming) dataChunk.writeUInt32LE(0xffffffff, 4);
  else if (dataSizeExtra) dataChunk.writeUInt32LE(data.length + dataSizeExtra, 4);
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), chunk("fmt ", fmt), ...beforeData, dataChunk]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(streaming ? 0xffffffff : body.length, 4);
  return Buffer.concat([head, body]);
}

/** name -> {signal: () => Float64Array[], options, bytes()} */
export const specs = (() => {
  const s = {};
  const add = (name, channels, options) => {
    s[name] = { channels, options, bytes: () => makeWav(channels.map((f) => f()), options) };
  };
  const tone = signals.sine(0.8);
  for (const bits of [8, 16, 24, 32]) add(`sine-pcm${bits}-mono`, [tone], { kind: "pcm", bits });
  for (const bits of [32, 64]) add(`sine-float${bits}-mono`, [tone], { kind: "float", bits });
  add("stereo-pcm16", [signals.sine(0.5), signals.noise(0.25, 7)], { kind: "pcm", bits: 16 });
  add("stereo-pcm24", [signals.sine(0.5, 300), signals.square(0.25)], { kind: "pcm", bits: 24 });
  add("multi6-float32", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((v) => signals.constant(v)), { kind: "float", bits: 32 });
  add("extensible-pcm24-stereo", [signals.sine(0.6, 250), signals.sine(0.3, 500)], { kind: "pcm", bits: 24, extensible: true });
  add("extensible-float32-mono", [signals.sine(0.7, 350)], { kind: "float", bits: 32, extensible: true });
  add("extensible-pcm16-6ch", [0.05, 0.15, 0.25, 0.35, 0.45, 0.55].map((v) => signals.constant(v)), { kind: "pcm", bits: 16, extensible: true });
  // a LIST chunk with an odd size (so it is followed by a pad byte) and a 'fact' chunk before the data
  add("list-chunk-pcm16", [signals.sine(0.5)], {
    kind: "pcm",
    bits: 16,
    beforeData: [chunk("LIST", Buffer.from("INFOISFT\x05\x00\x00\x00synth", "latin1")), chunk("fact", Buffer.from([0xd0, 0x07, 0, 0]))],
  });
  add("streaming-sizes-pcm16", [signals.sine(0.5)], { kind: "pcm", bits: 16, streaming: true });
  add("data-size-too-big-pcm16", [signals.sine(0.5)], { kind: "pcm", bits: 16, dataSizeExtra: 100000 });
  add("square-fullscale-pcm16", [signals.square(1)], { kind: "pcm", bits: 16 });
  add("square-fullscale-float32", [signals.square(1)], { kind: "float", bits: 32 });
  add("silence-pcm16", [signals.silence()], { kind: "pcm", bits: 16 });
  add("noise-pcm16", [signals.noise(0.9, 42)], { kind: "pcm", bits: 16 });
  return s;
})();

export function buildFixtures() {
  return new Map(Object.entries(specs).map(([name, spec]) => [`${name}.wav`, spec.bytes()]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of buildFixtures()) fs.writeFileSync(path.join(dir, name), bytes);
  console.log(`wrote ${Object.keys(specs).length} fixtures to test/fixtures`);
}
