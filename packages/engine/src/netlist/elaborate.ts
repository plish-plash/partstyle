import type { CktFile, NetDecl, PartSpec, PortKind, UseDecl, WaiverDecl } from "../ckt/ast.js";
import { globToRegExp, type Issue, type Location } from "../diagnostics.js";
import { checkGenericArgs, generics } from "../parts/generic.js";
import type { PartLibrary } from "../parts/library.js";
import type { PartRecord, PinType } from "../parts/schema.js";

export interface FlatPin {
  /** Unique key: `PWR/U1#3`. */
  id: string;
  /** Owning part's flat path. */
  part: string;
  number: string;
  name: string;
  type: PinType;
  /** Flat net name, once connected. */
  net?: string;
  /** Left open on purpose, by an `nc` statement. */
  open?: true;
  /** What the part record says about leaving it unconnected. */
  unused?: "open" | "required";
}

const quietWhenOpen: ReadonlySet<PinType> = new Set([
  "bidir",
  "output",
  "tristate",
  "open_collector",
  "open_emitter",
  "nc",
]);

/**
 * Whether an unconnected pin is normal: said so by an `nc` statement or the part record, or a
 * pin that needs nothing outside the part, like a spare GPIO. A power input never is.
 */
export function isOpenByDesign(pin: Pick<FlatPin, "type" | "open" | "unused">): boolean {
  if (pin.type === "power_in") return false;
  if (pin.open || pin.unused === "open") return true;
  return pin.unused !== "required" && quietWhenOpen.has(pin.type);
}

export interface FlatPart {
  /** Instance path plus refdes: `PWR/U1`. */
  path: string;
  spec: PartSpec;
  record?: PartRecord;
  pins: FlatPin[];
  intent?: string;
  location: Location;
}

export interface FlatNet {
  /** Name of the shallowest joined net, qualified by instance path: `+5V`, `AFE/VREF`. */
  name: string;
  /** Every net name joined into this one, qualified. */
  aliases: string[];
  pins: FlatPin[];
  attrs: Record<string, string>;
  /** Kinds of the block ports this net passes through. */
  portKinds: PortKind[];
  location: Location;
}

export interface Netlist {
  parts: FlatPart[];
  nets: FlatNet[];
}

/** Waivers declared in one block instance; subjects are relative to `prefix`. */
export interface WaiverScope {
  prefix: string;
  waivers: WaiverDecl[];
}

export interface ElaborationResult {
  netlist: Netlist;
  waiverScopes: WaiverScope[];
  issues: Issue[];
}

interface NetNode {
  name: string;
  depth: number;
  decl: NetDecl;
  portKinds: PortKind[];
}

type PortMap = Map<string, number>;

/**
 * Resolves parts to pins, connects pins to nets and flattens `use` hierarchy from the top block,
 * joining a child's port net with the parent net that references `INST.PORT`.
 */
export function elaborate(blocks: CktFile[], library: PartLibrary, top: string): ElaborationResult {
  return new Elaborator(blocks, library).run(top);
}

class Elaborator {
  private readonly blocks = new Map<string, CktFile>();
  private readonly issues: Issue[] = [];
  private readonly parts: FlatPart[] = [];
  private readonly nodes: NetNode[] = [];
  private readonly parent: number[] = [];
  private readonly pinNode = new Map<FlatPin, number>();
  private readonly waiverScopes: WaiverScope[] = [];
  private readonly visited = new Set<string>();

  constructor(
    blocks: CktFile[],
    private readonly library: PartLibrary,
  ) {
    for (const b of blocks) {
      const existing = this.blocks.get(b.block.name);
      if (existing) {
        this.error(
          "elab.duplicate-block",
          b.block.location,
          [b.block.name],
          `block '${b.block.name}' is already defined in ${existing.file}`,
        );
        continue;
      }
      this.blocks.set(b.block.name, b);
    }
  }

