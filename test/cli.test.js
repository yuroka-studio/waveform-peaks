import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FRAMES, SAMPLE_RATE, makeWav, signals } from "../scripts/make-fixtures.mjs";
import { FFMPEG_FORMAT_WHITELIST, NoDecoderError, UnsafeInputError, analyzeFile, assertSafeInput, findDecoder, looksLikePlaylist, withDecodedWav } from "../src/index.js";
import { formatJson, main } from "../src/cli.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "waveform-peaks.js");
const fx = (name) => path.join(root, "test", "fixtures", `${name}.wav`);
const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
/** Bytes that are not text and not WAV, standing in for an MP3/FLAC: the decoder (real or fake) gets to decide. */
const BINARY = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x80]);
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
  fs.writeFileSync(song, BINARY);
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
  fs.writeFileSync(song, BINARY);
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
  fs.writeFileSync(song, BINARY);
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

// ---- hardening: the input file is untrusted --------------------------------------------------------------------

const M3U8 = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nhttp://example.invalid/segment0.ts\n#EXT-X-ENDLIST\n";

test("ffmpeg is started with protocol and format whitelists before -i, and the input is an absolute file: path", () => {
  const dec = findDecoder({ env: { PATH: "/bin" }, platform: "linux", isExec: (f) => f === "/bin/ffmpeg" });
  const args = dec.args("/music/-evil name.mp3", "/tmp/out.wav");
  const at = (x) => args.indexOf(x);
  assert.deepEqual(args.slice(at("-protocol_whitelist"), at("-protocol_whitelist") + 2), ["-protocol_whitelist", "file"]);
  assert.equal(args[at("-format_whitelist") + 1], FFMPEG_FORMAT_WHITELIST);
  // both are input options: they only apply when they come before -i
  assert.ok(at("-protocol_whitelist") > -1 && at("-protocol_whitelist") < at("-i"));
  assert.ok(at("-format_whitelist") > -1 && at("-format_whitelist") < at("-i"));
  assert.equal(args[at("-i") + 1], "file:/music/-evil name.mp3");
  assert.equal(args[args.length - 1], "/tmp/out.wav");
  assert.equal(args.filter((a) => a === "-i").length, 1);
});

test("the format whitelist lists plain audio demuxers and none of the playlist-style ones", () => {
  const allowed = FFMPEG_FORMAT_WHITELIST.split(",");
  for (const ok of ["mp3", "mov", "m4a", "flac", "ogg", "wav", "aac", "matroska", "caf"]) assert.ok(allowed.includes(ok), ok);
  for (const never of ["hls", "applehttp", "concat", "dash", "sdp", "rtsp", "image2", "lavfi", "pls", "asx", "tee"]) assert.ok(!allowed.includes(never), never);
  assert.ok(!/\s/.test(FFMPEG_FORMAT_WHITELIST));
});

test("a playlist named x.mp3 that points at a URL is refused before any decoder starts, so there is no network access", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const log = path.join(dir, "invoked.txt");
  // a decoder stand-in that would record being started; it must never be
  fakeFfmpeg(dir, `echo started >> "${log}"\nexit 1`);
  const decoder = findDecoder({ env: { PATH: dir } });
  const evil = path.join(dir, "x.mp3");
  try {
    for (const body of [M3U8, "ffconcat version 1.0\nfile '/etc/hosts'\n", "[playlist]\nFile1=http://example.invalid/a.mp3\n", "<?xml version=\"1.0\"?><MPD></MPD>"]) {
      fs.writeFileSync(evil, body);
      await assert.rejects(analyzeFile(evil, { decoder }), (e) => e instanceof UnsafeInputError && /looks like a playlist/.test(e.message));
    }
    assert.ok(!fs.existsSync(log), "the decoder must not have been started");
    // same through the command line, with that decoder first on PATH
    fs.writeFileSync(evil, M3U8);
    const r = run([evil], { PATH: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to decode "x\.mp3"/);
    assert.ok(!fs.existsSync(log));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** An ID3v2 tag (header plus `padding` zero bytes), syncsafe size included. */
const id3 = (padding) => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, (padding >> 7) & 0x7f, padding & 0x7f]), Buffer.alloc(padding)]);

