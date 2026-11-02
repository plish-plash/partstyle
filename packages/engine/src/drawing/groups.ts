import {
  GRID,
  isTwoTerminal,
  isVertical,
  type Node,
  type NodePin,
  type SheetInput,
} from "./nodes.js";
import { turnable } from "./orient.js";

/**
 * A two-terminal part drawn with a host rather than placed on its own: a **satellite** (on supply
 * nets only, a decoupling capacitor) in a row under or over its host part; a **shunt** (from a
 * signal net to a rail or ground) hanging under or standing over the wire beyond a host pin; a
 * **series** part in line beyond a host pin, whose far pin may host more.
 */
export interface Attachment {
  node: Node;
  kind: "satellite" | "shunt" | "series";
  /** The host node: an anchor, or for a chain, the series part before it. */
  host: string;
  /** The host pin, for shunts and series parts. */
  hostPin?: string;
  /** This part's pin on the host pin's net. */
  pin?: string;
}

/** One cell of the sheet: the units of a part (or a child sheet) with what rides along. */
export interface Group {
  /** Part refdes or instance name of the anchor. */
  id: string;
  line: number;
  anchors: Node[];
  attached: Attachment[];
}

const horizontal = (p: NodePin) => p.outward === 0 || p.outward === 180;

/**
 * Splits a sheet into groups. Anchors are every unit that is not a two-terminal part, child
 * sheets, and any part given a stage. Two-terminal parts attach to a host where they can; one
 * that finds none becomes an anchor itself, and may then host others (a pull-up feeding an LED).
 */
