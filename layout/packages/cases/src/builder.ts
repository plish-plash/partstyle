import type {
  Direction,
  LayoutInput,
  LayoutNet,
  LayoutPart,
  LayoutPin,
  NetRole,
  PartKind,
  PinType,
} from "@partstyle/layout";

export type Category = "Sanity" | "MCU" | "LED chains" | "Signal chains" | "Power" | "Whole sheets";

export interface TestCase {
  id: string;
  title: string;
  category: Category;
  description: string;
  input: LayoutInput;
}

/** `"NAME"`, or `"NAME:type"` to override the side's default. `null` leaves a gap. */
export type PinSpec = string | null;

export interface IcSides {
  left?: PinSpec[];
  right?: PinSpec[];
  top?: PinSpec[];
  bottom?: PinSpec[];
  /** Spacing of top and bottom pins, in grid units. */
  topPitch?: number;
}

function parsePin(spec: string, fallback: PinType): { name: string; type: PinType } {
  const [name, type] = spec.split(":");
  return { name: name as string, type: (type as PinType | undefined) ?? fallback };
}

/** Writes a block as parts and nets, checking every pin reference as it goes. */
export class Circuit {
  private parts: LayoutPart[] = [];
  private nets = new Map<string, LayoutNet>();
  private assigned = new Set<string>();
  /** Two-terminal symbols from here on are drawn upright, pin 1 on top. */
  private upright = false;

  private two(kind: PartKind, ref: string, value: string | undefined, span = 3): this {
    const pin = (id: string, at: number, outward: Direction): LayoutPin => ({
      id,
      name: id,
      x: this.upright ? 0 : at,
      y: this.upright ? at : 0,
      outward: this.upright ? (at === 0 ? 90 : 270) : outward,
      type: "passive",
    });
    this.parts.push({
      id: ref,
      ref,
      ...(value !== undefined ? { value } : {}),
      kind,
      order: this.parts.length,
      box: this.upright ? { x: -1, y: 0, w: 2, h: span } : { x: 0, y: -1, w: span, h: 2 },
      pins: [pin("1", 0, 180), pin("2", span, 0)],
    });
    return this;
  }

  drawUpright() {
    this.upright = true;
    return this;
  }

  res = (ref: string, value?: string) => this.two("resistor", ref, value);
  cap = (ref: string, value?: string) => this.two("capacitor", ref, value);
  ind = (ref: string, value?: string) => this.two("inductor", ref, value, 4);
  bead = (ref: string, value?: string) => this.two("ferrite", ref, value);
  /** Pin 1 is the anode, pin 2 the cathode. */
  diode = (ref: string, value?: string) => this.two("diode", ref, value);
  /** Pin 1 is the anode, pin 2 the cathode. */
  led = (ref: string, value?: string) => this.two("led", ref, value);
  xtal = (ref: string, value?: string) => this.two("crystal", ref, value);

  /** A box with fixed pin positions, left and right pins on a 1-grid pitch. */
  ic(ref: string, value: string, sides: IcSides, kind: PartKind = "ic"): this {
    const left = sides.left ?? [];
    const right = sides.right ?? [];
    const top = sides.top ?? [];
    const bottom = sides.bottom ?? [];
    const pitch = sides.topPitch ?? 2;
    const nameLen = (list: PinSpec[]) =>
      Math.max(0, ...list.map((s) => (s ? (s.split(":")[0] as string).length : 0)));
    const across = Math.max(top.length, bottom.length) * pitch;
    const inner = Math.ceil((nameLen(left) + nameLen(right)) * 0.5) + 2;
    const w = Math.max(6, across + 2, inner + 2);
    const h = Math.max(left.length, right.length) + 3;
    const pins: LayoutPin[] = [];
    const add = (spec: PinSpec, x: number, y: number, outward: Direction, type: PinType) => {
      if (!spec) return;
      const p = parsePin(spec, type);
      pins.push({ id: p.name, name: p.name, x, y, outward, type: p.type });
    };
    left.forEach((s, i) => {
      add(s, 0, i + 2, 180, "input");
    });
    right.forEach((s, i) => {
      add(s, w, i + 2, 0, "output");
    });
    const start = (n: number) => Math.round((w - (n - 1) * pitch) / 2);
    top.forEach((s, i) => {
      add(s, start(top.length) + i * pitch, 0, 90, "power_in");
    });
    bottom.forEach((s, i) => {
      add(s, start(bottom.length) + i * pitch, h, 270, "power_in");
    });
    this.parts.push({
      id: ref,
      ref,
      value,
      kind,
      order: this.parts.length,
      box: { x: 0, y: 0, w, h },
      pins,
    });
    return this;
  }

