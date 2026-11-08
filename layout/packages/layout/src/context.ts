import type { Rules } from "./rules.js";
import type {
  LayoutInput,
  LayoutNet,
  LayoutPart,
  LayoutPin,
  PartRole,
  Pt,
  Rotation,
  TraceEntry,
} from "./types.js";

export interface PinRef {
  part: string;
  pin: string;
}

/** Prefix of the virtual parts that stand in for signal ports while placing. */
export const PORT_PREFIX = "$port:";
export const isPort = (id: string) => id.startsWith(PORT_PREFIX);

/** Parts from a wire to a rail: one shunt, or a chain such as a resistor and LED. */
export interface Hanger {
  id: number;
  /** Listed from the wire outward. Empty for a bare power symbol on a wire. */
  parts: string[];
  /** The net at the top of each part, from the wire outward. */
  nets: string[];
  attach: string;
  rail: string;
  dir: "up" | "down";
  /** Wire between the row and the first part, set to line up with neighbouring hangers. */
  stem?: number;
}

/** Parts between two rails, drawn upright by themselves. */
export interface Stack {
  /** Top to bottom. */
  parts: string[];
  /** The net at the top of each part, then the bottom net. */
  nets: string[];
}

/** Series parts between two wires. */
export interface Chain {
  id: number;
  parts: string[];
  /** `nets[i]` and `nets[i + 1]` are either side of `parts[i]`. */
  nets: string[];
  kind: "through" | "loop" | "bridge";
}

export interface Analysis {
  hangers: Hanger[];
  stacks: Stack[];
  chains: Chain[];
  /** Wires a rail runs along: side pins of a regulator, the output of an inductor. */
  railWires: Set<string>;
  anchors: string[];
  /** Ports with one anchor to reach: they end that anchor's row instead of taking a column. */
  terminalPorts: Set<string>;
  hangersOn: Map<string, Hanger[]>;
  chainsOn: Map<string, Chain[]>;
  /** Two-terminal parts with a pin on no net: not wired in yet, so set aside. */
  loose: string[];
}

export interface Placement {
  at: Pt;
  rotation: Rotation;
  mirror: boolean;
}

export class Ctx {
  readonly parts = new Map<string, LayoutPart>();
  readonly nets = new Map<string, LayoutNet>();
  readonly netPins = new Map<string, PinRef[]>();
  readonly trace = new Map<string, TraceEntry[]>();
  readonly roles = new Map<string, PartRole>();
  readonly columns = new Map<string, number>();
  /** Mirror state of anchors, decided from the columns. */
  readonly mirror = new Map<string, boolean>();

  constructor(
    readonly input: LayoutInput,
    readonly rules: Rules,
  ) {
    for (const n of input.nets) {
      this.nets.set(n.name, n);
      this.netPins.set(n.name, []);
    }
    for (const p of input.parts) this.addPart(p);
    let order = input.parts.length;
    for (const n of input.nets) {
      if (n.port && n.role === "signal") this.addPart(portPart(n, order++));
    }
  }

  private addPart(p: LayoutPart) {
    this.parts.set(p.id, p);
    for (const pin of p.pins) {
      if (pin.net === undefined) continue;
      let list = this.netPins.get(pin.net);
      if (!list) {
        list = [];
        this.netPins.set(pin.net, list);
      }
      list.push({ part: p.id, pin: pin.id });
    }
  }

  part(id: string): LayoutPart {
    return this.parts.get(id) as LayoutPart;
  }

  pin(ref: PinRef): LayoutPin {
    return this.part(ref.part).pins.find((p) => p.id === ref.pin) as LayoutPin;
  }

  note(part: string, rule: string, note: string) {
    const list = this.trace.get(part) ?? [];
    list.push({ rule, note });
    this.trace.set(part, list);
  }

  role(net: string) {
    return this.nets.get(net)?.role ?? "signal";
  }

  /** Whether this rail's symbols hang down rather than stand up. */
  railPointsDown(net: string) {
    if (this.role(net) === "ground") return true;
    return this.rules.on("negative-rails") && this.nets.get(net)?.pointsDown === true;
  }

  /** Whether layout treats this part as two-ended and free to turn. */
  isTwoTerminal(p: LayoutPart): boolean {
    if (p.pins.length !== 2) return false;
    return ["resistor", "capacitor", "inductor", "ferrite", "diode", "led", "crystal"].includes(
      p.kind,
    );
  }
}

function portPart(n: LayoutNet, order: number): LayoutPart {
  const w = Math.ceil(n.name.length * 0.5) + 2;
  return {
    id: `${PORT_PREFIX}${n.name}`,
    ref: n.name,
    kind: "connector",
    order,
    box: { x: 0, y: -0.5, w, h: 1 },
    pins: [
      {
        id: "p",
        name: n.name,
        x: w,
        y: 0,
        outward: 0,
        type: n.port === "input" ? "output" : n.port === "output" ? "input" : "bidir",
        net: n.name,
      },
    ],
  };
}
