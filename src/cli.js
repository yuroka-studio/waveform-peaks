import fs from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_BARS, MAX_BARS, analyzeFile, formatJson, resolveOptions } from "./index.js";

export { formatJson };

const USAGE = `waveform-peaks: turn songs into compact waveform data (normalised peak and RMS bars)

Usage
  waveform-peaks [options] <files...>

Options
  --bars <n>             number of bars, 1-${MAX_BARS} (default ${DEFAULT_BARS})
  --mode <peak|rms>      series the normalisation is scaled against (default peak)
  --normalize <how>      per-file (default) or none; --no-normalize is the same as "none"
  --out <file.json>      write the JSON here instead of printing it
  -h, --help             show this help
  -v, --version          show the version

WAV is decoded by the built-in decoder. MP3, M4A, FLAC and the like are decoded with
an already installed ffmpeg (or afconvert on macOS); nothing is ever downloaded.
One input file gives a JSON object, several give a JSON array.
`;

/**
 * @param {string[]} argv
 * @param {{stdout?: {write(s: string): unknown}, stderr?: {write(s: string): unknown}}} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const fail = (msg) => {
    stderr.write(`waveform-peaks: ${msg}\n`);
    return 2;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.map((a) => (a === "--no-normalize" ? "--normalize=none" : a)),
      allowPositionals: true,
      options: {
        bars: { type: "string" },
        mode: { type: "string" },
        normalize: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    return fail(`${err.message}\nTry --help.`);
  }
  const { values, positionals: files } = parsed;
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (files.length === 0) return fail("give at least one audio file.\n\n" + USAGE.split("\n").slice(2, 4).join("\n"));

  const options = { bars: DEFAULT_BARS, mode: "peak", normalize: "per-file" };
  if (values.bars !== undefined) {
    if (!/^\d+$/.test(values.bars)) return fail(`--bars must be a whole number, got "${values.bars}"`);
    options.bars = Number(values.bars);
  }
  if (values.mode !== undefined) options.mode = values.mode;
  if (values.normalize !== undefined) options.normalize = values.normalize;
  try {
    // validate once up front so a typo fails before any decoding
    resolveOptions(options);
  } catch (err) {
    return fail(err.message);
  }

  const results = [];
  let failed = 0;
  for (const file of files) {
    try {
      results.push(await analyzeFile(file, options));
    } catch (err) {
      failed++;
      stderr.write(`waveform-peaks: ${err.code === "ENOENT" ? `no such file: ${file}` : err.message}\n`);
    }
  }
  if (results.length > 0) {
    const text = formatJson(files.length === 1 ? results[0] : results) + "\n";
    if (values.out) {
      try {
        fs.writeFileSync(values.out, text);
      } catch (err) {
        return fail(`cannot write ${values.out}: ${err.message}`);
      }
      stderr.write(`waveform-peaks: wrote ${results.length} file${results.length === 1 ? "" : "s"} to ${values.out}\n`);
    } else {
      stdout.write(text);
    }
  }
  return failed > 0 ? 1 : 0;
}
