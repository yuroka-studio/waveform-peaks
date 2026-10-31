import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prng } from "../scripts/make-fixtures.mjs";
import { Analyzer, analyze, analyzeFile, decodeWav, downmixToMono, resolveOptions } from "../src/index.js";

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
