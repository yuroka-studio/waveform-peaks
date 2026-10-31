import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const snippet = /<!-- snippet: bars-svg -->\s*```js\n([\s\S]*?)```/.exec(readme)?.[1];

test("README has the framework-free SVG snippet, and it works", () => {
  assert.ok(snippet, "snippet marker not found");
  const barsSvg = new Function(`${snippet}\nreturn barsSvg;`)();
  const peaks = [0, 0.25, 0.5, 1];
  const svg = barsSvg(peaks, { width: 100, height: 40, gap: 2, progress: 0.5, base: "#111111", fill: "#22cc22" });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 100 40"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 4);
  assert.equal((svg.match(/fill="#22cc22"/g) ?? []).length, 2); // the first half is "played"
  assert.equal((svg.match(/fill="#111111"/g) ?? []).length, 2);
  assert.match(svg, /height="40\.00"/); // a full-scale bar fills the height
  assert.match(svg, /height="2\.00"/); // silence still draws a 2px stub
  assert.equal(barsSvg(peaks).includes('fill="#5fd0c4"'), false); // no progress, nothing filled
  assert.ok(svg.endsWith("</svg>"));
});

test("README states what the browser page promises, and the page really has a strict CSP and no external URLs", () => {
  const html = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
  assert.match(html, /Content-Security-Policy" content="[^"]*default-src 'none'[^"]*connect-src 'none'/);
  for (const file of ["index.html", "app.js", "style.css", "peaks.js"]) {
    const text = fs.readFileSync(path.join(root, "docs", file), "utf8");
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(text), `${file} mentions an external URL`);
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource)\b/.test(text.replace(/\/\/.*$/gm, "")), `${file} contains network code`);
  }
});

test("the CLI and the page share one algorithm file", async () => {
  const fromCli = await import("../src/index.js");
  const fromDocs = await import("../docs/peaks.js");
  assert.equal(fromCli.analyze, fromDocs.analyze);
  assert.equal(fromCli.Analyzer, fromDocs.Analyzer);
});
