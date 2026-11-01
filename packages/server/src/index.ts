import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewerModel } from "@partstyle/engine";
import type { Workspace } from "@partstyle/engine/node";

export interface ViewerServer {
  url: string;
  port: number;
  /** Shows another project from now on; open pages reload onto it. */
  switchTo(ws: Workspace): Promise<void>;
  /** Stops the server and the file watchers. */
  close(): Promise<void>;
}

export const DEFAULT_PORT = 7766;
const MAX_BODY = 64 * 1024;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Folders whose changes never affect what the viewer shows (exports, git, local state). */
const ignored = /(^|[\\/])(\.git|node_modules|kicad|\.partstyle)([\\/]|$)|bom\.csv$/;

/**
 * Whether a change (path relative to the project) can change what the viewer shows: project
 * files, a variant's files, or the pending and history state other processes write.
 */
export function relevantChange(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  if (f === ".partstyle/pending.json" || f === ".partstyle/history.json") return true;
  const variant = /^\.partstyle\/variants\/[^/]+\/(.+)$/.exec(f);
  return !ignored.test(variant ? (variant[1] as string) : f);
}

function viewerDist(): string {
  const pkg = fileURLToPath(import.meta.resolve("@partstyle/viewer/package.json"));
  return path.join(path.dirname(pkg), "dist");
}

let embeddedViewer: Map<string, Buffer> | undefined;

/**
 * Serves the web app from these files (path within dist/, e.g. "assets/index.js") instead of
 * the viewer package's dist/: for a standalone executable.
 */
export function embedViewer(files: Record<string, Uint8Array>): void {
  embeddedViewer = new Map(Object.entries(files).map(([p, data]) => [p, Buffer.from(data)]));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // A custom header and JSON content type force a CORS preflight, which this server never
  // answers, so other web pages cannot make the browser post here.
  if (
    req.headers["x-partstyle"] !== "1" ||
    !req.headers["content-type"]?.startsWith("application/json")
  ) {
    throw new HttpError(403, "missing x-partstyle header");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw new HttpError(400, `${name} must be a non-empty string`);
  }
  return v;
};

/**
 * Serves the viewer for one project at a time on 127.0.0.1: the built web app, the drawing
 * model, live change events, and the few writes the viewer makes (focus, comments, part
 * verification). Tries successive ports when the default is taken (several projects can be
 * viewed at once).
 */
