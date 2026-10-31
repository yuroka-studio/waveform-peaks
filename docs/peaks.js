// waveform-peaks core: the one algorithm shared by the CLI and the browser page.
//
// It lives in docs/ because GitHub Pages only serves that folder, and the page
// imports this exact file. The CLI imports it through src/index.js. It has no
// imports and touches no Node or browser API, so it runs anywhere ES modules do.
//
// Definitions
//   mono      the plain average of all channels, frame by frame
//   bar b     the frames f with floor(f * bars / totalFrames) === b
//   peaks[b]  max |mono| inside bar b
//   rms[b]    sqrt(mean(mono^2)) inside bar b
//   peakDb    20*log10 of the largest |sample| in any channel   (dBFS, before normalisation)
//   rmsDb     20*log10 of the RMS over every sample of every channel (dBFS, before normalisation)
//   normalize "per-file": scale peaks and rms by one factor so the loudest bar of the
//             reference series (mode: "peak" or "rms") becomes 1.0; "none": no scaling.
// Values are clamped to 0..1 and rounded to 3 decimals; dB values to 1 decimal.
// Silence gives all-zero bars and null for both dB values.

export const DEFAULT_BARS = 96;
export const MAX_BARS = 10000;

// Real samples are within about +/-1. A damaged float file can hold NaN, +/-Infinity or absurd values: NaN and the
// infinities count as silence, and finite values are capped here so that squaring them can never overflow.
const SAMPLE_LIMIT = 1e30;
const cleanSample = (v) => (v > SAMPLE_LIMIT && v !== Infinity ? SAMPLE_LIMIT : v < -SAMPLE_LIMIT && v !== -Infinity ? -SAMPLE_LIMIT : 0);

const round = (x, places) => {
  const k = 10 ** places;
  return Math.round(x * k) / k;
};
const db = (amp) => (amp > 0 ? round(20 * Math.log10(amp), 1) : null);

/** Validate and normalise the user-facing options. Throws RangeError / TypeError with a readable message. */
export function resolveOptions(options = {}) {
  const bars = options.bars ?? DEFAULT_BARS;
  const mode = options.mode ?? "peak";
  const normalize = options.normalize ?? "per-file";
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) {
    throw new RangeError(`bars must be a whole number from 1 to ${MAX_BARS}, got ${bars}`);
  }
  if (mode !== "peak" && mode !== "rms") throw new TypeError(`mode must be "peak" or "rms", got ${mode}`);
  if (normalize !== "per-file" && normalize !== "none") {
    throw new TypeError(`normalize must be "per-file" or "none", got ${normalize}`);
  }
  return { bars, mode, normalize };
}

/**
 * Incremental analyser. Feed it consecutive chunks of audio, then call finish().
 * `totalFrames` must be known up front (every decoder knows it) so that bar
 * boundaries are exact, and the result does not depend on how the audio was chunked.
 */
export class Analyzer {
  constructor({ totalFrames, sampleRate, channels, bars = DEFAULT_BARS }) {
    if (!Number.isInteger(totalFrames) || totalFrames < 1) throw new RangeError("the audio has no frames");
    if (!Number.isInteger(channels) || channels < 1) throw new RangeError("the audio has no channels");
    if (!(sampleRate > 0)) throw new RangeError("sampleRate must be positive");
    resolveOptions({ bars });
    this.totalFrames = totalFrames;
    this.sampleRate = sampleRate;
    this.channels = channels;
    // never more bars than frames, so every bar holds at least one frame
    this.bars = Math.min(bars, totalFrames);
    this.peak = new Float64Array(this.bars);
    this.sumSq = new Float64Array(this.bars);
    this.count = new Float64Array(this.bars);
    this.frame = 0; // next frame index
    this.bar = 0; // bar the next frame belongs to
    this.nextStart = Math.ceil(((this.bar + 1) * totalFrames) / this.bars);
    this.maxAbs = 0;
    this.sumSqAll = 0;
  }

