import type { BomEntry } from "../bom.js";
import type { CktFile, PortKind } from "../ckt/ast.js";
import type { FlatNet, Netlist } from "../netlist/elaborate.js";
import type { Annotation } from "./annotate.js";
import { type PowerSymbol, placePower, powerLibrary, type SymbolLib } from "./power.js";
import { type SExpr, sym, writeSExpr, yesNo } from "./sexpr.js";
import {
  effects,
  type GeneratedSymbol,
  GRID,
  LIB,
  property,
  qualified,
  symbolForGeneric,
  symbolForRecord,
} from "./symbols.js";
import { stableUuid } from "./uuid.js";

export const SCH_VERSION = 20260306;
export const SYM_LIB_VERSION = 20251024;
const GENERATOR = "partstyle";

/** One placement of a block in the sheet hierarchy. */
export interface SheetInstance {
  /** Instance path prefix of the parts inside: "" for the top block, "PWR/" for `use power as PWR`. */
  prefix: string;
  block: CktFile;
  /** KiCad sheet path: "/<root uuid>" or "/<root uuid>/<sheet uuid>...". */
  path: string;
  /** KiCad hierarchical name: "/" or "/PWR/". */
  names: string;
  page: number;
  file: string;
}

export interface SchematicInput {
  project: string;
  blocks: CktFile[];
  top: string;
  netlist: Netlist;
  annotation: Annotation;
  /** BOM entries by part path: value, footprint and the resolved record. */
  bom: Map<string, BomEntry>;
  /** KiCad's `power` symbol library, when installed; fallbacks are used otherwise. */
  powerLib?: SymbolLib;
}

export interface SchematicOutput {
  /** File name (relative to the KiCad folder) → text. */
  files: Map<string, string>;
  instances: SheetInstance[];
  /** Symbol UUID for a part path, for the netlist's tstamps. */
  symbolUuid: (path: string) => string;
  /** Generated symbols for the project library (power symbols come from KiCad's library). */
  symbols: GeneratedSymbol[];
  /** The name KiCad gives each flat net: the power name for power nets, else `/<path>`. */
  netNames: Map<string, string>;
  powerFlags: number;
}

type Point = { x: number; y: number };

const shapeOf: Record<PortKind, string> = {
  power_in: "input",
  input: "input",
  power_out: "output",
  output: "output",
  bidir: "bidirectional",
  passive: "passive",
  ground: "passive",
};

const snap = (v: number) => Math.round(v / GRID) * GRID;

const papers: [name: string, w: number, h: number][] = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
  ["A0", 1189, 841],
];

/** The flat refdes of a part path, falling back to its local refdes. */
const refOf = (annotation: Annotation, path: string) =>
  annotation.get(path) ?? path.slice(path.lastIndexOf("/") + 1);

const bare = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** Nets drawn with power symbols: anything with power pins or passing through a power/ground port. */
const isPowerNet = (n: FlatNet) =>
  n.pins.some((p) => p.type === "power_in" || p.type === "power_out") ||
  n.portKinds.some((k) => k === "ground" || k === "power_in" || k === "power_out");

