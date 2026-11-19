import type {
  LayoutInput,
  LayoutNet,
  LayoutPart,
  LayoutPin,
  LayoutResult,
  NetRole,
} from "../types.js";

/** Private-use characters, which no real net name has, mark a piece of a rail: `RAIL<N>`. */
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const PIECE = new RegExp(`${OPEN}\\d+${CLOSE}`, "g");

/** The net a piece came from (the net itself when it is not a piece). */
export const baseNet = (net: string) => net.replace(PIECE, "");

const TWO_TERMINAL = ["resistor", "capacitor", "inductor", "ferrite", "diode", "led", "crystal"];
const isTwoTerminal = (p: LayoutPart) => p.pins.length === 2 && TWO_TERMINAL.includes(p.kind);
const isSide = (outward: number) => outward === 0 || outward === 180;
/** A power pin that puts its rail in wire mode: a side output, or an IC's side input. */
const drawsWire = (p: LayoutPart, pin: LayoutPin) =>
  isSide(pin.outward) &&
  (pin.type === "power_out" || (p.kind !== "connector" && pin.type === "power_in"));

/**
 * The parts that put each rail in wire mode: a side power output, an IC's side power input, or
 * either side of an inductor or ferrite between rails. Current runs along such a wire, so its caps
 * hang off it.
 */
export function wireTriggers(input: LayoutInput): Map<string, string[]> {
  const role = new Map(input.nets.map((n) => [n.name, n.role]));
  const out = new Map<string, string[]>();
  const add = (net: string, part: string) => {
    const list = out.get(net) ?? [];
    if (!list.includes(part)) list.push(part);
    out.set(net, list);
  };
  for (const p of input.parts) {
    for (const pin of p.pins) {
      if (pin.net === undefined || role.get(pin.net) !== "power") continue;
      if (drawsWire(p, pin)) add(pin.net, p.id);
    }
    if ((p.kind === "inductor" || p.kind === "ferrite") && p.pins.length === 2) {
      const [a, b] = [p.pins[0]?.net, p.pins[1]?.net];
      if (a === undefined || b === undefined) continue;
      if (role.get(a) === "power" && role.get(b) !== "ground") add(a, p.id);
      if (role.get(b) === "power" && role.get(a) !== "ground") add(b, p.id);
    }
  }
  return out;
}

/**
 * Narrows each rail in wire mode to the parts current really runs between, so the wire does not
 * reach every pin on the rail: an MCU's VDD on its side gets a wire of its own, not one through
 * every pull-up on the sheet.
 *
 * With one source on the rail (a side power output, an inductor or a ferrite), the wire runs from
 * it to the side power inputs it feeds, as from one regulator into the next. Without one, each
 * part drawing the rail this way has its own wire, a piece of the rail. When the rail has a single
 * wire, caps to another rail hang from it, and so does a part leading to no other IC (an LED and
 * its resistor, a diode from the supply jack). Everything else on the rail, such as a pull-up to
 * an IC's pin, keeps its own symbol. A wire that would only join one part's own pins, spread apart, is not drawn: those
 * pins take symbols of their own.
 *
 * Returns the input to lay out, the nets (pieces) to draw as wires, and the function that names
 * the pieces back after their rail.
 */
