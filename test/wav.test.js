import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FRAMES, SAMPLE_RATE, buildFixtures, makeWav, signals, specs } from "../scripts/make-fixtures.mjs";
import { WavError, decodeWav } from "../src/index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => fs.readFileSync(path.join(dir, `${name}.wav`));

/** Largest allowed difference between the ideal signal and what comes back, per sample format. */
const tolerance = (kind, bits) => (kind === "float" ? 1e-6 : Math.max(2 / 2 ** (bits - 1), 1e-7)); // output is Float32, ~6e-8 resolution

function assertDecodesTo(decoded, ideal, tol) {
  assert.equal(decoded.channels.length, ideal.length);
  decoded.channels.forEach((got, c) => {
    assert.equal(got.length, ideal[c].length);
    let worst = 0;
    for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - ideal[c][i]));
    assert.ok(worst <= tol, `channel ${c}: largest error ${worst} is above ${tol}`);
  });
}

test("committed fixtures are exactly what scripts/make-fixtures.mjs generates", () => {
  const generated = buildFixtures();
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).length, generated.size);
  for (const [name, bytes] of generated) assert.ok(fs.readFileSync(path.join(dir, name)).equals(bytes), `${name} differs`);
});

for (const [name, spec] of Object.entries(specs)) {
  if (name.startsWith("square") || name.startsWith("silence") || name.startsWith("noise")) continue;
  test(`decodes ${name}`, async () => {
    const decoded = await decodeWav(load(name));
    assert.equal(decoded.sampleRate, SAMPLE_RATE);
    assertDecodesTo(decoded, spec.channels.map((f) => f()), tolerance(spec.options.kind, spec.options.bits));
  });
}

test("every bit depth and format has a fixture (8/16/24/32 int, 32/64 float)", () => {
  const combos = new Set(Object.values(specs).map((s) => `${s.options.kind}${s.options.bits}`));
  for (const want of ["pcm8", "pcm16", "pcm24", "pcm32", "float32", "float64"]) assert.ok(combos.has(want), want);
});

test("8-bit samples are unsigned: silence is 128, not 0", async () => {
  const wav = makeWav([signals.constant(0)(10)], { kind: "pcm", bits: 8 });
  assert.equal(wav[wav.length - 1], 128);
  const { channels } = await decodeWav(wav);
  assert.deepEqual(Array.from(channels[0]), new Array(10).fill(0));
});

test("channel order is kept for 6-channel files, plain and EXTENSIBLE", async () => {
  const plain = await decodeWav(load("multi6-float32"));
  assert.deepEqual(plain.channels.map((c) => Math.round(c[0] * 10)), [1, 2, 3, 4, 5, 6]);
  const ext = await decodeWav(load("extensible-pcm16-6ch"));
  assert.deepEqual(ext.channels.map((c) => Math.round(c[0] * 20)), [1, 3, 5, 7, 9, 11]);
});

test("EXTENSIBLE: the sub-format GUID decides PCM versus float", async () => {
  const a = await decodeWav(load("extensible-float32-mono"));
  assertDecodesTo(a, [signals.sine(0.7, 350)()], 1e-6);
  // same 32-bit container, but flip the sub-format tag from float (3) to PCM (1): the bytes are now read as integers
  const bytes = Buffer.from(load("extensible-float32-mono"));
  const at = bytes.indexOf("fmt ") + 8 + 24;
  assert.equal(bytes.readUInt16LE(at), 3);
  bytes.writeUInt16LE(1, at);
  const b = await decodeWav(bytes);
  assert.notDeepEqual(Array.from(b.channels[0].subarray(0, 8)), Array.from(a.channels[0].subarray(0, 8)));
});

test("skips LIST and fact chunks, including an odd-sized chunk with a pad byte", async () => {
  const bytes = load("list-chunk-pcm16");
  assert.equal(bytes.indexOf("LIST") > 0 && bytes.indexOf("data") > bytes.indexOf("LIST"), true);
  assertDecodesTo(await decodeWav(bytes), [signals.sine(0.5)()], tolerance("pcm", 16));
});

test("a data size of 0xFFFFFFFF (streaming writers) or one bigger than the file is clamped", async () => {
  for (const name of ["streaming-sizes-pcm16", "data-size-too-big-pcm16"]) {
    const decoded = await decodeWav(load(name));
    assert.equal(decoded.channels[0].length, FRAMES, name);
    assertDecodesTo(decoded, [signals.sine(0.5)()], tolerance("pcm", 16));
  }
});

test("a file cut off mid-frame keeps every whole frame", async () => {
  const full = load("stereo-pcm16");
  const cut = full.subarray(0, full.length - 3 - 4 * 100); // 100 frames and 3 bytes short
  const { channels } = await decodeWav(cut);
  assert.equal(channels[0].length, FRAMES - 101);
});

test("decoding is the same no matter the block size", async () => {
  const { readHeader, bufferSource, readChunks } = await import("../src/wav.js");
  const bytes = load("stereo-pcm24");
  const src = bufferSource(bytes);
  const header = await readHeader(src);
  const parts = [];
  for await (const c of readChunks(src, header, 333)) parts.push(c);
  assert.ok(parts.length > 1);
  const whole = await decodeWav(bytes);
  const joined = whole.channels.map((_, c) => Float32Array.from(parts.flatMap((p) => Array.from(p[c]))));
  assert.deepEqual(joined.map((a) => Array.from(a)), whole.channels.map((a) => Array.from(a)));
});

test("rejects things that are not decodable WAV, with a clear code", async () => {
  const wav = load("sine-pcm16-mono");
  const expect = async (bytes, code, re) => {
    await assert.rejects(decodeWav(bytes), (e) => e instanceof WavError && e.code === code && re.test(e.message), `${code} ${re}`);
  };
  await expect(Buffer.from("tiny"), "NOT_WAV", /not a WAV/);
  await expect(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00 and some more bytes after", "latin1"), "NOT_WAV", /not a WAV/);
  const adpcm = Buffer.from(wav);
  adpcm.writeUInt16LE(2, adpcm.indexOf("fmt ") + 8);
  await expect(adpcm, "UNSUPPORTED", /format tag 0x0002/);
  const rf64 = Buffer.from(wav);
  rf64.write("RF64", 0, "latin1");
  await expect(rf64, "UNSUPPORTED", /RF64/);
  const odd = Buffer.from(wav);
  odd.writeUInt16LE(12, odd.indexOf("fmt ") + 8 + 14); // 12-bit in a 16-bit block
  const ok = await decodeWav(odd); // container size comes from blockAlign, so this still decodes
  assert.equal(ok.channels[0].length, FRAMES);
  const noData = wav.subarray(0, wav.indexOf("data"));
  await expect(noData, "INVALID", /no data chunk/);
  const empty = makeWav([new Float64Array(0)], { kind: "pcm", bits: 16 });
  await expect(empty, "INVALID", /no audio frames/);
  const zeroCh = Buffer.from(wav);
  zeroCh.writeUInt16LE(0, zeroCh.indexOf("fmt ") + 8 + 2);
  await expect(zeroCh, "INVALID", /zero channels/);
});
