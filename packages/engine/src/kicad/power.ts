import { child, children, readSExpr, type SExpr, sym, value, yesNo } from "./sexpr.js";
import { effects, property } from "./symbols.js";

/** Symbols of one KiCad library by (unqualified) name. */
export type SymbolLib = Map<string, SExpr[]>;

export const POWER_LIB = "power";

export function parseSymbolLib(text: string): SymbolLib {
  return new Map(children(readSExpr(text), "symbol").map((s) => [s[1] as string, s]));
}

const stroke: SExpr[] = ["stroke", ["width", 0], ["type", sym("default")]];
const noFill: SExpr[] = ["fill", ["type", sym("none")]];
const line = (...pts: [number, number][]): SExpr[] => [
  "polyline",
  ["pts", ...pts.map(([x, y]) => ["xy", x, y] as SExpr[])],
  stroke,
  noFill,
];

/** A power symbol in KiCad's shape: a `(power global)` symbol with one pin at the origin. */
function fallback(name: string, pinType: string, pinAngle: number, graphics: SExpr[][]): SExpr[] {
  const hidden = (k: string, v: string) => property(k, v, [0, 0, 0], { hide: true });
  return [
    "symbol",
    name,
    ["power", sym("global")],
    ["pin_numbers", ["hide", yesNo(true)]],
    ["pin_names", ["offset", 0], ["hide", yesNo(true)]],
    ["exclude_from_sim", yesNo(false)],
    ["in_bom", yesNo(true)],
    ["on_board", yesNo(true)],
    ["in_pos_files", yesNo(true)],
    ["duplicate_pin_numbers_are_jumpers", yesNo(false)],
    property("Reference", name === "PWR_FLAG" ? "#FLG" : "#PWR", [0, 0, 0], { hide: true }),
    property("Value", name, [0, 0, 0]),
    hidden("Footprint", ""),
    hidden("Datasheet", ""),
    hidden("Description", `${name} (partstyle fallback for KiCad's power:${name})`),
    ["symbol", `${name}_0_1`, ...graphics],
    [
      "symbol",
      `${name}_1_1`,
      [
        "pin",
        sym(pinType),
        sym("line"),
        ["at", 0, 0, pinAngle],
        ["length", 0],
        ["name", "~", effects()],
        ["number", "1", effects()],
      ],
    ],
    ["embedded_fonts", yesNo(false)],
  ];
}

/**
 * Stand-ins used only when KiCad's power library is not installed. Drawn here rather than copied
 * from KiCad's library; with KiCad present its real symbols are embedded instead.
 */
const fallbacks: SymbolLib = new Map([
  [
    "GND",
    fallback("GND", "power_in", 270, [
      line([0, 0], [0, -1.27], [1.27, -1.27], [0, -2.54], [-1.27, -1.27], [0, -1.27]),
    ]),
  ],
  [
    "VCC",
    fallback("VCC", "power_in", 90, [line([0, 0], [0, 1.27]), line([-0.762, 1.27], [0.762, 1.27])]),
  ],
  [
    "PWR_FLAG",
    fallback("PWR_FLAG", "power_out", 90, [
      line([0, 0], [0, 1.27], [-1.016, 1.905], [0, 2.54], [1.016, 1.905], [0, 1.27]),
    ]),
  ],
]);

export interface PowerSymbol {
  /** `power:GND`. */
  libId: string;
  /** Definition named `power:<name>`, for a schematic's lib_symbols. */
  def: SExpr[];
  /** Direction the drawing extends from the pin, in degrees (GND: 270, down). */
  bodyDir: number;
  pin: string;
}

function pinOf(def: SExpr[]): { number: string; angle: number } {
  for (const unit of children(def, "symbol")) {
    const pin = child(unit, "pin");
    if (!pin) continue;
    const at = child(pin, "at");
    return { number: value(pin, "number") ?? "1", angle: Number(at?.[3] ?? 90) };
  }
  return { number: "1", angle: 90 };
}

const isPowerSymbol = (def: SExpr[]) => child(def, "power") !== undefined;

const groundName = /^(A|D|P)?(GND|VSS|EARTH)/i;

