import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prng } from "../scripts/make-fixtures.mjs";
import { Analyzer, analyze, analyzeFile, decodeWav, downmixToMono, formatJson, resolveOptions } from "../src/index.js";

const fixture = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", `${name}.wav`);
const SR = 8000;
const sine = (frames, hz, amp = 1) => Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} is not within ${eps} of ${b}`);

test("silence gives zeros (never NaN) and null decibels", () => {
  for (const normalize of ["per-file", "none"]) {
    const r = analyze({ channels: [new Float32Array(4800)], sampleRate: SR }, { bars: 24, normalize });
    assert.equal(r.bars, 24);
    assert.deepEqual(r.peaks, new Array(24).fill(0));
    assert.deepEqual(r.rms, new Array(24).fill(0));
    assert.equal(r.peakDb, null);
    assert.equal(r.rmsDb, null);
    assert.ok(!JSON.stringify(r).includes("NaN"));
  }
});

test("a full-scale square wave is 1.0 in every bar, peak and RMS, and 0 dBFS", async () => {
  const { channels, sampleRate } = await decodeWav(fs.readFileSync(fixture("square-fullscale-float32")));
  const r = analyze({ channels, sampleRate }, { bars: 10, normalize: "none" });
  assert.deepEqual(r.peaks, new Array(10).fill(1));
  assert.deepEqual(r.rms, new Array(10).fill(1));
  assert.equal(r.peakDb, 0);
  assert.equal(r.rmsDb, 0);
  // the same square quantised to 16 bits (+32767/-32768 steps) still rounds to 1.0 at three decimals
  const r16 = await analyzeFile(fixture("square-fullscale-pcm16"), { bars: 10, normalize: "none" });
  assert.deepEqual(r16.peaks, new Array(10).fill(1));
});

test("a full-scale sine has RMS 0.707 (-3.0 dBFS) and peak 1.0 when not normalised", () => {
  // 400 Hz at 8 kHz = 20 samples per cycle; 96 bars of 100 frames = 5 whole cycles each
  const r = analyze({ channels: [sine(9600, 400)], sampleRate: SR }, { bars: 96, normalize: "none" });
  assert.equal(r.bars, 96);
  for (const v of r.rms) near(v, Math.SQRT1_2, 0.001, "rms bar");
  for (const v of r.peaks) near(v, 1, 0.001, "peak bar");
  assert.equal(r.peakDb, 0);
  assert.equal(r.rmsDb, -3);
  assert.equal(r.duration, 1.2);
  assert.equal(r.sampleRate, SR);
  assert.equal(r.channels, 1);
});

test("per-file normalisation: peak mode scales the loudest peak to 1, rms mode the loudest RMS bar", () => {
  const quiet = sine(9600, 400, 0.25); // peaks 0.25, rms 0.177
  const peakMode = analyze({ channels: [quiet], sampleRate: SR }, { bars: 8 });
  for (const v of peakMode.peaks) near(v, 1, 0.001);
  for (const v of peakMode.rms) near(v, Math.SQRT1_2, 0.001);
  assert.equal(peakMode.peakDb, -12); // dB values always describe the source, not the normalised bars
  const rmsMode = analyze({ channels: [quiet], sampleRate: SR }, { bars: 8, mode: "rms" });
  for (const v of rmsMode.rms) near(v, 1, 0.001);
  for (const v of rmsMode.peaks) assert.equal(v, 1); // peaks would be 1.41: clamped
  const none = analyze({ channels: [quiet], sampleRate: SR }, { bars: 8, normalize: "none" });
  for (const v of none.peaks) near(v, 0.25, 0.001);
});

test("stereo is downmixed by averaging the channels", () => {
  const n = 960;
  const ones = new Float32Array(n).fill(1);
  const minus = new Float32Array(n).fill(-1);
  const none = { bars: 4, normalize: "none" };
  assert.deepEqual(Array.from(downmixToMono([ones, minus])), new Array(n).fill(0));
  const cancel = analyze({ channels: [ones, minus], sampleRate: SR }, none);
  assert.deepEqual(cancel.peaks, [0, 0, 0, 0]); // out-of-phase channels cancel in the bars...
  assert.equal(cancel.peakDb, 0); // ...but the file's own peak level is still read from the channels
  const left = analyze({ channels: [ones, new Float32Array(n)], sampleRate: SR }, none);
  assert.deepEqual(left.peaks, [0.5, 0.5, 0.5, 0.5]);
  const same = analyze({ channels: [ones, ones], sampleRate: SR }, none);
  assert.deepEqual(same.peaks, [1, 1, 1, 1]);
  assert.equal(same.channels, 2);
  const mixed = analyze({ channels: [sine(960, 400, 0.8), sine(960, 400, 0.4)], sampleRate: SR }, { bars: 4, normalize: "none" });
  for (const v of mixed.peaks) near(v, 0.6, 0.001);
});

test("bar boundaries: every frame belongs to exactly one bar, no matter if bars divide the length", () => {
  const ramp = Float32Array.from({ length: 10 }, (_, i) => (i + 1) / 10);
  // 10 frames in 3 bars -> frames 0-3, 4-6, 7-9
  assert.deepEqual(analyze({ channels: [ramp], sampleRate: SR }, { bars: 3, normalize: "none" }).peaks, [0.4, 0.7, 1]);
  const r = analyze({ channels: [new Float32Array(1000).fill(0.5)], sampleRate: SR }, { bars: 7, normalize: "none" });
  assert.deepEqual(r.peaks, new Array(7).fill(0.5)); // no bar is empty
  assert.deepEqual(r.rms, new Array(7).fill(0.5));
});

test("never more bars than frames", () => {
  const r = analyze({ channels: [Float32Array.of(0.2, -0.4, 0.6)], sampleRate: SR }, { bars: 96, normalize: "none" });
  assert.equal(r.bars, 3);
  assert.deepEqual(r.peaks, [0.2, 0.4, 0.6]);
});

test("values are rounded to 3 decimals and decibels to 1", () => {
  const r = analyze({ channels: [new Float32Array(100).fill(1 / 3)], sampleRate: SR }, { bars: 2, normalize: "none" });
  assert.deepEqual(r.peaks, [0.333, 0.333]);
  assert.equal(r.peakDb, -9.5);
});

test("chunking does not change the result", () => {
  const r = prng(5);
  const left = Float32Array.from({ length: 50000 }, () => r() * 2 - 1);
  const right = Float32Array.from({ length: 50000 }, () => (r() * 2 - 1) * 0.5);
  const whole = analyze({ channels: [left, right], sampleRate: 44100 }, { bars: 64 });
  const a = new Analyzer({ totalFrames: 50000, sampleRate: 44100, channels: 2, bars: 64 });
  for (let at = 0; at < 50000; ) {
    const len = Math.min(50000 - at, 1 + Math.floor(r() * 4000));
    a.push([left.subarray(at, at + len), right.subarray(at, at + len)]);
    at += len;
  }
  assert.deepEqual(a.finish({}), whole);
});

test("the file path and the in-memory path agree (analyzeFile reports only the base name)", async () => {
  const viaFile = await analyzeFile(fixture("stereo-pcm16"), { bars: 16 });
  const decoded = await decodeWav(fs.readFileSync(fixture("stereo-pcm16")));
  assert.deepEqual(viaFile, { file: "stereo-pcm16.wav", ...analyze(decoded, { bars: 16 }) });
  assert.deepEqual(Object.keys(viaFile), ["file", "duration", "sampleRate", "channels", "bars", "peaks", "rms", "peakDb", "rmsDb"]);
  assert.equal(viaFile.channels, 2);
  assert.equal(viaFile.duration, 0.25);
});

test("noise: RMS is below the peak in every bar and the numbers are plausible", async () => {
  const r = await analyzeFile(fixture("noise-pcm16"), { bars: 20, normalize: "none" });
  r.peaks.forEach((p, i) => assert.ok(r.rms[i] <= p && p <= 1));
  near(r.rmsDb, 20 * Math.log10(0.9 / Math.sqrt(3)), 0.5, "uniform noise rms");
});

test("options are validated", () => {
  const audio = { channels: [new Float32Array(100)], sampleRate: SR };
  assert.throws(() => analyze(audio, { bars: 0 }), RangeError);
  assert.throws(() => analyze(audio, { bars: 1.5 }), RangeError);
  assert.throws(() => analyze(audio, { bars: 100000 }), RangeError);
  assert.throws(() => analyze(audio, { mode: "loud" }), /mode/);
  assert.throws(() => analyze(audio, { normalize: "album" }), /normalize/);
  assert.throws(() => analyze({ channels: [new Float32Array(0)], sampleRate: SR }), /no frames/);
  assert.deepEqual(resolveOptions(), { bars: 96, mode: "peak", normalize: "per-file" });
});

test("NaN, Infinity and absurdly large samples never turn the output into nulls", () => {
  const steady = (n = 16) => new Float32Array(n).fill(0.5);
  const withSample = (value, ArrayType = Float32Array) => {
    const a = ArrayType.from(steady());
    a[0] = value;
    return a;
  };
  const opts = { bars: 4 };
  const reference = analyze({ channels: [withSample(0)], sampleRate: SR }, opts);
  // a non-finite sample counts as silence, exactly like a NaN always did
  for (const bad of [NaN, Infinity, -Infinity]) assert.deepEqual(analyze({ channels: [withSample(bad)], sampleRate: SR }, opts), reference, String(bad));
  const stereoPair = analyze({ channels: [withSample(Infinity), withSample(-Infinity)], sampleRate: SR }, opts);
  assert.deepEqual(stereoPair, analyze({ channels: [withSample(0), withSample(0)], sampleRate: SR }, opts));
  // finite but huge values (a Float64Array from a library caller) must not overflow when squared
  const huge = [1e300, -1e300, 3e38, 1e154, Number.MAX_VALUE];
  for (const big of huge) {
    for (const normalize of ["per-file", "none"]) {
      const r = analyze({ channels: [withSample(big, Float64Array)], sampleRate: SR }, { bars: 4, normalize });
      for (const v of [...r.peaks, ...r.rms]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${big} ${normalize}: ${v}`);
      assert.ok(Number.isFinite(r.peakDb) && Number.isFinite(r.rmsDb), `${big}: dB values`);
      assert.ok(!formatJson(r).includes("null"), `${big}: no null in the JSON`);
    }
  }
});

test("the bars stay numbers from 0 to 1 for an Infinity sample inside a float32 WAV file", async () => {
  const { makeWav } = await import("../scripts/make-fixtures.mjs");
  const bytes = makeWav([new Float64Array(64).fill(0.5)], { kind: "float", bits: 32 });
  bytes.writeFloatLE(Infinity, bytes.indexOf("data", 12, "latin1") + 8); // makeWav clamps, so patch the first sample afterwards
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-test-"));
  try {
    const file = path.join(dir, "inf.wav");
    fs.writeFileSync(file, bytes);
    const r = await analyzeFile(file, { bars: 4 });
    assert.deepEqual(r.peaks, [1, 1, 1, 1]);
    assert.equal(r.peakDb, -6);
    assert.ok(!formatJson(r).includes("null"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
