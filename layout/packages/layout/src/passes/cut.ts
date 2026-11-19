import type { LayoutInput, LayoutNet, LayoutResult } from "../types.js";
import { renameNets } from "./split.js";

/** Private-use characters, which no real net name has, mark a piece of a cut net: `NET<N>`. */
const OPEN = String.fromCharCode(0xe002);
const CLOSE = String.fromCharCode(0xe003);
const PIECE = new RegExp(`${OPEN}\\d+${CLOSE}`, "g");

/** The net a piece came from (the net itself when it is not a piece). */
export const uncut = (net: string) => net.replace(PIECE, "");

/** Identifies a pin as `part`, NUL, `pin`. */
export const cutKey = (part: string, pin: string) => `${part}\u0000${pin}`;

/**
 * Cuts nets known to be drawn as labels into their pieces, each a net of its own, so that layout
 * places the parts as if those wires were never there: a piece only ties together the pins it
 * wires. `cut` lists each net's pieces as pin keys (`cutKey`).
 *
 * Returns the input to lay out, the pieces that must each get a label, and the function that
 * names them back after their net.
 */
export function cutNets(
  input: LayoutInput,
  cut: Map<string, string[][]>,
): { input: LayoutInput; labelled: Set<string>; restore: (r: LayoutResult) => LayoutResult } {
  const pieceOf = new Map<string, string>();
  const names = new Map<string, string[]>();
  for (const [net, pieces] of cut) {
    const list = pieces.map((_, i) => `${net}${OPEN}${i}${CLOSE}`);
    names.set(net, list);
    pieces.forEach((keys, i) => {
      for (const k of keys) pieceOf.set(k, list[i] as string);
    });
  }
  const parts = input.parts.map((p) => ({
    ...p,
    pins: p.pins.map((pin) => {
      const to = pieceOf.get(cutKey(p.id, pin.id));
      return to === undefined || pin.net === undefined || !cut.has(pin.net)
        ? pin
        : { ...pin, net: to };
    }),
  }));
  const used = new Set(parts.flatMap((p) => p.pins.map((q) => q.net)));
  const nets: LayoutNet[] = [];
  for (const n of input.nets) {
    const list = names.get(n.name) ?? [];
    // A pin no piece took stays on the net itself.
    if (list.length === 0 || used.has(n.name)) nets.push(n);
    list.forEach((name, i) => {
      const { flagged, ...rest } = n;
      nets.push({ ...rest, name, ...(flagged && i === 0 && { flagged }) });
    });
  }
  return {
    input: { ...input, parts, nets },
    labelled: new Set([...names.values()].flat()),
    restore: (r) => renameNets(r, input, uncut),
  };
}
