// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal static file server for the demo and the browser test-suite.
 *   node scripts/serve.ts [--port 8080] [--root .] [--cors]
 * Serves the repository root; the certification corpus cache is mounted at
 * /corpus/ when present. --cors adds Access-Control-Allow-Origin: *.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const port = Number(opt("port", process.env.PORT ?? "8080"));
const root = resolve(opt("root", join(fileURLToPath(import.meta.url), "..", "..")));
const corpusRoot = resolve(process.env.IFC_CORPUS_DIR ?? join(homedir(), ".cache", "ifc-lens", "certification-datasets"));
const cors = args.includes("--cors");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ifc": "application/x-step",
  ".ifczip": "application/zip",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function safeJoin(base: string, urlPath: string): string | undefined {
  const p = normalize(join(base, decodeURIComponent(urlPath)));
  return p === base || p.startsWith(base + sep) ? p : undefined;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file: string | undefined;
  if (url.pathname.startsWith("/corpus/")) file = safeJoin(corpusRoot, url.pathname.slice("/corpus".length));
  else file = safeJoin(root, url.pathname);
  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (cors) headers["access-control-allow-origin"] = "*";
  if (url.pathname === "/__status/500") {
    res.writeHead(500, headers).end("server error");
    return;
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { ...headers, "content-type": "text/plain" }).end("not found");
    return;
  }
  const size = statSync(file).size;
  res.writeHead(200, { ...headers, "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": String(size) });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}/${cors ? " (CORS enabled)" : ""}`);
});
