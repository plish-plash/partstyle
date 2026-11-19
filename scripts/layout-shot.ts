/**
 * Screenshots a project's sheets in the viewer's ?shot mode, from source (only the viewer page
 * needs building):
 *
 *   pnpm layout-shot -p DIR [SHOT...] [--out DIR] [--width PX] [--grid] [--select A,B]
 *
 * A SHOT is a sheet (block name or instance prefix; empty or omitted for the top sheet),
 * optionally followed by @x,y,w,h for a region in sheet grid units (2.54 mm, as layout-report
 * prints them): `main`, `PWR@10,20,40,30`. With no SHOT, every page is taken. One headless Edge
 * takes all of them, and the design is laid out once. Each PNG's path is printed.
 *
 * Edge is found at its usual Windows paths, or at EDGE (or CHROME, any Chromium) when set.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ViewerModel } from "@partstyle/engine";
import { Workspace } from "@partstyle/engine/node";
import { startViewer } from "@partstyle/server";

const USAGE =
  "usage: pnpm layout-shot -p DIR [SHEET[@x,y,w,h]...] [--out DIR] [--width PX] [--grid] [--select A,B] [--variant NAME]";

function parseArgs(argv: string[]) {
  const out = {
    project: undefined as string | undefined,
    shots: [] as string[],
    out: undefined as string | undefined,
    width: 1600,
    grid: false,
    select: undefined as string | undefined,
    variant: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "-p" || a === "--project") out.project = value();
    else if (a === "--out") out.out = value();
    else if (a === "--width") out.width = Number(value());
    else if (a === "--grid") out.grid = true;
    else if (a === "--select") out.select = value();
    else if (a === "--variant") out.variant = value();
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (!a.startsWith("--")) out.shots.push(a);
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return out;
}

function findBrowser(): string {
  const candidates = [
    process.env.EDGE,
    process.env.CHROME,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((c): c is string => c !== undefined && existsSync(c));
  if (!found) throw new Error("no Edge or Chrome found; set EDGE to its executable");
  return found;
}

/** A minimal Chrome DevTools Protocol client over the browser's WebSocket. */
class Cdp {
  private next = 1;
  private waiting = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.fail(new Error(msg.error.message));
      else w.done(msg.result);
    });
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((done, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => done(new Cdp(ws)));
      ws.addEventListener("error", () => fail(new Error(`cannot connect to ${url}`)));
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((done, fail) => {
      this.waiting.set(id, { done: done as (v: unknown) => void, fail });
    });
  }

  close() {
    this.ws.close();
  }
}

/** Starts the browser headless and returns its DevTools WebSocket URL. */
function launch(exe: string, profile: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error(`browser did not start:\n${text}`)), 20_000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (m) {
        clearTimeout(timer);
        done({ proc, url: m[1] as string });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`browser exited (${code}):\n${text}`));
    });
  });
}

interface Shot {
  /** Prefix of the sheet's page ("" for the top). */
  prefix: string;
  label: string;
  /** Region in sheet grid units. */
  region?: [number, number, number, number];
  /** Sheet size in mm, for the window's aspect. */
  size: { w: number; h: number };
}

function planShots(model: ViewerModel, specs: string[]): Shot[] {
  const pages = model.sheets
    .flatMap((s) =>
      s.instances.map((i) => ({
        block: s.block,
        prefix: i.prefix,
        page: i.page,
        size: { w: s.layout.width, h: s.layout.height },
      })),
    )
    .sort((a, b) => a.page - b.page);
  if (pages.length === 0) throw new Error("nothing to draw: the design has errors");
  const list = specs.length > 0 ? specs : pages.map((p) => p.prefix);
  return list.map((spec) => {
    const [name = "", region] = spec.split("@");
    const want = name.replace(/\/$/, "");
    const page =
      want === ""
        ? pages[0]
        : (pages.find((p) => p.prefix === `${want}/`) ?? pages.find((p) => p.block === want));
    if (!page)
      throw new Error(
        `no sheet ${want}; pages: ${pages.map((p) => p.prefix || p.block).join(", ")}`,
      );
    const r = region?.split(",").map(Number);
    if (r && (r.length !== 4 || r.some((n) => !Number.isFinite(n)))) {
      throw new Error(`bad region in ${spec}: want x,y,w,h`);
    }
    const base = page.prefix === "" ? page.block : page.prefix.slice(0, -1);
    return {
      prefix: page.prefix,
      label: (r ? `${base}@${r.join(",")}` : base).replace(/[^\w@,.-]+/g, "_"),
      size: page.size,
      ...(r && { region: r as [number, number, number, number] }),
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error(USAGE);
  const started = performance.now();
  const ws = new Workspace(args.project);
  const out = path.resolve(args.out ?? path.join(ws.root, ".partstyle", "shots"));
  mkdirSync(out, { recursive: true });

  const server = await startViewer(ws, { port: 0, snapshot: true });
  const profile = mkdtempSync(path.join(os.tmpdir(), "partstyle-shot-"));
  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    // Laying out once here also fills the server's cache for every page load below.
    const q = args.variant ? `?variant=${encodeURIComponent(args.variant)}` : "";
    const res = await fetch(`${server.url}api/model${q}`);
    if (!res.ok) throw new Error(await res.text());
    const shots = planShots((await res.json()) as ViewerModel, args.shots);
    const laidOut = performance.now();

    const launched = await launch(findBrowser(), profile);
    browser = launched.proc;
    cdp = await Cdp.open(launched.url);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = <T = Record<string, unknown>>(method: string, params = {}) =>
      (cdp as Cdp).send<T>(method, params, sessionId);

    for (const shot of shots) {
      // The window takes the sheet's (or region's) aspect, so the picture has no blank bands.
      const [w, h] = shot.region
        ? [shot.region[2], shot.region[3]]
        : [Math.max(shot.size.w, 60), Math.max(shot.size.h, 40)];
      const width = Math.round(args.width);
      const height = Math.max(200, Math.min(4000, Math.round((width * h) / w)));
      await page("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const params = new URLSearchParams({ shot: "1", sheet: shot.prefix });
      if (args.variant) params.set("variant", args.variant);
      if (args.grid) params.set("grid", "1");
      if (args.select) params.set("select", args.select);
      if (shot.region) params.set("region", shot.region.join(","));
      await page("Page.navigate", { url: `${server.url}?${params}` });

      const deadline = Date.now() + 20_000;
      for (;;) {
        const { result } = await page<{ result: { value?: string } }>("Runtime.evaluate", {
          expression:
            "JSON.stringify([document.documentElement.dataset.ready ?? '', document.documentElement.dataset.error ?? ''])",
          returnByValue: true,
        });
        const [ready, error] = JSON.parse(result.value ?? '["",""]') as [string, string];
        if (ready === "1") break;
        if (ready === "error") throw new Error(`${shot.label}: ${error}`);
        if (Date.now() > deadline) throw new Error(`${shot.label}: the page did not finish`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const { data } = await page<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const file = path.join(out, `${shot.label}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`${file} (${width}x${height})`);
    }
    const ms = (t: number) => `${Math.round(t)} ms`;
    console.log(
      `${shots.length} shots in ${ms(performance.now() - started)} (layout ${ms(laidOut - started)})`,
    );
  } finally {
    cdp?.close();
    browser?.kill();
    await server.close();
    // The browser holds its profile open for a moment after it is told to exit.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
