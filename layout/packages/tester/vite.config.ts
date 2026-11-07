import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const dirs = {
  baselines: join(root, "baselines"),
  presets: join(root, "presets"),
  feedback: join(root, "feedback"),
};
const notesFile = join(dirs.feedback, "notes.json");
const historyFile = join(dirs.feedback, "history.jsonl");

const validName = (name: string) => /^[\w-]{1,60}$/.test(name);

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const readJson = (file: string, fallback: unknown): unknown =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Stores what the tester saves as plain files in the repo, where they can be read and diffed. */
function testerApi(): Plugin {
  const named = (dir: string) =>
    (existsSync(dir) ? readdirSync(dir) : [])
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();

  return {
    name: "tester-api",
    configureServer(server) {
      // Notes also change from the command line, and an open tester should show that at once.
      server.watcher.add(notesFile);
      server.watcher.on("change", (file) => {
        if (resolve(file) === resolve(notesFile)) server.ws.send("tester:notes", {});
      });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/api/")) return next();
        const [kind, name] = url.pathname.slice(5).split("/").filter(Boolean);
        try {
          if (kind === "feedback") {
            if (req.method === "GET") return send(res, 200, readJson(notesFile, { cases: {} }));
            if (req.method === "POST") {
              const { caseId, snapshot, ...entry } = (await readBody(req)) as {
                caseId: string;
                snapshot?: unknown;
              } & Record<string, unknown>;
              if (!validName(caseId)) return send(res, 400, { error: "bad case id" });
              const notes = readJson(notesFile, { cases: {} }) as {
                cases: Record<string, { note?: string; verdict?: string } | undefined>;
              };
              const before = notes.cases[caseId];
              if (before?.note && !entry.note) {
                const record = { caseId, ...before, resolution: "Cleared in the tester" };
                const at = new Date().toISOString();
                mkdirSync(dirs.feedback, { recursive: true });
                appendFileSync(historyFile, `${JSON.stringify({ ...record, at })}\n`);
              }
              notes.cases[caseId] = { ...entry, updatedAt: new Date().toISOString() };
              writeJson(notesFile, notes);
              if (snapshot) writeJson(join(dirs.feedback, "snapshots", `${caseId}.json`), snapshot);
              return send(res, 200, notes);
            }
          }
          if (kind === "baselines" || kind === "presets") {
            const dir = dirs[kind];
            if (!name) return send(res, 200, named(dir));
            if (!validName(name)) return send(res, 400, { error: "bad name" });
            const file = join(dir, `${name}.json`);
            if (req.method === "GET") {
              if (!existsSync(file)) return send(res, 404, { error: "not found" });
              return send(res, 200, readJson(file, null));
            }
            if (req.method === "PUT") {
              writeJson(file, await readBody(req));
              return send(res, 200, { ok: true });
            }
          }
          send(res, 404, { error: "unknown route" });
        } catch (e) {
          send(res, 500, { error: String(e) });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), testerApi()],
  // Source, not the built package, so engine edits hot-reload.
  resolve: { alias: { "@partstyle/layout": resolve(root, "packages/layout/src/index.ts") } },
  server: { port: 5173, strictPort: true },
});
