// Tiny static server for previewing docs/ locally (ES modules do not load from file://).
// Usage: node scripts/serve-docs.mjs [port]     then open http://127.0.0.1:8080/   (port 0 picks a free one)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const port = Number(process.argv[2] ?? 8080);

/** The file under docs/ that a request path names, or null (not found, outside docs/, or a malformed %-escape). */
function resolveRequest(rawUrl) {
  let rel;
  try {
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return undefined; // URIError / invalid URL: the client sent garbage
  }
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

const server = http.createServer((req, res) => {
  const file = resolveRequest(req.url ?? "/");
  if (file === undefined) {
    res.writeHead(400).end("bad request");
    return;
  }
  if (file === null) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file)
    .on("error", () => res.destroy()) // e.g. the file vanished after the check: drop the connection, keep serving
    .pipe(res);
});

server.listen(port, "127.0.0.1", () => console.log(`docs/ at http://127.0.0.1:${server.address().port}/`));
