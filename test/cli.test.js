import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FRAMES, SAMPLE_RATE } from "../scripts/make-fixtures.mjs";
import { NoDecoderError, analyzeFile, findDecoder, withDecodedWav } from "../src/index.js";
import { formatJson, main } from "../src/cli.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "waveform-peaks.js");
const fx = (name) => path.join(root, "test", "fixtures", `${name}.wav`);
const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wp-test-"));

test("prints one JSON object for one file, with the documented fields and only a base name", () => {
  const r = run(["--bars", "12", fx("sine-pcm16-mono")]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ["file", "duration", "sampleRate", "channels", "bars", "peaks", "rms", "peakDb", "rmsDb"]);
  assert.equal(out.file, "sine-pcm16-mono.wav");
  assert.equal(out.bars, 12);
  assert.equal(out.peaks.length, 12);
  assert.equal(out.rms.length, 12);
  assert.equal(out.sampleRate, SAMPLE_RATE);
  assert.equal(out.duration, FRAMES / SAMPLE_RATE);
  assert.equal(Math.max(...out.peaks), 1); // normalised per file by default
  assert.ok(!r.stdout.includes(path.sep + "test" + path.sep), "no directories in the output");
});

test("several files give a JSON array; --out writes a file and keeps stdout quiet", () => {
  const dir = tmp();
  const out = path.join(dir, "bars.json");
  try {
    const r = run(["--bars", "8", "--out", out, fx("sine-pcm16-mono"), fx("stereo-pcm24"), fx("sine-float32-mono")]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    const list = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(list.map((x) => x.file), ["sine-pcm16-mono.wav", "stereo-pcm24.wav", "sine-float32-mono.wav"]);
    assert.deepEqual(list.map((x) => x.channels), [1, 2, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--normalize none keeps the real level; --no-normalize is the same; --mode rms rescales", () => {
  const quiet = (extra) => JSON.parse(run([...extra, "--bars", "4", fx("stereo-pcm16")]).stdout);
  const none = quiet(["--normalize", "none"]);
  assert.deepEqual(quiet(["--no-normalize"]), none);
  assert.ok(Math.max(...none.peaks) < 1.0001 && none.peaks.every((p) => p > 0));
  const rmsMode = quiet(["--mode", "rms"]);
  assert.equal(Math.max(...rmsMode.rms), 1);
  assert.notDeepEqual(rmsMode.peaks, quiet([]).peaks);
});

test("arrays of numbers stay on one line", () => {
  const text = formatJson({ a: 1, peaks: [0.1, 0.25, 1], nested: { rms: [0, 0.5] }, name: "x" });
  assert.match(text, /"peaks": \[0\.1, 0\.25, 1\]/);
  assert.match(text, /"rms": \[0, 0\.5\]/);
  assert.deepEqual(JSON.parse(text), { a: 1, peaks: [0.1, 0.25, 1], nested: { rms: [0, 0.5] }, name: "x" });
});

test("exit codes and messages for bad input", () => {
  const missing = run(["definitely-not-here.wav"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such file/);
  assert.equal(run([]).status, 2);
  assert.equal(run(["--bars", "abc", fx("sine-pcm16-mono")]).status, 2);
  assert.equal(run(["--bars", "0", fx("sine-pcm16-mono")]).status, 2);
  assert.equal(run(["--mode", "loud", fx("sine-pcm16-mono")]).status, 2);
  assert.equal(run(["--nope", fx("sine-pcm16-mono")]).status, 2);
  assert.match(run(["--help"]).stdout, /Usage/);
  assert.match(run(["--version"]).stdout, /^\d+\.\d+\.\d+/);
  // a good file next to a bad one: the good result is still printed (an array, since two files were given), exit code 1
  const mixed = run(["--bars", "4", fx("sine-pcm16-mono"), "nope.wav"]);
  assert.equal(mixed.status, 1);
  assert.deepEqual(JSON.parse(mixed.stdout).map((x) => x.file), ["sine-pcm16-mono.wav"]);
});

test("main() is usable in-process with injected streams", async () => {
  let out = "";
  const code = await main(["--bars", "4", fx("silence-pcm16")], { stdout: { write: (s) => (out += s) }, stderr: { write() {} } });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out).peaks, [0, 0, 0, 0]);
});

// ---- decoders for other formats -------------------------------------------------------------------------------

test("without any decoder, a non-WAV file fails with a clear message that points to the browser page", async () => {
  const dir = tmp();
  const song = path.join(dir, "song.mp3");
  fs.writeFileSync(song, "ID3 not really audio");
  try {
    await assert.rejects(analyzeFile(song, { decoder: null }), (e) => e instanceof NoDecoderError && /browser page/.test(e.message) && /nothing is ever downloaded/.test(e.message) && !e.message.includes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findDecoder prefers ffmpeg on PATH, then afconvert on macOS only, and never runs anything", () => {
  const exec = (set) => (f) => set.includes(f);
  assert.equal(findDecoder({ env: { PATH: "/a:/b" }, platform: "linux", isExec: exec(["/b/ffmpeg"]) }).bin, "/b/ffmpeg");
  assert.equal(findDecoder({ env: { PATH: "/a" }, platform: "darwin", isExec: exec(["/a/ffmpeg", "/usr/bin/afconvert"]) }).name, "ffmpeg");
  assert.equal(findDecoder({ env: { PATH: "/a" }, platform: "darwin", isExec: exec(["/usr/bin/afconvert"]) }).name, "afconvert");
  assert.equal(findDecoder({ env: { PATH: "/a" }, platform: "linux", isExec: exec(["/usr/bin/afconvert"]) }), null);
  assert.equal(findDecoder({ env: {}, platform: "linux", isExec: () => false }), null);
});

/** A stand-in "ffmpeg": copies $FAKE_FFMPEG_WAV to its last argument, like a real decode would write the output file. */
function fakeFfmpeg(dir, script) {
  const file = path.join(dir, "ffmpeg");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

test("non-WAV input goes through ffmpeg on PATH to a temporary WAV, which is removed afterwards", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  fakeFfmpeg(dir, 'for last; do :; done\necho "$@" > "$FAKE_FFMPEG_LOG"\n/bin/cp "$FAKE_FFMPEG_WAV" "$last"');
  const song = path.join(dir, "song.mp3");
  fs.writeFileSync(song, "pretend mp3");
  const log = path.join(dir, "args.txt");
  try {
    const r = run(["--bars", "6", song], { PATH: dir, FAKE_FFMPEG_WAV: fx("stereo-pcm16"), FAKE_FFMPEG_LOG: log });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.file, "song.mp3");
    assert.equal(out.channels, 2);
    assert.deepEqual({ ...out, file: "x" }, { ...(await analyzeFile(fx("stereo-pcm16"), { bars: 6 })), file: "x" });
    assert.match(fs.readFileSync(log, "utf8"), /-i .*song\.mp3 .*pcm_f32le/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the temp folder is removed whether decoding works or fails", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const song = path.join(dir, "song.flac");
  fs.writeFileSync(song, "pretend flac");
  const before = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("waveform-peaks-")).length;
  const n0 = before();
  try {
    fakeFfmpeg(dir, 'for last; do :; done\n/bin/cp "' + fx("sine-pcm16-mono") + '" "$last"');
    const good = findDecoder({ env: { PATH: dir } });
    let wavPath;
    await withDecodedWav(song, async (p) => { wavPath = p; assert.ok(fs.existsSync(p)); }, { decoder: good });
    assert.ok(!fs.existsSync(wavPath));
    assert.equal(before(), n0);

    fakeFfmpeg(dir, 'echo "Invalid data found when processing input" >&2\nexit 1');
    const bad = findDecoder({ env: { PATH: dir } });
    await assert.rejects(analyzeFile(song, { decoder: bad }), /ffmpeg could not decode "song\.flac": Invalid data found/);
    assert.equal(before(), n0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real decoder smoke test (macOS afconvert): an AAC file made from a synthetic tone", { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/afconvert") }, async () => {
  const dir = tmp();
  try {
    // build a 2 second tone, encode it to M4A with the system encoder, then analyse the M4A through the CLI
    const { makeWav, signals } = await import("../scripts/make-fixtures.mjs");
    const wav = path.join(dir, "tone.wav");
    fs.writeFileSync(wav, makeWav([signals.sine(0.5, 440)(16000)], { kind: "pcm", bits: 16 }));
    const m4a = path.join(dir, "tone.m4a");
    const enc = spawnSync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", wav, m4a]);
    assert.equal(enc.status, 0, String(enc.stderr));
    const r = run(["--bars", "10", "--normalize", "none", m4a]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.file, "tone.m4a");
    assert.equal(out.sampleRate, SAMPLE_RATE);
    assert.ok(Math.abs(out.duration - 2) < 0.15, `duration ${out.duration}`);
    assert.ok(out.rmsDb > -10.5 && out.rmsDb < -8, `rmsDb ${out.rmsDb}`); // 0.5 amplitude sine = -9.03 dBFS
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
