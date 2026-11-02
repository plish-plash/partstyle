import type {
  BlockDecl,
  LayoutHint,
  NetDecl,
  PartDecl,
  PartSpec,
  PinRef,
  PortDecl,
  Statement,
  UseDecl,
  WaiverDecl,
} from "./ast.js";

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const intent = (text: string | undefined) => (text === undefined ? "" : ` @ ${text}`);

/**
 * A layout hint as ` [stage rN flip]`; nothing when it says nothing, unless `explicit` (a patch
 * replacing a statement keeps its hint unless the new one says `[]`).
 */
export function printLayout(h: LayoutHint | undefined, explicit = false): string {
  const items = [
    ...(h?.stage !== undefined ? [String(h.stage)] : []),
    ...(h?.rotation !== undefined ? [`r${h.rotation}`] : []),
    ...(h?.flip !== undefined ? [h.flip ? "flip" : "noflip"] : []),
  ];
  return items.length === 0 && !explicit ? "" : ` [${items.join(" ")}]`;
}

export function printSpec(spec: PartSpec): string {
  return spec.kind === "lib" ? `lib:${spec.id}` : `${spec.fn}(${spec.args.join(", ")})`;
}

export const printPinRef = (p: Pick<PinRef, "target" | "pin">) => `${p.target}.${p.pin}`;

const printers = {
  block: (d: BlockDecl) =>
    `block ${d.name}${d.description === undefined ? "" : ` ${quote(d.description)}`}`,
  port: (d: PortDecl) => `port ${d.name} : ${d.kind}`,
  part: (d: PartDecl, explicit = false) =>
    `part ${d.ref} ${printSpec(d.spec)}${printLayout(d.layout, explicit)}${intent(d.intent)}`,
  net: (d: NetDecl) => {
    const attrs = Object.entries(d.attrs);
    return [
      `net ${d.name} : ${d.pins.map(printPinRef).join(" ")}`,
      d.port === undefined ? "" : ` -> port ${d.port}`,
      attrs.length === 0 ? "" : ` {${attrs.map(([k, v]) => `${k}: ${v}`).join(", ")}}`,
      intent(d.intent),
    ].join("");
  },
  use: (d: UseDecl, explicit = false) =>
    `use ${d.block} as ${d.instance}${printLayout(d.layout, explicit)}${intent(d.intent)}`,
  waive: (d: WaiverDecl) =>
    `waive ${d.subject}${d.code === undefined ? "" : ` ${d.code}`} ${quote(d.reason)}`,
};

/**
 * Prints a statement in canonical single-space form; re-parsing gives the same declaration.
 * `explicitLayout` prints `[]` for a part or use without a hint, for a patch that must clear one.
 */
export function printStatement(s: Statement, explicitLayout = false): string {
  switch (s.kind) {
    case "block":
      return printers.block(s.decl);
    case "port":
      return printers.port(s.decl);
    case "part":
      return printers.part(s.decl, explicitLayout);
    case "net":
      return printers.net(s.decl);
    case "use":
      return printers.use(s.decl, explicitLayout);
    case "waive":
      return printers.waive(s.decl);
  }
}
