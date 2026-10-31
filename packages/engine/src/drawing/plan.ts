import type { CktFile, PortKind } from "../ckt/ast.js";
import { type SchSymbol, symbolKey } from "../kicad/libsym.js";
import type { PowerLibrary, PowerSymbol } from "../kicad/power.js";
import type { FlatNet, FlatPart, Netlist } from "../netlist/elaborate.js";

/** One placement of a block in the hierarchy, in depth-first page order. */
export interface Instance {
  /** Part path prefix: "" for the top block, "PWR/" for `use power as PWR`. */
  prefix: string;
  block: CktFile;
  /** Sheets from the root down: each `use` as (block that uses it, instance name). */
  chain: { parent: string; instance: string }[];
  /** KiCad's hierarchical sheet name: "/" or "/PWR/". */
  names: string;
  page: number;
}

/** How one block-local net is drawn. */
export type NetPlan =
  | { kind: "power"; name: string; symbol: PowerSymbol }
  | { kind: "wire"; port?: { name: string; kind: PortKind } }
  | { kind: "label"; text: string; shape?: string };

export interface DrawingPlan {
  instances: Instance[];
  instancesOf(block: string): Instance[];
  /** Plan for a block-local net, by block name. */
  net(block: string, localNet: string): NetPlan;
  /** Local nets that get a PWR_FLAG in this block's sheet. */
  flags(block: string): Set<string>;
  /** The name KiCad gives each flat net: its power name if drawn with power symbols, else `/<path>`. */
  netNames: Map<string, string>;
  /** Symbol for a part, chosen by `symbolKey`. */
  symbolOf(part: FlatPart): SchSymbol | undefined;
  flagSymbol: PowerSymbol;
}

export const shapeOf: Record<PortKind, string> = {
  power_in: "input",
  input: "input",
  power_out: "output",
  output: "output",
  bidir: "bidirectional",
  passive: "passive",
  ground: "passive",
};

/** Nets with at most this many connection points in one sheet are routed as wires. */
export const MAX_WIRED_ITEMS = 6;

const bare = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** Nets drawn with power symbols: anything with power pins or passing through a power/ground port. */
const isPowerNet = (n: FlatNet) =>
  n.pins.some((p) => p.type === "power_in" || p.type === "power_out") ||
  n.portKinds.some((k) => k === "ground" || k === "power_in" || k === "power_out");

/**
 * Decides, for every block, how each net is drawn, independent of geometry: power symbols for
 * rails, wires for small nets, labels otherwise; and where PWR_FLAGs go.
 */
