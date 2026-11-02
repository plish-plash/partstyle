import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "@partstyle/engine/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relevantChange, startViewer, type ViewerServer } from "./index.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const viewerBuilt = existsSync(repo("packages/viewer/dist/index.html"));

let tmp: string;
let project: string;
let viewer: ViewerServer;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "partstyle-server-"));
  project = path.join(tmp, "examples/bench-sensor");
  await cp(repo("examples/bench-sensor"), project, { recursive: true });
  await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
  viewer = await startViewer(new Workspace(project), { port: 0 });
});
afterEach(async () => {
  await viewer.close();
  await rm(tmp, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(new URL(url, viewer.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-partstyle": "1", ...headers },
    body: JSON.stringify(body),
  });

describe("viewer server", () => {
  it("serves the drawing model and records where it runs", async () => {
    const res = await fetch(new URL("api/model", viewer.url));
    expect(res.status).toBe(200);
    const model = (await res.json()) as { project: string; sheets: unknown[] };
    expect(model.project).toBe("bench-sensor");
    expect(model.sheets).toHaveLength(4);
    expect(
      JSON.parse(await readFile(path.join(project, ".partstyle/viewer.json"), "utf8")).url,
    ).toBe(viewer.url);
  });

  it("refuses foreign hosts, writes without its header, and paths outside the app", async () => {
    const { request } = await import("node:http");
    const status = (headers: Record<string, string>, p = "/api/model") =>
      new Promise<number>((resolve) => {
        request({ host: "127.0.0.1", port: viewer.port, path: p, headers }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        }).end();
      });
    expect(await status({ host: `evil.example:${viewer.port}` })).toBe(403);
    expect(await status({ host: `localhost:${viewer.port}` })).toBe(200);
    expect(await status({ host: `127.0.0.1:${viewer.port}` }, "/../../package.json")).toBe(404);
    expect((await post("api/focus", { selection: [] }, { "x-partstyle": "0" })).status).toBe(403);
    expect((await post("api/comments", { subject: "", text: "x" })).status).toBe(400);
  });

  it("stores focus and comments where the CLI and MCP read them", async () => {
    expect((await post("api/focus", { selection: ["PWR/U1"], sheet: "PWR/" })).status).toBe(200);
    const comment = (await (
      await post("api/comments", { subject: "PWR/U1", text: "why?" })
    ).json()) as {
      id: string;
    };
    expect(comment.id).toBe("c1");
    const text = (await new Workspace(project).focus()).text;
    expect(text).toContain("PWR/U1 lib:L7805CV");
    expect(text).toContain("c1 on PWR/U1: why?");
    // Focus is read fresh even though the drawing is cached.
    const model = (await (await fetch(new URL("api/model", viewer.url))).json()) as {
      focus: { selection: string[] };
      comments: unknown[];
    };
    expect(model.focus.selection).toEqual(["PWR/U1"]);
    expect((await post("api/comments/c1/resolve", {})).status).toBe(200);
  });

  it("announces file changes to connected viewers", async () => {
    const res = await fetch(new URL("api/events", viewer.url));
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no event stream");
    const decoder = new TextDecoder();
    let seen = decoder.decode((await reader.read()).value);
    expect(seen).toContain(": connected");
    const ckt = path.join(project, "circuit/power.ckt");
    await writeFile(ckt, `${await readFile(ckt, "utf8")}\n# touched\n`);
    while (!seen.includes("event: change")) seen += decoder.decode((await reader.read()).value);
    await reader.cancel();
  });

  it("adds version state to the model, and reverts changesets", async () => {
    const ckt = path.join(project, "circuit/power.ckt");
    const before = await readFile(ckt, "utf8");
    await writeFile(ckt, before.replace("part C2  cap(100n", "part C2  cap(220n"));
    const model = (await (await fetch(new URL("api/model", viewer.url))).json()) as {
      versions: { git: boolean; changesets: { id: string }[]; changed: unknown[] };
    };
    expect(model.versions.git).toBe(false);
    expect(model.versions.changesets.map((c) => c.id)).toEqual(["C1"]);
    expect(model.versions.changed).toEqual([{ block: "power", kind: "part", key: "C2", op: "~" }]);
    const r = (await (await post("api/revert", { id: "C1" })).json()) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(await readFile(ckt, "utf8")).toContain("part C2 cap(100n");
    expect((await fetch(new URL("api/model?variant=nope", viewer.url))).status).toBe(404);
  });

  it("edits a part's layout and refuses unknown edits", async () => {
    const r = (await (
      await post("api/layout", { block: "sensor_afe", ref: "R4", op: "rotate" })
    ).json()) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(await readFile(path.join(project, "circuit/sensor_afe.ckt"), "utf8")).toContain(
      "part R4 res(100k, 1%, 0603) [r90]",
    );
    expect((await post("api/layout", { block: "sensor_afe", ref: "R4", op: "nudge" })).status).toBe(
      400,
    );
  });

  it("switches to another project, telling open pages", async () => {
    const other = new Workspace(path.join(tmp, "other"));
    await other.init({ name: "other" });
    const res = await fetch(new URL("api/events", viewer.url));
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no event stream");
    const decoder = new TextDecoder();
    let seen = decoder.decode((await reader.read()).value);
    await viewer.switchTo(other);
    while (!seen.includes("event: project")) seen += decoder.decode((await reader.read()).value);
    await reader.cancel();
    expect(seen).toContain('data: {"project":"other"}');
    const model = (await (await fetch(new URL("api/model", viewer.url))).json()) as {
      project: string;
    };
    expect(model.project).toBe("other");
    // Where the viewer runs moves with it.
    expect(existsSync(path.join(project, ".partstyle/viewer.json"))).toBe(false);
    expect(existsSync(path.join(other.root, ".partstyle/viewer.json"))).toBe(true);
  });

  it("wakes for project, variant and review-state changes only", () => {
    expect(relevantChange("circuit/power.ckt")).toBe(true);
    expect(relevantChange(".partstyle/focus.json")).toBe(false);
    expect(relevantChange(".partstyle/pending.json")).toBe(true);
    expect(relevantChange(".partstyle/history.json")).toBe(true);
    expect(relevantChange(".partstyle\\variants\\buck\\examples\\b\\circuit\\power.ckt")).toBe(
      true,
    );
    expect(relevantChange(".partstyle/variants/buck/.git")).toBe(false);
    expect(relevantChange("kicad/x.kicad_sch")).toBe(false);
  });

  it.skipIf(!viewerBuilt)("serves the built web app", async () => {
    const res = await fetch(viewer.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app">');
  });
});