export function splitRailWires(input: LayoutInput): {
  input: LayoutInput;
  wires: Set<string>;
  restore: (r: LayoutResult) => LayoutResult;
} {
  const triggers = wireTriggers(input);
  const role = new Map<string, NetRole>(input.nets.map((n) => [n.name, n.role]));
  const isRailNet = (n: string | undefined) => n !== undefined && role.get(n) !== "signal";
  const byId = new Map(input.parts.map((p) => [p.id, p]));
  const partsOn = new Map<string, LayoutPart[]>();
  for (const p of input.parts) {
    for (const pin of p.pins) {
      if (pin.net !== undefined) partsOn.set(pin.net, [...(partsOn.get(pin.net) ?? []), p]);
    }
  }
  /**
   * A net reaching no part with a pin of its own to drive, only two-terminal parts and
   * connectors: between an LED and its resistor, or a supply's jack and its diode.
   */
  const leadsNowhere = (net: string) =>
    (partsOn.get(net) ?? []).every((p) => isTwoTerminal(p) || p.kind === "connector");
  const isSource = (p: LayoutPart, net: string) =>
    p.kind === "inductor" ||
    p.kind === "ferrite" ||
    p.pins.some((q) => q.net === net && q.type === "power_out" && isSide(q.outward));

  // pin key → piece name
  const moved = new Map<string, string>();
  const pinKey = (part: string, pin: string) => `${part}\u0000${pin}`;
  const pieces = new Map<string, string[]>();
  const wires = new Set<string>();
  for (const [net, parts] of triggers) {
    const sources = parts.filter((id) => isSource(byId.get(id) as LayoutPart, net));
    const chain = sources.length === 1;
    /** The sides of a part whose pins put the rail in wire mode, busiest first. */
    const sidesOf = (id: string): number[] => {
      const p = byId.get(id) as LayoutPart;
      const pins = p.pins.filter((q) => q.net === net && (isTwoTerminal(p) || drawsWire(p, q)));
      const count = new Map<number, number>();
      for (const q of pins) count.set(q.outward, (count.get(q.outward) ?? 0) + 1);
      return [...count.keys()].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0));
    };
    // A wire belongs to one side of a part. With one source, the rail is one wire through each
    // part's busiest side; otherwise each side of each part has a wire of its own.
    const owners: { part: string; side: number }[] = parts.flatMap((id) =>
      (chain ? sidesOf(id).slice(0, 1) : sidesOf(id)).map((side) => ({ part: id, side })),
    );
    const ownerOf = (part: string, side: number) =>
      chain ? 0 : owners.findIndex((o) => o.part === part && o.side === side);
    const pieceOf = (i: number) => `${net}${OPEN}${i}${CLOSE}`;
    const single = chain || owners.length === 1;
    const assign = new Map<string, number>();
    for (const p of input.parts) {
      for (const pin of p.pins) {
        if (pin.net !== net) continue;
        if (parts.includes(p.id)) {
          const mine = owners.some((o) => o.part === p.id && o.side === pin.outward);
          if (mine) assign.set(pinKey(p.id, pin.id), ownerOf(p.id, pin.outward));
        } else if (single && isTwoTerminal(p)) {
          const other = p.pins.find((q) => q !== pin)?.net;
          if (isRailNet(other) || (other !== undefined && leadsNowhere(other))) {
            assign.set(pinKey(p.id, pin.id), 0);
          }
        }
      }
    }
    // A piece of one part's pins alone is a wire only where they sit in one run.
    const worthIt = (i: number) => {
      const keys = [...assign].filter(([, v]) => v === i).map(([k]) => k);
      const partOf = (k: string) => k.slice(0, k.indexOf("\u0000"));
      if (new Set(keys.map(partOf)).size > 1) return true;
      const part = byId.get(partOf(keys[0] ?? "")) as LayoutPart | undefined;
      return (
        part !== undefined &&
        compactRun(part.pins.filter((q) => keys.includes(pinKey(part.id, q.id))))
      );
    };
    const pieceIds = [...new Set(assign.values())];
    const kept = pieceIds.filter(worthIt);
    for (const [k, v] of [...assign]) if (!kept.includes(v)) assign.delete(k);
    const onNet = (partsOn.get(net) ?? []).length;
    // All of the rail on one wire: nothing to split.
    if (kept.length === 1 && assign.size === onNet) {
      wires.add(net);
      continue;
    }
    for (const [k, v] of assign) moved.set(k, pieceOf(v));
    const names = [...new Set(assign.values())].map(pieceOf);
    for (const n of names) wires.add(n);
    if (names.length > 0) pieces.set(net, names);
  }
  if (moved.size === 0) return { input, wires, restore: (r) => r };

  const parts = input.parts.map((p) => ({
    ...p,
    pins: p.pins.map((pin) => {
      const to = moved.get(pinKey(p.id, pin.id));
      return to === undefined ? pin : { ...pin, net: to };
    }),
  }));
  const used = new Set(parts.flatMap((p) => p.pins.map((q) => q.net)));
  const nets: LayoutNet[] = [];
  for (const n of input.nets) {
    const list = pieces.get(n.name) ?? [];
    const keeps = used.has(n.name);
    // One marker per rail: on what is left of it, else on its first piece.
    if (keeps || list.length === 0) nets.push(n);
    list.forEach((name, i) => {
      const { port: _port, flagged, ...rest } = n;
      nets.push({ ...rest, name, ...(flagged && !keeps && i === 0 && { flagged }) });
    });
  }

  const restore = (r: LayoutResult): LayoutResult => {
    const trace: LayoutResult["trace"] = {};
    for (const [id, list] of Object.entries(r.trace)) {
      trace[id] = list.map((t) => ({ ...t, note: baseNet(t.note) }));
    }
    const original = new Map(input.parts.map((p) => [p.id, p]));
    return {
      ...r,
      parts: r.parts.map((p) => ({
        ...p,
        pins: p.pins.map((pin) => {
          const net = original.get(p.id)?.pins.find((q) => q.id === pin.id)?.net;
          const { net: _net, ...rest } = pin;
          return net === undefined ? rest : { ...rest, net };
        }),
      })),
      wires: r.wires.map((w) => ({ ...w, net: baseNet(w.net) })),
      junctions: r.junctions.map((j) => ({ ...j, net: baseNet(j.net) })),
      power: r.power.map((s) => {
        const net = baseNet(s.net);
        return { ...s, net, name: net, showName: s.role !== "ground" || net !== "GND" };
      }),
      labels: r.labels.map((l) => ({ ...l, net: baseNet(l.net), text: baseNet(l.text) })),
      markers: r.markers.map((m) => ({ ...m, net: baseNet(m.net) })),
      unrouted: r.unrouted.map((u) => ({ ...u, net: baseNet(u.net) })),
      trace,
    };
  };
  return { input: { ...input, parts, nets }, wires, restore };
}

/** Whether pins of one part sit together: one side, each within two of the next. */
function compactRun(pins: LayoutPin[]): boolean {
  if (pins.length <= 1) return true;
  if (new Set(pins.map((p) => p.outward)).size > 1) return false;
  const vertical = isSide(pins[0]?.outward ?? 0);
  const at = pins.map((p) => (vertical ? p.y : p.x)).sort((a, b) => a - b);
  return at.every((v, i) => i === 0 || v - (at[i - 1] as number) <= 2);
}
