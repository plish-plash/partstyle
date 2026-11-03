import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workspace } from "./workspace.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

describe("setLayout", () => {
  let tmp: string;
  let project: string;
  let ws: Workspace;
  const afe = () => readFile(path.join(project, "circuit", "sensor_afe.ckt"), "utf8");
  const line = async (ref: string) =>
    (await afe()).split(/\r?\n/).find((l) => l.startsWith(`part ${ref} `)) ?? "";

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "partstyle-layout-"));
    project = path.join(tmp, "examples", "bench-sensor");
    await cp(repo("examples/bench-sensor"), project, { recursive: true });
    await cp(repo("library"), path.join(tmp, "library"), { recursive: true });
    await rm(path.join(project, ".partstyle"), { recursive: true, force: true });
    ws = new Workspace(project);
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("turns a two-terminal part and refuses to turn anything else", async () => {
    const r = await ws.setLayout("sensor_afe", "R4", "rotate");
    expect(r.ok).toBe(true);
    expect(await line("R4")).toMatch(/^part R4 res\(100k, 1%, 0603\) \[r90\]/);
    // No stages are written for a turn.
    expect(await afe()).not.toMatch(/\[\d/);
    expect((await ws.setLayout("sensor_afe", "U3", "rotate")).ok).toBe(false);
  });

  it("flips a part from how it is drawn now, keeping its intent", async () => {
    // J2 is mirrored automatically to face its circuit: flipping it puts it back.
    expect((await ws.setLayout("sensor_afe", "J2", "flip")).ok).toBe(true);
    expect(await line("J2")).toBe(
      "part J2 lib:TSW-103-07-G-S [noflip] @ remote sensor: 1 = signal, 2 = +5V, 3 = GND",
    );
  });

  it("freezes every group's stage on the first stage edit", async () => {
    expect((await ws.setLayout("sensor_afe", "U3", "later")).ok).toBe(true);
    expect(await line("J2")).toMatch(/\[1 noflip\]/);
    expect(await line("U3")).toMatch(/\[3\]/);
    // Riders keep riding: only group heads get stages.
    expect(await line("C6")).not.toMatch(/\[/);
    expect((await ws.setLayout("sensor_afe", "U3", "earlier")).ok).toBe(true);
    expect(await line("U3")).toMatch(/\[2\]/);
  });

  it("moves a rider's whole group rather than splitting the rider off", async () => {
    // C7 hangs off R3 in U3's group: its stage buttons move U3, and C7 gets no hint.
    expect((await ws.setLayout("sensor_afe", "C7", "later")).ok).toBe(true);
    expect(await line("U3")).toMatch(/\[3\]/);
    expect(await line("C7")).not.toMatch(/\[/);
    expect((await ws.setLayout("sensor_afe", "C7", "earlier")).ok).toBe(true);
    expect(await line("U3")).toMatch(/\[2\]/);
  });

  it("clears a hint and logs every edit as a change", async () => {
    expect((await ws.setLayout("sensor_afe", "R4", "reset")).ok).toBe(true);
    expect(await line("R4")).toBe(
      "part R4 res(100k, 1%, 0603) @ reads 0 V when the sensor is unplugged",
    );
    const changes = (await ws.changes()).text;
    expect(changes).toContain("layout");
    // The AI's diff folds layout edits into one line per block.
    expect((await ws.diff()).text).toMatch(/layout edited: /);
  });
});
