// Public API: analyse audio files, or reuse the pieces.
import path from "node:path";
import { Analyzer, DEFAULT_BARS, MAX_BARS, analyze, downmixToMono, formatJson, resolveOptions } from "../docs/peaks.js";
import { DecoderFailedError, NoDecoderError, UnsafeInputError, FFMPEG_FORMAT_WHITELIST, assertRegularFile, assertSafeInput, findDecoder, looksLikePlaylist, withDecodedWav } from "./external.js";
import { WavError, bufferSource, decodeWav, fileSource, readChunks, readHeader } from "./wav.js";

export { Analyzer, DEFAULT_BARS, MAX_BARS, analyze, downmixToMono, formatJson, resolveOptions };
export { DecoderFailedError, NoDecoderError, UnsafeInputError, FFMPEG_FORMAT_WHITELIST, WavError, assertRegularFile, assertSafeInput, looksLikePlaylist, bufferSource, decodeWav, fileSource, findDecoder, readChunks, readHeader, withDecodedWav };

async function analyzeWavPath(wavPath, options) {
  const source = await fileSource(wavPath);
  try {
    const header = await readHeader(source);
    const analyzer = new Analyzer({ totalFrames: header.frames, sampleRate: header.sampleRate, channels: header.channels, bars: options.bars });
    for await (const chunk of readChunks(source, header)) analyzer.push(chunk);
    return analyzer.finish(options);
  } finally {
    await source.close();
  }
}

/**
 * Analyse one audio file. WAV is decoded by the built-in decoder; anything else
 * (or a WAV flavour the built-in decoder does not know, such as ADPCM) goes
 * through a locally installed ffmpeg / afconvert if there is one.
 * @param {string} file
 * @param {{bars?: number, mode?: "peak"|"rms", normalize?: "per-file"|"none", decoder?: object|null}} [options]
 *   `decoder` overrides the lookup (null means "none installed"); it exists for tests.
 * @returns {Promise<{file: string, duration: number, sampleRate: number, channels: number, bars: number, peaks: number[], rms: number[], peakDb: number|null, rmsDb: number|null}>}
 */
export async function analyzeFile(file, options = {}) {
  const opts = resolveOptions(options);
  const named = (result) => ({ file: path.basename(file), ...result });
  await assertRegularFile(file); // keeps a FIFO or device from blocking the open below. The playlist check is not needed here: it guards the external decoders, in withDecodedWav
  try {
    return named(await analyzeWavPath(file, opts));
  } catch (err) {
    const fallBack = err instanceof WavError && (err.code === "NOT_WAV" || err.code === "UNSUPPORTED");
    if (!fallBack) throw err;
    const decoder = "decoder" in options ? options.decoder : findDecoder();
    try {
      return named(await withDecodedWav(file, (wav) => analyzeWavPath(wav, opts), { decoder }));
    } catch (e) {
      if (e instanceof NoDecoderError && err.code === "UNSUPPORTED") {
        throw new Error(`Cannot decode "${path.basename(file)}": ${err.message}. Convert it to PCM or float WAV, or install ffmpeg (nothing is downloaded for you).`);
      }
      throw e;
    }
  }
}
