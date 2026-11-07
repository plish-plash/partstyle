import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatComments, nextCommentId, parseComments, parseFocus } from "../review.js";
import { Workspace } from "./workspace.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

describe("review files", () => {
  it("round-trips comments and ignores malformed entries", () => {
    const comments = [
      {
        id: "c1",
        subject: "PWR/U1",
        text: "Why linear?",
        status: "open" as const,
        created: "2026-10-30T00:00:00Z",
      },
    ];
    const text = formatComments(comments);
    expect(text).toMatch(/^# Review comments/);
    expect(parseComments(text)).toEqual(comments);
    expect(parseComments("- {id: 7}\n- not a comment\n")).toEqual([]);
    expect(parseComments("{{{")).toEqual([]);
    expect(nextCommentId([...comments, { ...comments[0], id: "c9" } as (typeof comments)[0]])).toBe(
      "c10",
    );
  });

  it("reads focus, tolerating a byte-order mark and junk", () => {
    expect(parseFocus('﻿{"selection":["PWR/U1"],"sheet":"PWR/"}')).toEqual({
      selection: ["PWR/U1"],
      sheet: "PWR/",
    });
    expect(parseFocus('{"selection":[1,"x"]}')).toEqual({ selection: ["x"] });
    expect(parseFocus("nope")).toEqual({ selection: [] });
  });
});

describe("Workspace review", () => {
  let tmp: string;
  let ws: Workspace;
  let project: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "partstyle-review-"));
    project = path.join(tmp, "examples/bench-sensor");
    await cp(repo("examples/bench-sensor"), project, { recursive: true });
    await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
    // Verifying writes the record, so the settings list this copy of the library.
    await writeFile(path.join(tmp, "settings.yaml"), "libraries: [library]\n");
    ws = new Workspace(project, { stateDir: tmp });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports the viewer selection and open comments through focus", async () => {
    expect((await ws.focus()).text).toBe("nothing selected in the viewer\nno open comments");
    await ws.setFocus({ selection: ["PWR/U1", "+5V", "PWR/U1.IN", "MCU/"], sheet: "PWR/" });
    const c = await ws.addComment("PWR/U1", "Why a linear regulator here?");
    expect(c.id).toBe("c1");
    await ws.setViewerUrl("http://127.0.0.1:7766/");
    expect((await ws.focus()).text.split("\n")).toEqual([
      "selected in the viewer (viewing sheet PWR):",
      "  PWR/U1 lib:L7805CV 5 V 1.5 A linear regulator, TO-220 [unverified]",
      "  net +5V {voltage: 5V} (joins PWR/+5V, AFE/+5V): 7 pins",
      "  pin PWR/U1.IN (pin 1, power_in) on net PWR/+12V",
      "  sheet MCU",
      "open comments (1):",
      "  c1 on PWR/U1: Why a linear regulator here?",
      "viewer: http://127.0.0.1:7766/",
    ]);
    expect((await ws.overview()).text).toContain("comments: 1 open (see focus)");

    expect(await ws.resolveComment("c1")).toEqual({ ok: true, text: "resolved c1" });
    expect(await ws.resolveComment("c9")).toEqual({ ok: false, text: "no comment c9" });
    expect((await ws.focus()).text).toContain("no open comments");
    expect(await readFile(path.join(project, "comments.yaml"), "utf8")).toContain(
      "status: resolved",
    );
  });

  it("marks a part record verified in place", async () => {
    expect(await ws.verifyPart("L7805CV")).toEqual({
      ok: true,
      text: "marked L7805CV verified in ../../library/L7805CV.yaml",
    });
    expect(await readFile(path.join(tmp, "library/L7805CV.yaml"), "utf8")).toContain(
      "verified_by: human",
    );
    expect((await ws.verifyPart("L7805CV")).text).toBe("L7805CV is already verified");
    expect((await ws.verifyPart("NOPE")).ok).toBe(false);
  });

  it("sets a record's inventory flag in place, keeping its comments and style", async () => {
    const file = path.join(tmp, "library/L7805CV.yaml");
    const original = await readFile(file, "utf8");
    await writeFile(file, `# keep this comment\n${original}`);
    const on = await ws.setInInventory("L7805CV", true);
    expect(on.text).toBe("marked L7805CV in inventory in ../../library/L7805CV.yaml");
    const text = await readFile(file, "utf8");
    expect(text).toContain("# keep this comment");
    expect(text).toMatch(/sourcing: \{.*in_inventory: true/);
    expect((await ws.viewerModel()).parts["PWR/U1"]?.record?.inInventory).toBe(true);

    await ws.setInInventory("L7805CV", false);
    expect(await readFile(file, "utf8")).toBe(`# keep this comment\n${original}`);
    expect((await ws.viewerModel()).parts["PWR/U1"]?.record?.inInventory).toBe(false);
    expect((await ws.setInInventory("NOPE", true)).ok).toBe(false);
  });

  it("creates sourcing when setting the flag on a record without it", async () => {
    const file = path.join(tmp, "library/L7805CV.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^sourcing:.*\n/m, ""));
    await ws.setInInventory("L7805CV", true);
    expect((await ws.viewerModel()).parts["PWR/U1"]?.record?.inInventory).toBe(true);
  });

  it("builds a viewer model with sheets, symbols, parts and review state", async () => {
    await writeFile(
      path.join(project, "comments.yaml"),
      formatComments([
        { id: "c1", subject: "PWR/C3", text: "10u enough?", status: "open", created: "" },
      ]),
    );
    const m = await ws.viewerModel();
    expect(m.project).toBe("bench-sensor");
    expect(m.sheets.map((s) => s.block)).toEqual(["main", "power", "sensor_afe", "mcu"]);
    expect(m.sheets.find((s) => s.block === "power")?.instances[0]?.nets["+12V"]).toBe("PWR/+12V");
    expect(m.parts["MCU/U4"]?.record?.requirements).toHaveLength(4);
    expect(m.parts["PWR/C1"]?.ref).toBe("C1");
    for (const s of m.sheets) {
      for (const u of s.layout.units) expect(m.symbols[u.libId]).toBeDefined();
    }
    expect(m.comments).toHaveLength(1);
    // A generic with no part chosen yet is a normal state of designing, not an issue.
    expect(m.parts["PWR/C3"]?.bom.status).toBe("unresolved");
    expect(m.issues.map((i) => i.code)).not.toContain("bom.unresolved");
  });

  it("still returns issues for a design that does not elaborate", async () => {
    await rm(path.join(project, "circuit/main.ckt"));
    const m = await ws.viewerModel();
    expect(m.sheets).toEqual([]);
    expect(m.issues.map((i) => i.code)).toContain("elab.unknown-top");
  });
});