  /** A child sheet: its signal ports only, since power ports connect by name and get no pins. */
  sheet(ref: string, block: string, inputs: string[], outputs: string[]): this {
    return this.ic(ref, block, { left: inputs, right: outputs }, "sheet");
  }

  /** A single-row header with all pins on the right; layout mirrors it to face the circuit. */
  conn(ref: string, value: string, pins: string[]): this {
    const list: LayoutPin[] = pins.map((spec, i) => {
      const p = parsePin(spec, "passive");
      return { id: p.name, name: p.name, x: 4, y: i + 1, outward: 0, type: p.type };
    });
    this.parts.push({
      id: ref,
      ref,
      value,
      kind: "connector",
      order: this.parts.length,
      box: { x: 0, y: 0, w: 4, h: pins.length + 1 },
      pins: list,
    });
    return this;
  }

  opamp(ref: string, value: string): this {
    return this.ic(
      ref,
      value,
      { left: ["+", null, "-"], right: [null, "OUT"], top: ["V+"], bottom: ["V-"] },
      "opamp",
    );
  }

  /** G on the left, D on top, S on the bottom. */
  fet(ref: string, value: string): this {
    this.parts.push({
      id: ref,
      ref,
      value,
      kind: "transistor",
      order: this.parts.length,
      box: { x: 0, y: 0, w: 3, h: 4 },
      pins: [
        { id: "G", name: "G", x: 0, y: 2, outward: 180, type: "input" },
        { id: "D", name: "D", x: 3, y: 0, outward: 90, type: "passive" },
        { id: "S", name: "S", x: 3, y: 4, outward: 270, type: "passive" },
      ],
    });
    return this;
  }

  private connect(name: string, role: NetRole, pins: string[], port?: LayoutNet["port"]): this {
    if (this.nets.has(name)) throw new Error(`net ${name} declared twice`);
    const below = role === "power" && /^(-|VEE|VNEG|V-)/i.test(name);
    this.nets.set(name, {
      name,
      role,
      ...(port ? { port } : {}),
      ...(below ? { pointsDown: true } : {}),
    });
    for (const ref of pins) {
      const dot = ref.indexOf(".");
      const partId = ref.slice(0, dot);
      const pinId = ref.slice(dot + 1);
      const part = this.parts.find((p) => p.id === partId);
      if (!part) throw new Error(`net ${name}: no part ${partId}`);
      const pin = part.pins.find((p) => p.id === pinId);
      if (!pin) throw new Error(`net ${name}: ${partId} has no pin ${pinId}`);
      if (this.assigned.has(ref)) throw new Error(`net ${name}: ${ref} already connected`);
      this.assigned.add(ref);
      pin.net = name;
    }
    return this;
  }

  net = (name: string, ...pins: string[]) => this.connect(name, "signal", pins);
  input = (name: string, ...pins: string[]) => this.connect(name, "signal", pins, "input");
  output = (name: string, ...pins: string[]) => this.connect(name, "signal", pins, "output");
  rail = (name: string, ...pins: string[]) => this.connect(name, "power", pins);
  gnd = (name: string, ...pins: string[]) => this.connect(name, "ground", pins);

  /** Asks for a marker on these nets. */
  flag(...names: string[]) {
    for (const name of names) {
      const net = this.nets.get(name);
      if (!net) throw new Error(`no net ${name}`);
      net.flagged = true;
    }
    return this;
  }

  build(name: string): LayoutInput {
    return { name, parts: this.parts, nets: [...this.nets.values()] };
  }
}

/**
 * The same circuit declared in a different order, for checking that layout does not lean on it.
 * Seed 0 leaves it as written; any other seed gives one repeatable shuffle.
 */
export function shuffleInput(input: LayoutInput, seed: number): LayoutInput {
  if (seed === 0) return input;
  let state = seed * 2654435761;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return {
    name: input.name,
    parts: shuffled(input.parts).map((p, order) => ({ ...p, order })),
    nets: shuffled(input.nets),
  };
}
