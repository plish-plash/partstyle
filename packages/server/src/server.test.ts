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
  // Without .partstyle/: local state left by running the example is not part of it.
  await cp(repo("examples/bench-sensor"), project, {
    recursive: true,
    filter: (src) => path.basename(src) !== ".partstyle",
  });
  await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
  // The viewer can verify records, so the settings list this copy of the library.
  await writeFile(path.join(tmp, "settings.yaml"), "libraries: [library]\n");
  viewer = await startViewer(new Workspace(project, { stateDir: tmp }), { port: 0 });
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
    expect((await post("api/focus", { selection: ["U1"], sheet: "PWR/" })).status).toBe(200);
    const comment = (await (
      await post("api/comments", { subject: "U1", text: "why?" })
    ).json()) as {
      id: string;
    };
    expect(comment.id).toBe("c1");
    const text = (await new Workspace(project).focus()).text;
    expect(text).toContain("U1 lib:L7805CV");
    expect(text).toContain("c1 on U1: why?");
    // Focus is read fresh even though the drawing is cached.
    const model = (await (await fetch(new URL("api/model", viewer.url))).json()) as {
      focus: { selection: string[] };
      comments: unknown[];
    };
    expect(model.focus.selection).toEqual(["U1"]);
    expect((await post("api/comments/c1/resolve", {})).status).toBe(200);
  });

  it("signs off parts for the person, and only from its own page", async () => {
    const parts = ["U1", "R5"];
    const refused = await fetch(new URL("api/approve", viewer.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    });
    expect(refused.status).toBe(403);
    const r = (await (await post("api/approve", { parts })).json()) as { text: string };
    expect(r.text).toBe("approved 2 parts: U1 R5");
    expect(await readFile(path.join(project, "approvals.yaml"), "utf8")).toContain("by: person");
    await post("api/approve", { parts: ["R5"], undo: true });
    const file = await readFile(path.join(project, "approvals.yaml"), "utf8");
    expect(file).toContain("U1:");
    expect(file).not.toContain("R5:");
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
    // Read once first, as an open viewer would have, so the edit becomes a changeset.
    await new Workspace(project, { stateDir: tmp }).validate();
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

  it("sets the review mode for the project", async () => {
    const mode = async () =>
      (
        (await (await fetch(new URL("api/model", viewer.url))).json()) as {
          versions: { mode: string };
        }
      ).versions.mode;
    expect(await mode()).toBe("auto");
    expect((await post("api/review-mode", { mode: "accept" })).status).toBe(200);
    expect(await mode()).toBe("accept");
    expect(await readFile(path.join(project, ".partstyle/review.json"), "utf8")).toContain(
      "accept",
    );
    expect((await post("api/review-mode", { mode: "sometimes" })).status).toBe(400);
  });

  it("redraws with layout preferences straight away, and refuses bad ones", async () => {
    const model = async () =>
      (await (await fetch(new URL("api/model", viewer.url))).json()) as {
        layout: { groups: { rule: string }[]; values: Record<string, Record<string, unknown>> };
        sheets: { block: string; layout: unknown }[];
      };
    const before = await model();
    expect(before.layout.groups.length).toBeGreaterThan(0);
    const set = { rule: "pack-groups", key: "gap", value: 12 };
    expect((await post("api/layout", set)).status).toBe(200);
    const after = await model();
    expect(after.layout.values).toEqual({ "pack-groups": { gap: 12 } });
    expect(after.sheets).not.toEqual(before.sheets);

    const bad = await post("api/layout", { ...set, value: 99 });
    expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);
    expect((await post("api/layout", { ...set, value: true })).status).toBe(400);

    expect((await post("api/layout", { reset: true })).status).toBe(200);
    expect((await model()).layout.values).toEqual({});
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
    expect(relevantChange(".partstyle/review.json")).toBe(true);
    expect(relevantChange("variants\\buck\\circuit\\power.ckt")).toBe(true);
    expect(relevantChange(".partstyle/variants/buck/history.json")).toBe(true);
    expect(relevantChange(".partstyle/variants/buck/other.json")).toBe(false);
    expect(relevantChange("variants/buck/kicad/x.kicad_sch")).toBe(false);
    expect(relevantChange("kicad/x.kicad_sch")).toBe(false);
  });

  it("shows a variant and creates one", async () => {
    const created = await post("api/variant", {
      op: "create",
      name: "buck",
      description: "try it",
    });
    expect(((await created.json()) as { ok: boolean }).ok).toBe(true);
    const model = (await (await fetch(new URL("api/model?variant=buck", viewer.url))).json()) as {
      versions: { variants: { name: string; description: string }[]; vsMain: unknown[] };
    };
    expect(model.versions.variants).toEqual([
      { name: "buck", description: "try it", projectFile: false, blocks: [], diverged: [] },
    ]);
    expect(model.versions.vsMain).toEqual([]);
  });

  it.skipIf(!viewerBuilt)("serves the built web app", async () => {
    const res = await fetch(viewer.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app">');
  });
});