export function planDrawing(input: {
  blocks: CktFile[];
  top: string;
  netlist: Netlist;
  symbols: Map<string, SchSymbol>;
  power: PowerLibrary;
}): DrawingPlan {
  const blocks = new Map(input.blocks.map((b) => [b.block.name, b]));
  const top = blocks.get(input.top);
  if (!top) throw new Error(`top block ${input.top} not found`);

  const instances: Instance[] = [];
  const visit = (block: CktFile, prefix: string, chain: Instance["chain"], names: string) => {
    instances.push({ prefix, block, chain, names, page: instances.length + 1 });
    for (const u of block.uses) {
      const child = blocks.get(u.block);
      if (!child) continue;
      visit(
        child,
        `${prefix}${u.instance}/`,
        [...chain, { parent: block.block.name, instance: u.instance }],
        `${names}${u.instance}/`,
      );
    }
  };
  visit(top, "", [], "/");
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

  /** Power name shared by every instance of a block-local net, else undefined. */
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

  const partsByPath = new Map(input.netlist.parts.map((p) => [p.path, p]));
  const symbolOf = (part: FlatPart) => input.symbols.get(symbolKey(part));

  /** A child port is drawn without a sheet pin when its net is a global power net. */
  const portIsGlobal = (childBlock: string, port: string): boolean => {
    const child = blocks.get(childBlock);
    const net = child?.nets.find((n) => n.port === port);
    return net !== undefined && globalNameOf(childBlock, net.name) !== undefined;
  };

  const plans = new Map<string, NetPlan>();
  const planFor = (blockName: string, localNet: string): NetPlan => {
    const key = `${blockName}\u0000${localNet}`;
    const cached = plans.get(key);
    if (cached) return cached;
    const block = blocks.get(blockName) as CktFile;
    const decl = block.nets.find((n) => n.name === localNet);
    const port =
      decl?.port === undefined ? undefined : block.ports.find((p) => p.name === decl.port);
    let plan: NetPlan;
    const global = globalNameOf(blockName, localNet);
    const flat = flatByAlias.get((instancesOf(blockName)[0]?.prefix ?? "") + localNet);
    if (global !== undefined) {
      const ground = flat?.portKinds.includes("ground") ?? false;
      plan = { kind: "power", name: global, symbol: input.power.forNet(global, ground) };
    } else {
      // Count what this sheet connects: visible pins, sheet pins of child instances, and the
      // hierarchical label if the net is a port.
      const first = instancesOf(blockName)[0];
      let items = port ? 1 : 0;
      for (const ref of decl?.pins ?? []) {
        const part = first && partsByPath.get(first.prefix + ref.target);
        if (part) {
          const byNumber = part.pins.filter((p) => p.number === ref.pin);
          const matched =
            byNumber.length > 0
              ? byNumber.length
              : part.pins.filter((p) => p.name === ref.pin).length;
          items += matched;
        } else {
          const use = block.uses.find((u) => u.instance === ref.target);
          if (use && !portIsGlobal(use.block, ref.pin)) items += 1;
        }
      }
      if (items >= 2 && items <= MAX_WIRED_ITEMS) {
        plan = { kind: "wire", ...(port && { port: { name: port.name, kind: port.kind } }) };
      } else if (port) {
        plan = { kind: "label", text: port.name, shape: shapeOf[port.kind] };
      } else {
        plan = { kind: "label", text: localNet };
      }
    }
    plans.set(key, plan);
    return plan;
  };

  // Nets that need a PWR_FLAG: no power_out pin drives them, but something needs power: a
  // power_in pin, or KiCad's own power symbols (whose pins are power inputs). KiCad's ERC calls
  // a power symbol unconnected when its sheet has nothing else on the net, so the flag goes in a
  // sheet where the net reaches real part pins.
  const flagged = new Map<string, Set<string>>();
  const netNames = new Map<string, string>();
  for (const net of input.netlist.nets) {
    const locals = instances.flatMap((inst) =>
      inst.block.nets
        .filter((n) => net.aliases.includes(inst.prefix + n.name))
        .map((n) => ({ inst, local: n })),
    );
    const drawnGlobal = locals.some(
      ({ inst, local }) => globalNameOf(inst.block.block.name, local.name) !== undefined,
    );
    netNames.set(net.name, drawnGlobal ? powerName(net) : `/${net.name}`);

    if (net.pins.some((p) => p.type === "power_out")) continue;
    if (!drawnGlobal && !net.pins.some((p) => p.type === "power_in")) continue;
    const withPins = locals.filter(
      ({ inst, local }) =>
        local.pins.some((p) => inst.block.parts.some((part) => part.ref === p.target)) &&
        globalNameOf(inst.block.block.name, local.name) !== undefined,
    );
    const prefix = net.name.slice(0, net.name.lastIndexOf("/") + 1);
    const rep = instances.find((i) => i.prefix === prefix);
    const target = withPins[0]
      ? { block: withPins[0].inst.block.block.name, local: withPins[0].local.name }
      : rep
        ? { block: rep.block.block.name, local: bare(net.name) }
        : undefined;
    if (!target) continue;
    const set = flagged.get(target.block) ?? new Set();
    set.add(target.local);
    flagged.set(target.block, set);
  }

  return {
    instances,
    instancesOf,
    net: planFor,
    flags: (block) => flagged.get(block) ?? new Set(),
    netNames,
    symbolOf,
    flagSymbol: input.power.flag(),
  };
}