export function formGroups(input: SheetInput): Group[] {
  const { nodes, hints, roleOf } = input;
  const candidates = nodes.filter((n) => isTwoTerminal(n) && hints.get(n.ref)?.stage === undefined);
  const isCandidate = new Set(candidates.map((n) => n.id));
  const anchors = nodes.filter((n) => !isCandidate.has(n.id));
  const attachments = new Map<string, Attachment>();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Satellites: the nearest declared part on one of their rails, preferring one that takes or
  // makes the supply (an IC's input, a regulator's output) over one that merely carries it.
  const edgeFree = (n: Node, outward: number) =>
    n.pins.every((p) => p.outward !== outward || p.net === undefined || roleOf(p.net) !== "signal");
  for (const n of candidates) {
    if (!n.pins.every((p) => p.net !== undefined && roleOf(p.net) !== "signal")) continue;
    const rails = new Set(
      n.pins.flatMap((p) => (roleOf(p.net) === "rail" ? [p.net as string] : [])),
    );
    const consumes = (o: Node) =>
      o.pins.some(
        (p) =>
          p.net !== undefined &&
          rails.has(p.net) &&
          (p.type === "power_in" || p.type === "power_out"),
      )
        ? 0
        : 1;
    const owner = anchors
      .filter(
        (o) =>
          o.kind === "unit" &&
          !turnable.test(o.ref) &&
          (edgeFree(o, 270) || edgeFree(o, 90)) &&
          o.pins.some((p) => p.net !== undefined && rails.has(p.net)),
      )
      .sort(
        (a, b) =>
          consumes(a) - consumes(b) ||
          Math.abs(a.line - n.line) - Math.abs(b.line - n.line) ||
          a.line - b.line,
      )[0];
    if (owner) attachments.set(n.id, { node: n, kind: "satellite", host: owner.id });
  }

  const pending = candidates.filter((n) => !attachments.has(n.id));
  const isAnchor = new Set(anchors.map((n) => n.id));
  /** Host pins already carrying a series part: "nodeId#pin". */
  const chained = new Set<string>();
  /** Far pins of attached series parts, which can host in turn. */
  const chainPins: { node: Node; pin: NodePin }[] = [];
  const hostKey = (n: Node, p: NodePin) => `${n.id}#${p.id}`;

  /**
   * Whether a shunt row beyond `pin` would run into the host's other signal pins on that side:
   * their wires leave the same way and would cross it.
   */
  const blocked = (host: Node, pin: NodePin, below: boolean, part: Node) => {
    const span = 4 * GRID + part.box.h;
    return host.pins.some(
      (o) =>
        o !== pin &&
        o.outward === pin.outward &&
        o.net !== undefined &&
        o.net !== pin.net &&
        roleOf(o.net) === "signal" &&
        (below ? o.y > pin.y && o.y <= pin.y + span : o.y < pin.y && o.y >= pin.y - span),
    );
  };

  const anchorPins = (net: string, self: Node) =>
    anchors
      .filter((a) => isAnchor.has(a.id) && a.id !== self.id)
      .flatMap((a) => a.pins.filter((p) => p.net === net).map((pin) => ({ node: a, pin })))
      // Prefer the pin signal flows out of, so attached parts sit where the net starts.
      .sort(
        (x, y) =>
          (x.pin.outward === 0 ? 0 : 1) - (y.pin.outward === 0 ? 0 : 1) ||
          x.node.line - y.node.line,
      );

  const attach = (n: Node): boolean => {
    const signal = n.pins.filter((p) => p.net !== undefined && roleOf(p.net) === "signal");
    const supply = n.pins.filter((p) => p.net !== undefined && roleOf(p.net) !== "signal");
    if (isVertical(n) && signal.length === 1 && supply.length === 1) {
      const own = signal[0] as NodePin;
      const net = own.net as string;
      // A part whose signal pin is on top hangs below the wire; one with it underneath stands over.
      const below = own.outward === 90;
      const options = [
        ...anchorPins(net, n).filter(({ pin }) => horizontal(pin)),
        ...chainPins.filter(({ pin }) => pin.net === net),
      ];
      for (const { node, pin } of options) {
        if (blocked(node, pin, below, n)) continue;
        attachments.set(n.id, {
          node: n,
          kind: "shunt",
          host: node.id,
          hostPin: pin.id,
          pin: own.id,
        });
        return true;
      }
      // In line under a pin pointing down (or over one pointing up).
      const inline = anchorPins(net, n).find(({ pin }) => pin.outward === (below ? 270 : 90));
      if (inline) {
        attachments.set(n.id, {
          node: n,
          kind: "shunt",
          host: inline.node.id,
          hostPin: inline.pin.id,
          pin: own.id,
        });
        return true;
      }
      return false;
    }
    if (!isVertical(n) && signal.length >= 1 && signal.length + supply.length === 2) {
      let best: { node: Node; pin: NodePin; own: NodePin; rank: number } | undefined;
      for (const own of signal) {
        const net = own.net as string;
        const options = [
          ...anchorPins(net, n)
            .filter(({ pin }) => horizontal(pin))
            .map((o) => ({ ...o, rank: o.pin.outward === 0 ? 0 : 1 })),
          ...chainPins.filter(({ pin }) => pin.net === net).map((o) => ({ ...o, rank: 2 })),
        ].filter(({ node, pin }) => !chained.has(hostKey(node, pin)));
        for (const o of options) {
          if (
            !best ||
            o.rank < best.rank ||
            (o.rank === best.rank && o.node.line < best.node.line)
          ) {
            best = { ...o, own };
          }
        }
      }
      if (!best) return false;
      chained.add(hostKey(best.node, best.pin));
      attachments.set(n.id, {
        node: n,
        kind: "series",
        host: best.node.id,
        hostPin: best.pin.id,
        pin: best.own.id,
      });
      const far = n.pins.find((p) => p !== best?.own);
      if (far?.net !== undefined && roleOf(far.net) === "signal")
        chainPins.push({ node: n, pin: far });
      return true;
    }
    return false;
  };

  for (;;) {
    let progress = true;
    while (progress) {
      progress = false;
      for (const n of [...pending]) {
        if (attach(n)) {
          pending.splice(pending.indexOf(n), 1);
          progress = true;
        }
      }
    }
    // Nothing to hang on: the first declared becomes an anchor of its own.
    const first = pending.shift();
    if (!first) break;
    anchors.push(first);
    isAnchor.add(first.id);
  }

  const anchorOf = (id: string): Node => {
    const a = attachments.get(id);
    return a ? anchorOf(a.host) : (byId.get(id) as Node);
  };
  const groups = new Map<string, Group>();
  for (const a of [...anchors].sort((x, y) => x.line - y.line)) {
    const g = groups.get(a.ref) ?? { id: a.ref, line: a.line, anchors: [], attached: [] };
    g.anchors.push(a);
    groups.set(a.ref, g);
  }
  for (const att of [...attachments.values()].sort((x, y) => x.node.line - y.node.line)) {
    groups.get(anchorOf(att.host).ref)?.attached.push(att);
  }
  return [...groups.values()].sort((x, y) => x.line - y.line);
}