  run(top: string): ElaborationResult {
    if (this.blocks.has(top)) {
      this.instantiate(top, "", 0, []);
    } else {
      this.issues.push({
        code: "elab.unknown-top",
        severity: "error",
        message: `top block '${top}' not found (circuit/${top}.ckt should start with 'block ${top}')`,
        subjects: [],
      });
    }
    for (const [name, b] of this.blocks) {
      if (!this.visited.has(name)) {
        this.issues.push({
          code: "elab.unused-block",
          severity: "warning",
          message: `block '${name}' is not used from '${top}' and was not checked`,
          location: b.block.location,
          subjects: [name],
        });
      }
    }
    return { netlist: this.buildNetlist(), waiverScopes: this.waiverScopes, issues: this.issues };
  }

  private error(code: string, location: Location, subjects: string[], message: string): void {
    this.issues.push({ code, severity: "error", message, location, subjects });
  }

  private find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    while (this.parent[i] !== root) {
      const next = this.parent[i] as number;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  private instantiate(
    name: string,
    prefix: string,
    depth: number,
    stack: string[],
    use?: UseDecl,
  ): PortMap | undefined {
    const ckt = this.blocks.get(name);
    if (!ckt) {
      if (use) {
        this.error(
          "elab.unknown-block",
          use.location,
          [`${prefix.slice(0, -1)}`],
          `unknown block '${name}' (no circuit file declares it)`,
        );
      }
      return undefined;
    }
    if (stack.includes(name)) {
      if (use) {
        this.error(
          "elab.recursive-use",
          use.location,
          [],
          `block '${name}' uses itself: ${[...stack, name].join(" -> ")}`,
        );
      }
      return undefined;
    }
    this.visited.add(name);
    this.waiverScopes.push({ prefix, waivers: ckt.waivers });

    // Parts and instances share one namespace, since both appear before the '.' in a pinref.
    const refs = new Map<string, Location>();
    const claimRef = (ref: string, location: Location): void => {
      const prior = refs.get(ref);
      if (prior) {
        this.error(
          "elab.duplicate-ref",
          location,
          [prefix + ref],
          `'${ref}' is already declared at line ${prior.line}`,
        );
      } else {
        refs.set(ref, location);
      }
    };

    const localParts = new Map<string, FlatPart>();
    const unresolved = new Set<string>();
    for (const decl of ckt.parts) {
      claimRef(decl.ref, decl.location);
      const path = prefix + decl.ref;
      const resolved = this.resolvePart(decl.spec, decl.location, path);
      if (!resolved) {
        unresolved.add(decl.ref);
        continue;
      }
      const part: FlatPart = {
        path,
        spec: decl.spec,
        pins: resolved.pins.map((p) => ({ ...p, id: `${path}#${p.number}`, part: path })),
        location: decl.location,
        ...(resolved.record && { record: resolved.record }),
        ...(decl.intent !== undefined && { intent: decl.intent }),
      };
      localParts.set(decl.ref, part);
      this.parts.push(part);
    }

    const instances = new Map<string, { ports?: PortMap; used: Set<string>; use: UseDecl }>();
    for (const u of ckt.uses) {
      claimRef(u.instance, u.location);
      const ports = this.instantiate(
        u.block,
        `${prefix}${u.instance}/`,
        depth + 1,
        [...stack, name],
        u,
      );
      instances.set(u.instance, { used: new Set(), use: u, ...(ports && { ports }) });
    }

    const declaredPorts = new Map(ckt.ports.map((p) => [p.name, p]));
    for (const p of ckt.ports) {
      if (ckt.ports.find((q) => q.name === p.name) !== p) {
        this.error(
          "elab.duplicate-port",
          p.location,
          [prefix + p.name],
          `port '${p.name}' is declared twice`,
        );
      }
    }

    const portMap: PortMap = new Map();
    const netNames = new Map<string, Location>();
    for (const decl of ckt.nets) {
      const prior = netNames.get(decl.name);
      if (prior) {
        this.error(
          "elab.duplicate-net",
          decl.location,
          [prefix + decl.name],
          `net '${decl.name}' is already declared at line ${prior.line}; list all its pins on one line`,
        );
      }
      netNames.set(decl.name, decl.location);

      const node = this.nodes.length;
      this.nodes.push({ name: prefix + decl.name, depth, decl, portKinds: [] });
      this.parent.push(node);

      for (const ref of decl.pins) {
        const part = localParts.get(ref.target);
        const inst = instances.get(ref.target);
        if (part) {
          this.connectPin(part, ref.pin, node, ref.location);
        } else if (inst) {
          if (!inst.ports) continue;
          const portNode = inst.ports.get(ref.pin);
          if (portNode === undefined) {
            this.error(
              "elab.unknown-port",
              ref.location,
              [`${prefix}${ref.target}.${ref.pin}`],
              `block '${inst.use.block}' (instance ${ref.target}) has no port '${ref.pin}'`,
            );
            continue;
          }
          inst.used.add(ref.pin);
          this.union(node, portNode);
        } else if (!unresolved.has(ref.target)) {
          this.error(
            "elab.unknown-ref",
            ref.location,
            [prefix + ref.target],
            `'${ref.target}' is not a part or instance in block '${name}'`,
          );
        }
      }

      if (decl.port !== undefined) {
        const port = declaredPorts.get(decl.port);
        if (!port) {
          this.error(
            "elab.unknown-port",
            decl.location,
            [prefix + decl.port],
            `net '${decl.name}' exports undeclared port '${decl.port}'`,
          );
        } else if (portMap.has(decl.port)) {
          this.error(
            "elab.port-bound-twice",
            decl.location,
            [prefix + decl.port],
            `port '${decl.port}' is already bound to another net`,
          );
        } else {
          portMap.set(decl.port, node);
          this.nodes[node]?.portKinds.push(port.kind);
        }
      }
    }

    // After the nets: an nc pin must not be on one.
    for (const decl of ckt.ncs) {
      const { target, pin } = decl.pin;
      const part = localParts.get(target);
      if (part) {
        this.markOpen(part, pin, decl.location);
      } else if (!unresolved.has(target)) {
        this.error(
          "elab.unknown-ref",
          decl.location,
          [prefix + target],
          `'${target}' is not a part in block '${name}'`,
        );
      }
    }

    for (const p of declaredPorts.values()) {
      if (!portMap.has(p.name)) {
        this.error(
          "elab.unbound-port",
          p.location,
          [prefix + p.name],
          `port '${p.name}' is not bound to a net (add '-> port ${p.name}' to a net)`,
        );
      }
    }

    for (const [instName, inst] of instances) {
      for (const port of inst.ports?.keys() ?? []) {
        if (!inst.used.has(port)) {
          this.issues.push({
            code: "erc.unused-port",
            severity: "warning",
            message: `port ${instName}.${port} is not connected`,
            location: inst.use.location,
            subjects: [`${prefix}${instName}.${port}`, prefix + instName],
          });
        }
      }
    }
    return portMap;
  }

  private resolvePart(
    spec: PartSpec,
    location: Location,
    path: string,
  ): { pins: Omit<FlatPin, "id" | "part">[]; record?: PartRecord } | undefined {
    if (spec.kind === "lib") {
      const entry = this.library.get(spec.id);
      if (!entry) {
        this.error(
          "elab.unknown-part",
          location,
          [path],
          `no part record 'lib:${spec.id}' in the library`,
        );
        return undefined;
      }
      const pins = Object.entries(entry.record.pins).map(([number, p]) => ({
        number,
        name: p.name,
        type: p.type,
        ...(p.unused !== undefined && { unused: p.unused }),
      }));
      return { pins, record: entry.record };
    }
    const problem = checkGenericArgs(spec.fn, spec.args);
    if (problem) this.error("elab.bad-generic", location, [path], problem);
    const def = generics[spec.fn];
    return def ? { pins: def.pins } : undefined;
  }

  /** A pin token matches a pin number exactly, otherwise every pin with that name (e.g. all GND pins). */
  private pinsNamed(part: FlatPart, pin: string): FlatPin[] {
    const byNumber = part.pins.filter((p) => p.number === pin);
    return byNumber.length > 0 ? byNumber : part.pins.filter((p) => p.name === pin);
  }

  private unknownPin(part: FlatPart, pin: string, location: Location): void {
    const ref = part.path.replace(/^.*\//, "");
    const names = [...new Set(part.pins.map((p) => p.name))];
    const shown = names.length > 12 ? `${names.slice(0, 12).join(" ")} …` : names.join(" ");
    this.error(
      "elab.unknown-pin",
      location,
      [`${part.path}.${pin}`, part.path],
      `${ref} has no pin '${pin}' (pins: ${shown})`,
    );
  }

  /** An `nc` statement: a glob covers the pins it matches that are open; a named pin must be. */
  private markOpen(part: FlatPart, pin: string, location: Location): void {
    const glob = pin.includes("*");
    const pattern = globToRegExp(pin);
    const matches = glob
      ? part.pins.filter((p) => pattern.test(p.name) || pattern.test(p.number))
      : this.pinsNamed(part, pin);
    if (matches.length === 0) {
      this.unknownPin(part, pin, location);
      return;
    }
    for (const p of matches) {
      const node = this.pinNode.get(p);
      if (node === undefined) {
        p.open = true;
      } else if (!glob) {
        const net = this.nodes[node]?.name ?? "?";
        this.error(
          "elab.nc-connected",
          location,
          [`${part.path}.${p.name}`, part.path],
          `${part.path}.${p.name} (pin ${p.number}) is marked nc but is on net ${net}; remove one`,
        );
      }
    }
  }

  private connectPin(part: FlatPart, pin: string, node: number, location: Location): void {
    const matches = this.pinsNamed(part, pin);
    if (matches.length === 0) {
      this.unknownPin(part, pin, location);
      return;
    }
    for (const p of matches) {
      const existing = this.pinNode.get(p);
      if (existing !== undefined) {
        const other = this.nodes[existing]?.name ?? "?";
        this.error(
          "elab.pin-multiple-nets",
          location,
          [`${part.path}.${p.name}`, part.path],
          `${part.path}.${p.name} (pin ${p.number}) is already on net ${other}; this would short the nets`,
        );
        continue;
      }
      this.pinNode.set(p, node);
    }
  }

  private buildNetlist(): Netlist {
    const groups = new Map<number, number[]>();
    this.nodes.forEach((_, i) => {
      const root = this.find(i);
      const members = groups.get(root) ?? [];
      members.push(i);
      groups.set(root, members);
    });

    const netByRoot = new Map<number, FlatNet>();
    for (const [root, members] of groups) {
      const sorted = members.map((i) => this.nodes[i] as NetNode).sort((a, b) => a.depth - b.depth);
      const rep = sorted[0] as NetNode;
      const attrs: Record<string, string> = {};
      for (const n of sorted) {
        for (const [k, v] of Object.entries(n.decl.attrs)) {
          if (attrs[k] !== undefined && attrs[k] !== v) {
            this.issues.push({
              code: "elab.attr-conflict",
              severity: "warning",
              message: `net ${rep.name}: attribute '${k}' is '${attrs[k]}' here but '${v}' on ${n.name}`,
              location: n.decl.location,
              subjects: [n.name, rep.name],
            });
            continue;
          }
          attrs[k] = v;
        }
      }
      netByRoot.set(root, {
        name: rep.name,
        aliases: sorted.map((n) => n.name),
        pins: [],
        attrs,
        portKinds: sorted.flatMap((n) => n.portKinds),
        location: rep.decl.location,
      });
    }

    for (const part of this.parts) {
      for (const pin of part.pins) {
        const node = this.pinNode.get(pin);
        if (node === undefined) continue;
        const net = netByRoot.get(this.find(node)) as FlatNet;
        pin.net = net.name;
        net.pins.push(pin);
      }
    }
    return { parts: this.parts, nets: [...netByRoot.values()] };
  }
}
