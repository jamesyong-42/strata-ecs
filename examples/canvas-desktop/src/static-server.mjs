/**
 * The packaged renderer's origin. In dev the canvas-editor is a vite server (CANVAS_URL); packaged,
 * there is no server, so main starts THIS one — a loopback static server over the built dist. An
 * http origin (not file://) is required, not cosmetic: the renderer imports loro's wasm-bindgen glue,
 * and a browser refuses `fetch()` of a `file://` URL, so the wasm never loads under file://. Serving
 * over http mirrors CANVAS_URL exactly — every other line of main.mjs (loadURL `${origin}/?collab=…`)
 * stays byte-for-byte the same as the dev path.
 *
 * The COOP/COEP headers replicate vite.config.ts's `isolationHeaders`: they put the page in a
 * cross-origin-isolated context so `performance.now()` keeps microsecond resolution (the HUD's timing
 * claims). The app already runs under them in dev, so nothing it loads is COEP-incompatible; all
 * assets are same-origin off this server, so require-corp needs no per-asset CORP.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Extension → Content-Type. `.wasm` MUST be application/wasm or the browser won't stream-compile it. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/** Cross-origin isolation, matching the vite dev/preview server so the packaged app behaves identically. */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Serve `rootDir` (the built canvas-editor dist) over loopback. Resolves to `{ origin, close }`;
 * `origin` is `http://127.0.0.1:<port>` with an OS-assigned port (no fixed port to collide with).
 * Reads happen through `fs` so the dist can live inside the asar (Electron reads asar paths as files).
 *
 * @param {string} rootDir absolute path to the directory to serve
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
export function startStaticServer(rootDir, log = () => {}) {
  const root = path.resolve(rootDir);
  const server = createServer(async (req, res) => {
    try {
      // Path only; drop the query (?collab=…) and any #fragment before mapping to a file.
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]);
      // Resolve within root and reject any escape (`..`, absolute) — this server is loopback-only,
      // but a traversal guard is two comparisons and keeps it honest.
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      let filePath = path.join(root, rel);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      let body;
      try {
        body = await readFile(filePath);
      } catch {
        // SPA fallback: an unknown path (no extension = a client route) serves index.html; a missing
        // ASSET (has an extension) is a genuine 404.
        if (path.extname(filePath) !== "") {
          res.writeHead(404).end("not found");
          return;
        }
        filePath = path.join(root, "index.html");
        body = await readFile(filePath);
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": body.length,
        ...ISOLATION_HEADERS,
      });
      res.end(body);
    } catch (err) {
      log(`static-server 500: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end("internal error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
      const origin = `http://127.0.0.1:${port}`;
      log(`renderer served at ${origin} (from ${root})`);
      resolve({
        origin,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