test("playlists cannot slip past by hiding behind an ID3v2 tag or by carrying non-ASCII bytes", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const log = path.join(dir, "invoked.txt");
  fakeFfmpeg(dir, `echo started >> "${log}"\nexit 1`);
  const decoder = findDecoder({ env: { PATH: dir } });
  const evil = path.join(dir, "x.mp3");
  const playlist = "#EXTM3U\n#EXTINF:1,\nhttp://example.invalid/seg.ts\n";
  const cases = {
    "ID3v2 header + non-ASCII byte + m3u8": Buffer.concat([id3(20), Buffer.from([0xe9]), Buffer.from(playlist)]),
    "two ID3v2 tags in a row": Buffer.concat([id3(5), id3(300), Buffer.from(playlist)]),
    "ID3v2 with a footer flag": Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x10, 0, 0, 0, 4]), Buffer.alloc(4), Buffer.alloc(10), Buffer.from(playlist)]),
    "non-ASCII bytes around the signature": Buffer.concat([Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(`#extm3u\n# caf\u00e9\n`, "latin1"), Buffer.from([0x00, 0xc3, 0xa9]), Buffer.from(playlist)]),
    "m3u8 with a UTF-8 BOM": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(playlist)]),
    "ffconcat after a binary prefix": Buffer.concat([id3(10), Buffer.from([0x80, 0x81]), Buffer.from("ffconcat version 1.0\nfile '/etc/hosts'\n")]),
    "DASH manifest with XML prolog": Buffer.from('\ufeff<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>'),
    "SDP": Buffer.from("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=x\r\n"),
  };
  try {
    for (const [name, bytes] of Object.entries(cases)) {
      fs.writeFileSync(evil, bytes);
      await assert.rejects(analyzeFile(evil, { decoder }), (e) => e instanceof UnsafeInputError, name);
    }
    assert.ok(!fs.existsSync(log), "the decoder must not have been started for any of them");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real audio is not mistaken for a playlist, even when it carries XML metadata", async () => {
  const dir = tmp();
  try {
    // a BWF-style WAV with an iXML chunk before the audio, and an MP3-like file with an ID3v2 tag
    const ixml = Buffer.alloc(40);
    ixml.write('<?xml version="1.0"?><BWFXML><X/></BWFXML>', "latin1");
    const head = Buffer.from("iXML");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(ixml.length);
    const wav = makeWav([signals.sine(0.5)()], { kind: "pcm", bits: 16, beforeData: [Buffer.concat([head, lenBuf, ixml])] });
    const wavPath = path.join(dir, "bwf.wav");
    fs.writeFileSync(wavPath, wav);
    const r = await analyzeFile(wavPath, { bars: 4, decoder: null });
    assert.equal(r.bars, 4);
    await assertSafeInput(wavPath);
    const mp3 = path.join(dir, "a.mp3");
    fs.writeFileSync(mp3, Buffer.concat([id3(64), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(100, 0x55)]));
    await assertSafeInput(mp3);
    assert.equal(looksLikePlaylist(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x3c, 0x3f, 0x78, 0x6d, 0x6c])), null); // "<?xml" bytes mid-file are not a manifest
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("directories and binary audio-like files are not mistaken for text", async () => {
  const dir = tmp();
  try {
    await assert.rejects(assertSafeInput(dir), UnsafeInputError);
    await assertSafeInput(fx("sine-pcm16-mono")); // WAV header has NUL bytes
    const mp3 = path.join(dir, "a.mp3");
    fs.writeFileSync(mp3, Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.from([0xff, 0xfb, 0x90, 0x00])]));
    await assertSafeInput(mp3);
    fs.writeFileSync(path.join(dir, "empty.mp3"), "");
    await assertSafeInput(path.join(dir, "empty.mp3")); // not text; the decoder will say what is wrong
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file name that starts with a dash is passed as an absolute path, never as an option", { skip: process.platform === "win32" }, async () => {
  const dir = tmp();
  const log = path.join(dir, "args.txt");
  fakeFfmpeg(dir, `for last; do :; done\nprintf '%s\\n' "$@" > "${log}"\n/bin/cp "${fx("sine-pcm16-mono")}" "$last"`);
  const decoder = findDecoder({ env: { PATH: dir } });
  const odd = path.join(dir, "-i; touch pwned #.mp3"); // also full of shell metacharacters
  fs.writeFileSync(odd, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x01]));
  try {
    const old = process.cwd();
    process.chdir(dir);
    try {
      const out = await analyzeFile("-i; touch pwned #.mp3", { decoder }); // relative name, as typed on a command line
      assert.equal(out.file, "-i; touch pwned #.mp3");
    } finally {
      process.chdir(old);
    }
    const seen = fs.readFileSync(log, "utf8").split("\n");
    const input = seen[seen.indexOf("-i") + 1];
    assert.ok(input.startsWith("file:/"), input);
    assert.ok(input.endsWith("/-i; touch pwned #.mp3"), input);
    assert.ok(!fs.existsSync(path.join(dir, "pwned")), "no shell ever saw the file name");
    const afc = { name: "afconvert", bin: "/usr/bin/afconvert", args: findDecoder({ env: {}, platform: "darwin", isExec: (f) => f === "/usr/bin/afconvert" }).args };
    assert.ok(afc.args("/abs/-x.m4a", "/tmp/o.wav").includes("/abs/-x.m4a"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no shell anywhere: the only process started by the library is execFile with an argument array", () => {
  const code = ["cli.js", "external.js", "index.js", "wav.js"].map((f) => fs.readFileSync(path.join(root, "src", f), "utf8")).join("\n");
  assert.match(code, /execFile\(/);
  assert.ok(!/\b(exec|execSync|spawnSync|spawn|fork)\(/.test(code.replace(/execFile\(/g, "")), "only execFile may start a process");
  assert.ok(!/shell:\s*true/.test(code));
  assert.match(code, /shell:\s*false/);
});
