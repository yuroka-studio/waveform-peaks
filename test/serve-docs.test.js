import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "serve-docs.mjs");

/** GET with the request target sent exactly as given (no normalisation by a client library). */
const get = (port, target) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: target }, (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(parts).toString("utf8") }));
      })
      .on("error", reject);
  });

test("the preview server answers a malformed %-escape with 400 and keeps serving; it never leaves docs/", async () => {
  const server = spawn(process.execPath, [script, "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (c) => (stderr += c));
  try {
    const port = await new Promise((resolve, reject) => {
      let out = "";
      server.stdout.on("data", (c) => {
        out += c;
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
        if (m) resolve(Number(m[1]));
      });
      server.once("exit", () => reject(new Error(`server exited early: ${stderr}`)));
    });
    assert.ok(port > 0);
    for (const bad of ["/%E0%A4%A", "/%", "/%zz", "/docs/%C0%AE%C0%AE/%ff"]) {
      const r = await get(port, bad);
      assert.ok(r.status === 400 || r.status === 404, `${bad} -> ${r.status}`);
    }
    assert.equal((await get(port, "/%E0%A4%A")).status, 400);
    assert.equal(server.exitCode, null, `the server must survive: ${stderr}`);
    const home = await get(port, "/");
    assert.equal(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.body, /<html/i);
    assert.equal((await get(port, "/peaks.js")).status, 200);
    for (const outside of ["/..%2f..%2fpackage.json", "/%2e%2e/package.json", "/../package.json", "/%00"]) {
      assert.equal((await get(port, outside)).status, 404, outside);
    }
    assert.equal(server.exitCode, null, stderr);
  } finally {
    server.kill();
  }
});