  /** @param {Float32Array[]} chunk one array per channel, all the same length */
  push(chunk) {
    if (chunk.length !== this.channels) throw new RangeError(`expected ${this.channels} channels, got ${chunk.length}`);
    const n = chunk[0].length;
    if (this.frame + n > this.totalFrames) throw new RangeError("more frames than totalFrames");
    const C = this.channels;
    const { peak, sumSq, count, totalFrames, bars } = this;
    let { bar, nextStart, maxAbs, sumSqAll } = this;
    for (let i = 0; i < n; i++) {
      const f = this.frame + i;
      while (f >= nextStart) {
        bar++;
        nextStart = Math.ceil(((bar + 1) * totalFrames) / bars);
      }
      let sum = 0;
      for (let c = 0; c < C; c++) {
        let v = chunk[c][i];
        if (!(v >= -SAMPLE_LIMIT && v <= SAMPLE_LIMIT)) v = cleanSample(v); // NaN, Infinity or huge, in a damaged float file
        sum += v;
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
        sumSqAll += v * v;
      }
      const m = sum / C;
      const am = m < 0 ? -m : m;
      if (am > peak[bar]) peak[bar] = am;
      sumSq[bar] += m * m;
      count[bar]++;
    }
    this.frame += n;
    this.bar = bar;
    this.nextStart = nextStart;
    this.maxAbs = maxAbs;
    this.sumSqAll = sumSqAll;
  }

  /** @returns {{duration:number,sampleRate:number,channels:number,bars:number,peaks:number[],rms:number[],peakDb:number|null,rmsDb:number|null}} */
  finish(options = {}) {
    const { mode, normalize } = resolveOptions({ ...options, bars: this.bars });
    if (this.frame !== this.totalFrames) {
      throw new RangeError(`expected ${this.totalFrames} frames, received ${this.frame}`);
    }
    const peaks = Array.from(this.peak);
    const rms = Array.from(this.sumSq, (s, b) => Math.sqrt(s / this.count[b]));
    let scale = 1;
    if (normalize === "per-file") {
      const ref = Math.max(...(mode === "rms" ? rms : peaks));
      if (ref > 0) scale = 1 / ref;
    }
    const finalise = (x) => round(Math.min(1, x * scale), 3);
    return {
      duration: round(this.totalFrames / this.sampleRate, 2),
      sampleRate: this.sampleRate,
      channels: this.channels,
      bars: this.bars,
      peaks: peaks.map(finalise),
      rms: rms.map(finalise),
      peakDb: db(this.maxAbs),
      rmsDb: db(Math.sqrt(this.sumSqAll / (this.totalFrames * this.channels))),
    };
  }
}

/**
 * One-shot helper: the browser page passes AudioBuffer.getChannelData() arrays,
 * the CLI passes decoded WAV chunks through Analyzer directly. Same maths.
 * @param {{channels: Float32Array[], sampleRate: number}} audio
 */
export function analyze({ channels, sampleRate }, options = {}) {
  const { bars } = resolveOptions(options);
  const analyzer = new Analyzer({ totalFrames: channels[0]?.length ?? 0, sampleRate, channels: channels.length, bars });
  analyzer.push(channels);
  return analyzer.finish(options);
}

/** Frame-by-frame average of all channels (exposed for tests and for callers that want the mono signal). */
export function downmixToMono(channels) {
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) s += channels[c][i];
    out[i] = s / channels.length;
  }
  return out;
}

/**
 * JSON with indentation, but every array of plain numbers on a single line (the bars are long). Only the lines that
 * JSON.stringify itself produced for such an array are joined: a string can never contain a raw line break, so
 * text inside a string (a file name like "Mix [ 1 ].wav") is never touched.
 */
export function formatJson(value) {
  return JSON.stringify(value, null, 2).replace(/\[\n((?:[ \t]*-?\d[\d.eE+-]*,?\n)+)[ \t]*\]/g, (_m, lines) => `[${lines.trim().replace(/\s*\n\s*/g, " ")}]`);
}