export function buildSchematics(input: SchematicInput): SchematicOutput {
  const { project, annotation } = input;
  const blocks = new Map(input.blocks.map((b) => [b.block.name, b]));
  const top = blocks.get(input.top);
  if (!top) throw new Error(`top block ${input.top} not found`);
  const power = powerLibrary(input.powerLib);

  const rootUuid = stableUuid(project, "root");
  const fileOf = (block: string) =>
    block === input.top
      ? `${project}.kicad_sch`
      : `${block === project ? `${block}_block` : block}.kicad_sch`;
  const sheetUuid = (parentBlock: string, instance: string) =>
    stableUuid(project, "sheet", parentBlock, instance);
  const symbolUuidFor = (block: string, ref: string) => stableUuid(project, "symbol", block, ref);

  // Walk the hierarchy depth-first to number pages and collect every instance of every block.
  const instances: SheetInstance[] = [];
  const visit = (block: CktFile, prefix: string, path: string, names: string) => {
    instances.push({
      prefix,
      block,
      path,
      names,
      page: instances.length + 1,
      file: fileOf(block.block.name),
    });
    for (const u of block.uses) {
      const child = blocks.get(u.block);
      if (!child) continue;
      visit(
        child,
        `${prefix}${u.instance}/`,
        `${path}/${sheetUuid(block.block.name, u.instance)}`,
        `${names}${u.instance}/`,
      );
    }
  };
  visit(top, "", `/${rootUuid}`, "/");
  const instancesOf = (block: string) => instances.filter((i) => i.block.block.name === block);

  // Power net names are global in KiCad: the bare net name when no other net shares it,
  // otherwise the instance-qualified name (PWR/+12V → PWR_+12V).
  const flatByAlias = new Map<string, FlatNet>();
  const bareCount = new Map<string, number>();
  for (const n of input.netlist.nets) {
    for (const a of n.aliases) flatByAlias.set(a, n);
    bareCount.set(bare(n.name), (bareCount.get(bare(n.name)) ?? 0) + 1);
  }
  const powerName = (n: FlatNet) =>
    bareCount.get(bare(n.name)) === 1 ? bare(n.name) : n.name.replaceAll("/", "_");

  /**
   * A block-local net is drawn with power symbols when, in every instance of the block, it is
   * a power net with the same global name (a sheet file is shared, so the name must be too).
   */
  const globalCache = new Map<string, string | undefined>();
  const globalNameOf = (block: string, localNet: string): string | undefined => {
    const key = `${block}\u0000${localNet}`;
    if (!globalCache.has(key)) {
      const names = new Set<string | undefined>();
      for (const inst of instancesOf(block)) {
        const flat = flatByAlias.get(inst.prefix + localNet);
        names.add(flat && isPowerNet(flat) ? powerName(flat) : undefined);
      }
      const [only] = names;
      globalCache.set(key, names.size === 1 ? only : undefined);
    }
    return globalCache.get(key);
  };
  const drawnGlobal = new Set<string>(); // flat net names drawn with power symbols

  // Generated symbols, shared by all sheets.
  const symbolCache = new Map<string, GeneratedSymbol>();
  const symbolFor = (path: string): GeneratedSymbol | undefined => {
    const part = input.netlist.parts.find((p) => p.path === path);
    if (!part) return undefined;
    const key = part.spec.kind === "lib" ? part.spec.id : part.spec.fn;
    if (!symbolCache.has(key)) {
      const s =
        part.spec.kind === "lib"
          ? part.record && symbolForRecord(part.record)
          : symbolForGeneric(part.spec.fn);
      if (s) symbolCache.set(key, s);
    }
    return symbolCache.get(key);
  };

  // Nets that need a PWR_FLAG: no power_out pin drives them, but something needs power: a
  // power_in pin, or KiCad's own power symbols (whose pins are power inputs).
  const flagged = new Map<string, Set<string>>(); // block → local net names
  for (const net of input.netlist.nets) {
    if (net.pins.some((p) => p.type === "power_out")) continue;
    const drawnWithSymbols = instances.some((inst) =>
      inst.block.nets.some(
        (n) =>
          net.aliases.includes(inst.prefix + n.name) &&
          globalNameOf(inst.block.block.name, n.name) !== undefined,
      ),
    );
    if (!drawnWithSymbols && !net.pins.some((p) => p.type === "power_in")) continue;
    // KiCad's ERC calls a power symbol unconnected when its sheet has nothing else on the net,
    // so a global net's flag goes in a sheet where the net reaches real part pins. Otherwise
    // (label-drawn nets) it goes where the net is declared, attached by a label.
    const withPins = instances.flatMap((inst) =>
      inst.block.nets
        .filter(
          (n) =>
            net.aliases.includes(inst.prefix + n.name) &&
            n.pins.some((p) => inst.block.parts.some((part) => part.ref === p.target)) &&
            globalNameOf(inst.block.block.name, n.name) !== undefined,
        )
        .map((n) => ({ block: inst.block.block.name, local: n.name })),
    );
    const prefix = net.name.slice(0, net.name.lastIndexOf("/") + 1);
    const rep = instances.find((i) => i.prefix === prefix);
    const target =
      withPins[0] ?? (rep ? { block: rep.block.block.name, local: bare(net.name) } : undefined);
    if (!target) continue;
    const set = flagged.get(target.block) ?? new Set();
    set.add(target.local);
    flagged.set(target.block, set);
  }
  let flagCounter = 0;
  let powerCounter = 0;

  const files = new Map<string, string>();
  for (const block of input.blocks) {
    const insts = instancesOf(block.block.name);
    if (insts.length === 0) continue;
    const first = insts[0] as SheetInstance;
    const name = block.block.name;
    const items: SExpr[][] = [];
    const libSymbols = new Map<string, SExpr[]>(); // lib_id → definition
    let uuidCounter = 0;
    const nextUuid = (kind: string) =>
      stableUuid(project, "item", name, kind, String(uuidCounter++));
    const globalName = (localNet: string) => globalNameOf(name, localNet);

    // Label for each local net: hierarchical (named after the port) when the net is a port.
    const portKinds = new Map(block.ports.map((p) => [p.name, p.kind]));
    const labelFor = new Map<string, { text: string; shape?: string }>();
    for (const n of block.nets) {
      const kind = n.port === undefined ? undefined : portKinds.get(n.port);
      labelFor.set(
        n.name,
        n.port !== undefined && kind !== undefined
          ? { text: n.port, shape: shapeOf[kind] }
          : { text: n.name },
      );
    }
    const label = (netName: string, at: Point, outward: number): SExpr[] => {
      const l = labelFor.get(netName) ?? { text: netName };
      const justify = outward === 180 || outward === 270 ? "right" : "left";
      if (l.shape !== undefined) {
        return [
          "hierarchical_label",
          l.text,
          ["shape", sym(l.shape)],
          ["at", at.x, at.y, outward],
          effects({ justify: [justify] }),
          ["uuid", nextUuid("label")],
        ];
      }
      return [
        "label",
        l.text,
        ["at", at.x, at.y, outward],
        effects({ justify: [justify, "bottom"] }),
        ["uuid", nextUuid("label")],
      ];
    };

    const placeSymbol = (
      p: PowerSymbol,
      at: Point,
      outward: number,
      value: string,
      prefix: string,
      hideValue = false,
    ) => {
      libSymbols.set(p.libId, p.def);
      const refs = insts.map(
        (i) =>
          [
            i.path,
            `${prefix}${String(prefix === "#FLG" ? ++flagCounter : ++powerCounter).padStart(2, "0")}`,
          ] as [string, string],
      );
      const uuid = nextUuid("power");
      return placePower(p, {
        at,
        outward,
        value,
        uuid,
        pinUuid: stableUuid(uuid, "pin"),
        project,
        refs,
        hideValue,
      });
    };

    /** The power symbol for a local net, or undefined when it is drawn with labels. */
    const powerFor = (netName: string) => {
      const global = globalName(netName);
      if (global === undefined) return undefined;
      const ground = flatByAlias.get(first.prefix + netName)?.portKinds.includes("ground") ?? false;
      return { global, symbol: power.forNet(global, ground) };
    };

    /** Attaches a pin, sheet pin or flag point to a local net: power symbol or label. */
    /**
     * Attaches a pin, sheet pin or flag point to a local net: power symbol or label. `shown`
     * collects the rails already named on one side of a part, so repeats there hide their text.
     */
    const connect = (netName: string, at: Point, outward: number, shown?: Set<string>): SExpr[] => {
      const p = powerFor(netName);
      if (!p) return label(netName, at, outward);
      for (const i of insts) {
        const flat = flatByAlias.get(i.prefix + netName);
        if (flat) drawnGlobal.add(flat.name);
      }
      const key = `${outward}|${p.global}`;
      const repeat = shown?.has(key) ?? false;
      shown?.add(key);
      return placeSymbol(p.symbol, at, outward, p.global, "#PWR", repeat);
    };

    // Which local net each part pin (by number) and each instance port is on.
    const pinNet = new Map<string, string>(); // "R1#2" → net
    const portNet = new Map<string, string>(); // "PWR.+5V" → net
    for (const n of block.nets) {
      for (const ref of n.pins) {
        const part = input.netlist.parts.find((p) => p.path === first.prefix + ref.target);
        if (part) {
          const byNumber = part.pins.filter((p) => p.number === ref.pin);
          const matches =
            byNumber.length > 0 ? byNumber : part.pins.filter((p) => p.name === ref.pin);
          for (const p of matches) pinNet.set(`${ref.target}#${p.number}`, n.name);
        } else {
          portNet.set(`${ref.target}.${ref.pin}`, n.name);
        }
      }
    }

    // Layout: items in rows, each cell sized to the symbol plus room for its labels.
    const textLen = (nets: (string | undefined)[]) =>
      Math.max(
        0,
        ...nets.map((n) =>
          n === undefined ? 0 : (globalName(n) ?? labelFor.get(n)?.text ?? n).length,
        ),
      );
    type Cell = { w: number; h: number; draw: (origin: Point) => void };
    const cells: Cell[] = [];

    for (const decl of block.parts) {
      const path = first.prefix + decl.ref;
      const s = symbolFor(path);
      if (!s) continue;
      libSymbols.set(`${LIB}:${s.name}`, qualified(s));
      const side = (outward: number) =>
        [...s.pins]
          .filter(([, a]) => a.outward === outward)
          .map(([n]) => pinNet.get(`${decl.ref}#${n}`));
      const lw = textLen([...side(180), ...side(0)]) * 1.27 + 3 * GRID;
      const lh = textLen([...side(90), ...side(270)]) * 1.27 + 3 * GRID;
      const vertical = side(180).length + side(0).length === 0;
      const w = s.box.maxX - s.box.minX + 2 * lw + (vertical ? 12 * GRID : 0);
      const h = s.box.maxY - s.box.minY + 2 * lh + 4 * GRID;
      cells.push({
        w,
        h,
        draw: (o) => {
          const at = { x: snap(o.x + lw - s.box.minX), y: snap(o.y + lh + 3 * GRID + s.box.maxY) };
          items.push(placedSymbol(decl.ref, path, s, at, vertical));
          const shown = new Set<string>();
          for (const [num, a] of s.pins) {
            const p = { x: at.x + a.x, y: at.y - a.y };
            const net = pinNet.get(`${decl.ref}#${num}`);
            items.push(
              net === undefined
                ? ["no_connect", ["at", p.x, p.y], ["uuid", nextUuid("nc")]]
                : connect(net, p, a.outward, shown),
            );
          }
        },
      });
    }

    for (const u of block.uses) {
      const child = blocks.get(u.block);
      if (!child) continue;
      // Ports on global power nets connect through power symbols, so they get no sheet pin.
      const sheetPorts = child.ports.filter((p) => {
        const net = child.nets.find((n) => n.port === p.name);
        return net === undefined || globalNameOf(child.block.name, net.name) === undefined;
      });
      const isRight = (k: PortKind) => k === "power_out" || k === "output" || k === "bidir";
      const left = sheetPorts.filter((p) => !isRight(p.kind));
      const right = sheetPorts.filter((p) => isRight(p.kind));
      const longest = (ps: typeof left) => Math.max(0, ...ps.map((p) => p.name.length));
      const sw = snap(
        Math.max(30.48, (longest(left) + longest(right)) * 1.27 + 4 * GRID, u.block.length * 1.6),
      );
      const sh = (Math.max(left.length, right.length, 1) + 1) * GRID;
      const lw =
        textLen([...sheetPorts.map((p) => portNet.get(`${u.instance}.${p.name}`))]) * 1.27 +
        3 * GRID;
      cells.push({
        w: sw + 2 * lw,
        h: sh + 4 * GRID,
        draw: (o) => {
          const at = { x: snap(o.x + lw), y: snap(o.y + 2 * GRID) };
          const pins: SExpr[][] = [];
          const pinAt = (p: (typeof left)[number], x: number, i: number, outward: number) => {
            const point = { x, y: at.y + GRID * (i + 1) };
            pins.push([
              "pin",
              p.name,
              sym(shapeOf[p.kind]),
              ["at", point.x, point.y, outward],
              ["uuid", stableUuid(project, "sheetpin", name, u.instance, p.name)],
              effects({ justify: [outward === 180 ? "left" : "right"] }),
            ]);
            const net = portNet.get(`${u.instance}.${p.name}`);
            if (net !== undefined) items.push(connect(net, point, outward));
          };
          for (const [i, p] of left.entries()) pinAt(p, at.x, i, 180);
          for (const [i, p] of right.entries()) pinAt(p, at.x + sw, i, 0);
          const childInsts = insts.map((parent) => ({
            parent,
            child: instances.find((i) => i.prefix === `${parent.prefix}${u.instance}/`),
          }));
          items.push([
            "sheet",
            ["at", at.x, at.y],
            ["size", sw, sh],
            ["exclude_from_sim", yesNo(false)],
            ["in_bom", yesNo(true)],
            ["on_board", yesNo(true)],
            ["dnp", yesNo(false)],
            ["stroke", ["width", 0.1524], ["type", sym("solid")]],
            ["fill", ["color", 0, 0, 0, 0]],
            ["uuid", sheetUuid(name, u.instance)],
            property("Sheetname", u.instance, [at.x, at.y - 0.7116, 0], {
              justify: ["left", "bottom"],
            }),
            property("Sheetfile", fileOf(u.block), [at.x, at.y + sh + 0.5984, 0], {
              justify: ["left", "top"],
            }),
            ...pins,
            [
              "instances",
              [
                "project",
                project,
                ...childInsts.map(
                  ({ parent, child: c }) =>
                    ["path", parent.path, ["page", String(c?.page ?? 0)]] as SExpr[],
                ),
              ],
            ],
          ]);
        },
      });
    }

    // PWR_FLAGs sit on the net's power symbol, drawn in its natural orientation: a flag points
    // up from a ground symbol and right from a supply symbol. Non-global nets use a label.
    for (const netName of flagged.get(name) ?? []) {
      const p = powerFor(netName);
      const netOutward = p ? p.symbol.bodyDir : 270;
      const flagOutward = netOutward === 270 ? 90 : 0;
      cells.push({
        w: textLen([netName]) * 1.27 + 8 * GRID,
        h: 8 * GRID,
        draw: (o) => {
          const at = { x: snap(o.x + 3 * GRID), y: snap(o.y + 4 * GRID) };
          items.push(connect(netName, at, netOutward));
          items.push(placeSymbol(power.flag(), at, flagOutward, "PWR_FLAG", "#FLG"));
        },
      });
    }

    // Row-major placement within a width that keeps the sheet roughly A-series shaped.
    const area = cells.reduce((sum, c) => sum + c.w * c.h, 0);
    const maxW = Math.max(160, ...cells.map((c) => c.w), Math.sqrt(area * 1.6));
    const margin = 4 * GRID;
    let x = margin;
    let y = margin;
    let rowH = 0;
    let extentX = 0;
    for (const c of cells) {
      if (x > margin && x + c.w > margin + maxW) {
        x = margin;
        y += rowH;
        rowH = 0;
      }
      c.draw({ x, y });
      x += c.w;
      rowH = Math.max(rowH, c.h);
      extentX = Math.max(extentX, x);
    }
    const extentY = y + rowH + margin;
    const paper =
      papers.find(([, w, h]) => w >= extentX + margin && h >= extentY + 15) ?? papers.at(-1);

    function placedSymbol(
      ref: string,
      path: string,
      s: GeneratedSymbol,
      at: Point,
      textRight: boolean,
    ): SExpr[] {
      const entry = input.bom.get(path);
      const record = entry?.record;
      const fields: [string, string][] = [
        ["MPN", record?.mpn ?? ""],
        ["Manufacturer", record?.manufacturer ?? ""],
        ["Spec", entry?.spec ?? ""],
        ["LCSC", record?.sourcing?.lcsc ?? ""],
        ["DigiKey", record?.sourcing?.digikey ?? ""],
        ["Mouser", record?.sourcing?.mouser ?? ""],
      ];
      const refAt: [number, number, number] = textRight
        ? [at.x + 2 * GRID, at.y - 1.27, 0]
        : [at.x + s.box.minX + GRID, at.y - s.box.maxY - 2.54, 0];
      const valueAt: [number, number, number] = textRight
        ? [at.x + 2 * GRID, at.y + 1.27, 0]
        : [at.x + s.box.minX + GRID, at.y - s.box.maxY - 0.254, 0];
      return [
        "symbol",
        ["lib_id", `${LIB}:${s.name}`],
        ["at", at.x, at.y, 0],
        ["unit", 1],
        ["body_style", 1],
        ["exclude_from_sim", yesNo(false)],
        ["in_bom", yesNo(true)],
        ["on_board", yesNo(true)],
        ["in_pos_files", yesNo(true)],
        ["dnp", yesNo(false)],
        ["uuid", symbolUuidFor(name, ref)],
        property("Reference", refOf(annotation, path), refAt, { justify: ["left", "bottom"] }),
        property("Value", entry?.value ?? s.name, valueAt, { justify: ["left", "bottom"] }),
        property("Footprint", entry?.footprint ?? "", [at.x, at.y, 0], { hide: true }),
        property("Datasheet", record?.provenance.datasheet?.url ?? "", [at.x, at.y, 0], {
          hide: true,
        }),
        property("Description", record?.summary ?? entry?.spec ?? "", [at.x, at.y, 0], {
          hide: true,
        }),
        ...fields
          .filter(([, v]) => v !== "")
          .map(([k, v]) => property(k, v, [at.x, at.y, 0], { hide: true })),
        ...[...s.pins.keys()].map(
          (n) => ["pin", n, ["uuid", stableUuid(project, "pin", name, ref, n)]] as SExpr[],
        ),
        [
          "instances",
          [
            "project",
            project,
            ...insts.map(
              (i) =>
                [
                  "path",
                  i.path,
                  ["reference", refOf(annotation, i.prefix + ref)],
                  ["unit", 1],
                ] as SExpr[],
            ),
          ],
        ],
      ];
    }

    const isRoot = name === input.top;
    const doc: SExpr[] = [
      "kicad_sch",
      ["version", SCH_VERSION],
      ["generator", GENERATOR],
      ["generator_version", "0.1"],
      ["uuid", isRoot ? rootUuid : stableUuid(project, "file", name)],
      ["paper", paper?.[0] ?? "A4"],
      [
        "title_block",
        ["title", isRoot ? project : `${project}: ${name}`],
        ["comment", 1, block.block.description ?? ""],
        ["comment", 2, "Generated by partstyle from circuit/*.ckt; edit those, not this file"],
      ],
      ["lib_symbols", ...[...libSymbols].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, d]) => d)],
      ...items,
      ...(isRoot ? [["sheet_instances", ["path", "/", ["page", "1"]]] as SExpr[]] : []),
      ["embedded_fonts", yesNo(false)],
    ];
    files.set(fileOf(name), `${writeSExpr(doc)}\n`);
  }

  const netNames = new Map(
    input.netlist.nets.map((n) => [n.name, drawnGlobal.has(n.name) ? powerName(n) : `/${n.name}`]),
  );
  return {
    files,
    instances,
    symbolUuid: (path) => {
      const slash = path.lastIndexOf("/");
      const prefix = path.slice(0, slash + 1);
      const inst = instances.find((i) => i.prefix === prefix);
      return symbolUuidFor(inst?.block.block.name ?? "", path.slice(slash + 1));
    },
    symbols: [...symbolCache.values()],
    netNames,
    powerFlags: flagCounter,
  };
}

/** The project symbol library: every generated symbol. */
export function symbolLibrary(symbols: GeneratedSymbol[]): string {
  const doc: SExpr[] = [
    "kicad_symbol_lib",
    ["version", SYM_LIB_VERSION],
    ["generator", GENERATOR],
    ["generator_version", "0.1"],
    ...[...symbols].sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.def),
  ];
  return `${writeSExpr(doc)}\n`;
}

export const symLibTable = `(sym_lib_table
  (version 7)
  (lib (name "${LIB}")(type "KiCad")(uri "\${KIPRJMOD}/${LIB}.kicad_sym")(options "")(descr "Generated by partstyle"))
)
`;