export interface PowerLibrary {
  /** The symbol for a net: KiCad's own when it has one of that name, else GND or VCC. */
  forNet(netName: string, ground: boolean): PowerSymbol;
  flag(): PowerSymbol;
  /** A symbol by its lib_id (`power:GND`), as placed by `forNet` or `flag`. */
  byLibId(libId: string): PowerSymbol;
}

/** Power symbols from KiCad's `power` library when available, otherwise the fallbacks. */
export function powerLibrary(kicadPower: SymbolLib | undefined): PowerLibrary {
  const lib: SymbolLib = new Map([...fallbacks, ...(kicadPower ?? [])]);
  const get = (name: string): PowerSymbol => {
    const def = lib.get(name) ?? (fallbacks.get("VCC") as SExpr[]);
    const { number, angle } = pinOf(def);
    const [, , ...rest] = def;
    return {
      libId: `${POWER_LIB}:${def[1] as string}`,
      def: ["symbol", `${POWER_LIB}:${def[1] as string}`, ...rest],
      bodyDir: angle,
      pin: number,
    };
  };
  return {
    forNet: (netName, ground) => {
      const exact = lib.get(netName);
      if (exact && isPowerSymbol(exact) && netName !== "PWR_FLAG") return get(netName);
      return get(ground || groundName.test(netName) ? "GND" : "VCC");
    },
    flag: () => get("PWR_FLAG"),
    byLibId: (libId) => get(libId.slice(libId.indexOf(":") + 1)),
  };
}

type Point = { x: number; y: number };

/** Rotation that makes a power symbol's drawing point `outward`. */
export const powerRotation = (p: PowerSymbol, outward: number) =>
  (((outward - p.bodyDir) % 360) + 360) % 360;

/** Where a power symbol's net name goes: just beyond its drawing, centred. */
export function powerValueAt(at: Point, outward: number, value: string): Point {
  const rad = (outward * Math.PI) / 180;
  const horizontal = outward === 0 || outward === 180;
  // The drawings reach about 2.5 mm from the pin; the name sits clear of that, or of half its
  // width when it reads sideways.
  const distance = horizontal ? 3.4 + value.length * 0.55 : 4.19;
  return {
    x: at.x + Math.round(Math.cos(rad) * distance * 100) / 100,
    y: at.y - Math.round(Math.sin(rad) * distance * 100) / 100,
  };
}

/**
 * A placed power symbol whose drawing points `outward` from `at`. Its Value is the net name,
 * which is what makes KiCad connect it globally.
 */
export function placePower(
  p: PowerSymbol,
  opts: {
    at: Point;
    outward: number;
    value: string;
    valueAt: Point;
    uuid: string;
    pinUuid: string;
    project: string;
    refs: [path: string, ref: string][];
    /** Hide the net name, e.g. on the second of two adjacent pins on the same rail. */
    hideValue?: boolean;
  },
): SExpr[] {
  const { at, outward } = opts;
  const rotation = powerRotation(p, outward);
  // Field angles are relative to the symbol; counter-rotate so the net name reads horizontally.
  const textAt: [number, number, number] = [
    opts.valueAt.x,
    opts.valueAt.y,
    rotation === 90 || rotation === 270 ? 90 : 0,
  ];
  return [
    "symbol",
    ["lib_id", p.libId],
    ["at", at.x, at.y, rotation],
    ["unit", 1],
    ["body_style", 1],
    ["exclude_from_sim", yesNo(false)],
    ["in_bom", yesNo(true)],
    ["on_board", yesNo(true)],
    ["in_pos_files", yesNo(true)],
    ["dnp", yesNo(false)],
    ["uuid", opts.uuid],
    property("Reference", opts.refs[0]?.[1] ?? "#PWR", [at.x, at.y, 0], { hide: true }),
    property("Value", opts.value, textAt, { ...(opts.hideValue && { hide: true }) }),
    property("Footprint", "", [at.x, at.y, 0], { hide: true }),
    property("Datasheet", "", [at.x, at.y, 0], { hide: true }),
    property("Description", "", [at.x, at.y, 0], { hide: true }),
    ["pin", p.pin, ["uuid", opts.pinUuid]],
    [
      "instances",
      [
        "project",
        opts.project,
        ...opts.refs.map(
          ([path, ref]) => ["path", path, ["reference", ref], ["unit", 1]] as SExpr[],
        ),
      ],
    ],
  ];
}
