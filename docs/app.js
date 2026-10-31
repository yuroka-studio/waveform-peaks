// Browser page for waveform-peaks. Decodes with the Web Audio API, then runs the
// very same algorithm as the CLI (peaks.js). Nothing is uploaded: there is no network code here.
import { analyze, formatJson, resolveOptions } from "./peaks.js";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"),
  files: $("files"),
  form: $("options"),
  bars: $("bars"),
  normalize: $("normalize"),
  status: $("status"),
  section: $("results-section"),
  list: $("results"),
  copyAll: $("copy-all"),
  downloadAll: $("download-all"),
  clear: $("clear"),
};

/** @type {{name: string, audio?: {channels: Float32Array[], sampleRate: number}, error?: string, result?: object, card?: HTMLElement}[]} */
let items = [];
let audioContext = null;
let busy = false;

const options = () => ({
  bars: Number.parseInt(els.bars.value, 10),
  mode: els.form.elements.mode.value,
  normalize: els.normalize.checked ? "per-file" : "none",
});

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

// ------------------------------------------------------------------ decoding
async function decodeFile(file) {
  audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
  const bytes = await file.arrayBuffer();
  const buffer = await audioContext.decodeAudioData(bytes);
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
  };
}

async function addFiles(fileList) {
  if (busy) return;
  const files = Array.from(fileList);
  if (files.length === 0) return;
  busy = true;
  const bad = (() => {
    try {
      resolveOptions(options());
      return null;
    } catch (err) {
      return err.message;
    }
  })();
  if (bad) {
    setStatus(bad, true);
    busy = false;
    return;
  }
  let failed = 0;
  for (const [i, file] of files.entries()) {
    setStatus(`Decoding ${i + 1} of ${files.length}: ${file.name}`);
    const item = { name: file.name };
    try {
      item.audio = await decodeFile(file);
      item.result = { file: file.name, ...analyze(item.audio, options()) };
    } catch (err) {
      failed++;
      item.error = err?.name === "EncodingError" || err instanceof DOMException
        ? "Your browser could not decode this file. Try WAV, MP3 or M4A."
        : String(err?.message ?? err);
    }
    items.push(item);
    renderItem(item);
    // let the browser paint between large files
    await new Promise((r) => setTimeout(r, 0));
  }
  busy = false;
  const ok = files.length - failed;
  setStatus(failed ? `Done: ${ok} analysed, ${failed} failed.` : `Done: ${ok} file${ok === 1 ? "" : "s"} analysed.`, failed > 0 && ok === 0);
  syncChrome();
}

// ------------------------------------------------------------------ rendering
const SVG = "http://www.w3.org/2000/svg";
function svgEl(name, attrs) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Mirrored bars: the peak series in a muted colour, RMS drawn on top in the accent colour. */
export function buildSvg(result) {
  const n = result.bars;
  const H = 120;
  const W = 960;
  const step = W / n;
  const barW = Math.max(1, step * 0.7);
  const svg = svgEl("svg", {
    class: "wave",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `Waveform of ${result.file}: ${n} bars, peak and RMS`,
  });
  svg.appendChild(svgEl("line", { class: "axis", x1: 0, x2: W, y1: H / 2, y2: H / 2 }));
  const half = H / 2 - 2;
  for (let i = 0; i < n; i++) {
    const x = i * step + (step - barW) / 2;
    for (const [series, cls] of [[result.peaks, "peak"], [result.rms, "rms"]]) {
      const h = Math.max(2, series[i] * half * 2);
      svg.appendChild(svgEl("rect", { class: cls, x, y: H / 2 - h / 2, width: barW, height: h, rx: Math.min(1.5, barW / 2) }));
    }
  }
  return svg;
}

const fmtDb = (v) => (v === null ? "silence" : `${v} dBFS`);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function renderItem(item) {
  const card = item.card ?? document.createElement("li");
  item.card = card;
  card.className = `card${item.error ? " failed" : ""}`;
  card.replaceChildren();
  const title = document.createElement("h3");
  title.textContent = item.name;
  card.append(title);
  if (item.error) {
    const p = document.createElement("p");
    p.className = "meta";
    p.textContent = item.error;
    card.append(p);
  } else {
    const r = item.result;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${fmtTime(r.duration)} (${r.duration} s) · ${r.channels} ch · ${r.sampleRate} Hz · peak ${fmtDb(r.peakDb)} · RMS ${fmtDb(r.rmsDb)} · ${r.bars} bars`;
    const legend = document.createElement("p");
    legend.className = "legend";
    legend.innerHTML = '<span><i class="k-peak"></i>peak</span><span><i class="k-rms"></i>RMS</span>';
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      button("Copy JSON", () => copy(formatJson(r), `Copied JSON for ${item.name}.`)),
      button("Download JSON", () => download(`${item.name.replace(/\.[^.]+$/, "")}.waveform.json`, formatJson(r))),
    );
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Show JSON";
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", `JSON for ${item.name}`);
    pre.textContent = formatJson(r);
    details.append(summary, pre);
    card.append(meta, buildSvg(r), legend, actions, details);
  }
  if (!card.parentNode) els.list.append(card);
  els.section.hidden = false;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function syncChrome() {
  const any = items.some((i) => i.result);
  els.section.hidden = items.length === 0;
  els.copyAll.disabled = !any;
  els.downloadAll.disabled = !any;
}

// ------------------------------------------------------------------ copy / download
async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(message);
  } catch {
    // no clipboard permission (or an insecure context): fall back to selecting a hidden text area
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "sr-only";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    setStatus(ok ? message : "Copy was blocked by the browser. Open “Show JSON” and copy from there, or use Download.", !ok);
  }
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Saved ${name}.`);
}

const allResults = () => items.filter((i) => i.result).map((i) => i.result);

// ------------------------------------------------------------------ events
els.files.addEventListener("change", () => {
  addFiles(els.files.files).finally(() => (els.files.value = ""));
});
for (const type of ["dragenter", "dragover"]) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.remove("over");
  });
}
els.drop.addEventListener("drop", (e) => addFiles(e.dataTransfer?.files ?? []));

let timer = 0;
function reanalyse() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    let opts;
    try {
      opts = options();
      resolveOptions(opts);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    for (const item of items) {
      if (!item.audio) continue;
      item.result = { file: item.name, ...analyze(item.audio, opts) };
      renderItem(item);
    }
    if (items.some((i) => i.audio)) setStatus("Updated with the new options.");
  }, 250);
}
els.form.addEventListener("input", reanalyse);
els.form.addEventListener("submit", (e) => e.preventDefault());

els.copyAll.addEventListener("click", () => copy(formatJson(allResults()), `Copied JSON for ${allResults().length} file(s).`));
els.downloadAll.addEventListener("click", () => download("waveforms.json", formatJson(allResults())));
els.clear.addEventListener("click", () => {
  items = [];
  els.list.replaceChildren();
  setStatus("Cleared.");
  syncChrome();
});
syncChrome();