export async function startViewer(
  first: Workspace,
  opts: { port?: number } = {},
): Promise<ViewerServer> {
  let ws = first;
  const dist = embeddedViewer ? "" : viewerDist();
  const clients = new Set<ServerResponse>();
  /** Drawings by view ("" for the main line, a variant's name, or "|P1" to preview a patch). */
  const models = new Map<string, Promise<ViewerModel>>();
  let port = opts.port ?? DEFAULT_PORT;

  /** The workspace a request is about: the project, or one of its variants. */
  const target = async (variant: string | null | undefined): Promise<Workspace> => {
    if (!variant) return ws;
    const v = await ws.variantWorkspace(variant);
    if (!v) throw new HttpError(404, `no variant ${variant}`);
    return v;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Only answer requests addressed to this machine by name: blocks DNS-rebinding attacks.
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, "forbidden host");
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/api/model") {
      // The drawing is cached until files change; review and version state are cheap and read
      // fresh, since focus can change from another process without touching watched files.
      const variant = url.searchParams.get("variant") ?? "";
      const preview = url.searchParams.get("preview") ?? "";
      const key = `${variant}|${preview}`;
      const w = await target(variant);
      let model = models.get(key);
      if (!model) {
        model = w.viewerModel(preview ? { preview } : {});
        models.set(key, model);
      }
      try {
        send(200, {
          ...(await model),
          ...(await w.review()),
          versions: await w.versionState(),
          ...(variant && { variant }),
        });
      } catch (e) {
        models.delete(key);
        throw e;
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (url.pathname === "/api/focus") {
        const selection = Array.isArray(body.selection)
          ? body.selection.filter((s): s is string => typeof s === "string").slice(0, 200)
          : [];
        await ws.setFocus({
          selection,
          ...(typeof body.sheet === "string" && { sheet: body.sheet }),
        });
        send(200, { ok: true });
        return;
      }
      if (url.pathname === "/api/comments") {
        send(200, await ws.addComment(str(body.subject, "subject", 300), str(body.text, "text")));
        return;
      }
      const resolve = /^\/api\/comments\/([^/]+)\/resolve$/.exec(url.pathname);
      if (resolve) {
        send(200, await ws.resolveComment(decodeURIComponent(resolve[1] as string)));
        return;
      }
      if (url.pathname === "/api/verify") {
        send(200, await ws.verifyPart(str(body.id, "id", 200)));
        return;
      }
      // Review actions; each may name the variant it applies to.
      const w = await target(typeof body.variant === "string" ? body.variant : undefined);
      if (url.pathname === "/api/revert") {
        send(200, await w.revert(str(body.id, "id", 40)));
        return;
      }
      if (url.pathname === "/api/checkpoint") {
        send(200, await w.checkpoint(str(body.message, "message", 500)));
        return;
      }
      if (url.pathname === "/api/pending") {
        const id = str(body.id, "id", 40);
        if (body.op !== "accept" && body.op !== "reject") throw new HttpError(400, "bad op");
        send(200, await (body.op === "accept" ? w.pendingAccept(id) : w.pendingReject(id)));
        return;
      }
      if (url.pathname === "/api/variant") {
        const op = body.op;
        if (op !== "create" && op !== "adopt" && op !== "remove") {
          throw new HttpError(400, "bad op");
        }
        send(200, await ws.variant(op, str(body.name, "name", 60)));
        return;
      }
      throw new HttpError(404, "not found");
    }
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");

    // The built web app; paths are confined to its folder.
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    let data: Buffer;
    if (embeddedViewer) {
      const found = embeddedViewer.get(rel);
      if (!found) throw new HttpError(404, "not found");
      data = found;
    } else {
      const file = path.resolve(dist, rel);
      if (!file.startsWith(dist + path.sep)) throw new HttpError(404, "not found");
      try {
        data = await readFile(file);
      } catch {
        if (rel === "index.html") throw new HttpError(500, "viewer not built: run pnpm build");
        throw new HttpError(404, "not found");
      }
    }
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(rel)] ?? "application/octet-stream",
    });
    res.end(data);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(e instanceof Error ? e.message : String(e));
    });
  });

  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (!busy || opts.port !== undefined || attempt >= 20) throw e;
      port++;
    }
  }
  // Port 0 asks the OS for a free port; the host check needs the real one.
  port = (server.address() as AddressInfo).port;

  // Live reload: any change to the project or its part libraries refreshes every viewer.
  let timer: NodeJS.Timeout | undefined;
  const changed = (file: string | null) => {
    if (file && !relevantChange(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      models.clear();
      for (const c of clients) c.write("event: change\ndata: {}\n\n");
    }, 150);
  };
  let watchers: FSWatcher[] = [];
  const watchProject = async () => {
    for (const w of watchers) w.close();
    watchers = [];
    for (const dir of [ws.root, ...(await ws.libraryDirs())]) {
      try {
        watchers.push(watch(dir, { recursive: true }, (_event, file) => changed(file)));
      } catch {
        // A missing library folder is reported by validation; nothing to watch.
      }
    }
  };
  await watchProject();
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 25_000);

  const url = `http://127.0.0.1:${port}/`;
  await ws.setViewerUrl(url);
  return {
    url,
    port,
    switchTo: async (next) => {
      if (next.root === ws.root) return;
      await ws.setViewerUrl(undefined);
      ws = next;
      models.clear();
      await watchProject();
      await ws.setViewerUrl(url);
      const data = JSON.stringify({ project: await ws.name() });
      for (const c of clients) c.write(`event: project\ndata: ${data}\n\n`);
    },
    close: async () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const c of clients) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ws.setViewerUrl(undefined);
    },
  };
}
