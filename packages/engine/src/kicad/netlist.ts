import type { BomEntry } from "../bom.js";
import type { Netlist } from "../netlist/elaborate.js";
import type { SheetInstance } from "./schematic.js";
import { children, readSExpr, type SExpr, value, writeSExpr } from "./sexpr.js";
import { toKicadPinType } from "./symbols.js";

export interface NetlistInput {
  project: string;
  netlist: Netlist;
  bom: Map<string, BomEntry>;
  instances: SheetInstance[];
  /** UUIDs of each placed unit of a part. */
  symbolUuids: (path: string) => string[];
  /** The symbol a part was drawn with, `Lib:Name`. */
  libIdOf: (path: string) => string;
  /** KiCad net names (power symbol names for power nets); defaults to `/<flat name>`. */
  netNames?: Map<string, string>;
}

/**
 * A KiCad S-expression netlist (format "E"), the robust hand-off to the PCB editor. Symbol UUIDs
 * match the generated schematic, so this and "Update PCB from Schematic" agree.
 */
export function writeKicadNetlist(input: NetlistInput): string {
  const { netlist } = input;
  const instanceOf = (prefix: string) => input.instances.find((i) => i.prefix === prefix);
  const sheetTstamps = (i: SheetInstance) =>
    `${i.path.split("/").slice(2).join("/")}/`.replace(/^\/?/, "/");

  const components = netlist.parts.map((part) => {
    const entry = input.bom.get(part.path);
    const r = entry?.record;
    const inst = instanceOf(part.prefix);
    const libId = input.libIdOf(part.path);
    const fields: [string, string][] = [
      ["Footprint", entry?.footprint ?? ""],
      ["Datasheet", r?.provenance.datasheet?.url ?? ""],
      ["Description", r?.summary ?? entry?.spec ?? ""],
      ["MPN", r?.preferred_mpn ?? ""],
      ["Manufacturer", r?.manufacturer ?? ""],
    ];
    return [
      "comp",
      ["ref", part.path],
      ["value", entry?.value ?? ""],
      ["footprint", entry?.footprint ?? ""],
      ["fields", ...fields.map(([k, v]) => ["field", ["name", k], ...(v ? [v] : [])] as SExpr[])],
      [
        "libsource",
        ["lib", libId.slice(0, libId.indexOf(":"))],
        ["part", libId.slice(libId.indexOf(":") + 1)],
        ["description", r?.summary ?? ""],
      ],
      [
        "property",
        ["name", "Sheetname"],
        ["value", inst?.names === "/" ? input.project : (inst?.names.split("/").at(-2) ?? "")],
      ],
      ["property", ["name", "Sheetfile"], ["value", inst?.file ?? ""]],
      ["sheetpath", ["names", inst?.names ?? "/"], ["tstamps", inst ? sheetTstamps(inst) : "/"]],
      ["tstamps", ...input.symbolUuids(part.path)],
    ] as SExpr[];
  });

  const nets = netlist.nets
    .filter((n) => n.pins.length > 0)
    .map(
      (n, i) =>
        [
          "net",
          ["code", String(i + 1)],
          ["name", input.netNames?.get(n.name) ?? `/${n.name}`],
          ["class", "Default"],
          ...n.pins.map(
            (p) =>
              [
                "node",
                ["ref", p.part],
                ["pin", p.number],
                ["pinfunction", p.name],
                ["pintype", toKicadPinType(p.type)],
              ] as SExpr[],
          ),
        ] as SExpr[],
    );

  const doc: SExpr[] = [
    "export",
    ["version", "E"],
    ["design", ["source", `${input.project}.kicad_sch`], ["tool", "partstyle"]],
    ["components", ...components],
    ["nets", ...nets],
  ];
  return `${writeSExpr(doc)}\n`;
}

export interface ParsedNetlist {
  refs: Set<string>;
  /** Nets as sets of `REF.PIN`, power symbols (`#...`) excluded. */
  nets: { name: string; nodes: string[] }[];
}

export function parseKicadNetlist(text: string): ParsedNetlist {
  const doc = readSExpr(text);
  const comps = children(children(doc, "components")[0] ?? [], "comp");
  const refs = new Set(comps.map((c) => value(c, "ref") ?? "").filter((r) => !r.startsWith("#")));
  const nets = children(children(doc, "nets")[0] ?? [], "net").map((n) => ({
    name: value(n, "name") ?? "",
    nodes: children(n, "node")
      .map((node) => `${value(node, "ref")}.${value(node, "pin")}`)
      .filter((node) => !node.startsWith("#")),
  }));
  return { refs, nets };
}

/**
 * Differences between the design's connectivity and a netlist KiCad derived from the exported
 * schematic. Empty means the schematic is faithful. Unconnected pins may appear in KiCad as
 * single-node nets; those are ignored.
 */
export function compareNetlists(ours: Netlist, theirs: ParsedNetlist): string[] {
  const problems: string[] = [];
  const ourRefs = new Set(ours.parts.map((p) => p.path));
  for (const r of ourRefs)
    if (!theirs.refs.has(r)) problems.push(`${r} is missing from the schematic`);
  for (const r of theirs.refs)
    if (!ourRefs.has(r)) problems.push(`${r} is in the schematic but not the design`);

  const key = (nodes: string[]) => [...nodes].sort().join(" ");
  const ourNetOf = new Map<string, { name: string; key: string }>();
  for (const n of ours.nets) {
    const nodes = n.pins.map((p) => `${p.part}.${p.number}`);
    for (const node of nodes) ourNetOf.set(node, { name: n.name, key: key(nodes) });
  }
  const theirNetOf = new Map<string, { name: string; key: string }>();
  for (const n of theirs.nets) {
    if (n.nodes.length === 1 && !ourNetOf.has(n.nodes[0] as string)) continue;
    for (const node of n.nodes) theirNetOf.set(node, { name: n.name, key: key(n.nodes) });
  }

  const reported = new Set<string>();
  for (const [node, mine] of ourNetOf) {
    const other = theirNetOf.get(node);
    if (other?.key === mine.key || reported.has(mine.key)) continue;
    reported.add(mine.key);
    problems.push(
      other
        ? `net ${mine.name} {${mine.key}} became ${other.name} {${other.key}} in the schematic`
        : `net ${mine.name}: pin ${node} is unconnected in the schematic`,
    );
  }
  for (const [node, other] of theirNetOf) {
    if (!ourNetOf.has(node) && !reported.has(other.key)) {
      reported.add(other.key);
      problems.push(
        `schematic net ${other.name} connects ${node}, which is unconnected in the design`,
      );
    }
  }
  return problems;
}
