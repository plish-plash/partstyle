import { genericPins, parseGenericSpec, splitGenericText } from "../parts/generic.js";
import { type PartRecord, type PinType, partName } from "../parts/schema.js";
import { type SExpr, sym, yesNo } from "./sexpr.js";

/** Schematic grid: every pin connection point lands on multiples of this. */
export const GRID = 2.54;
const PIN_LENGTH = 2.54;
const CHAR_WIDTH = 1.27;

export const LIB = "partstyle";

/** A pin's connection point and the direction it extends away from the body, in symbol coords (y up). */
export interface PinAnchor {
  x: number;
  y: number;
  /** Outward direction in degrees: 0 right, 90 up, 180 left, 270 down. */
  outward: number;
}

export interface GeneratedSymbol {
  /** Library-local name (`L7805CV`, `res`); the lib_id is `partstyle:<name>`. */
  name: string;
  /** The `(symbol ...)` definition, named `name`; see `qualified()` for the schematic copy. */
  def: SExpr[];
  /** Pin number → anchor. */
  pins: Map<string, PinAnchor>;
  /** Extent including pins, symbol coords. */
  box: { minX: number; maxX: number; minY: number; maxY: number };
  refPrefix: string;
}

const kicadPinType: Record<PinType, string> = {
  input: "input",
  output: "output",
  bidir: "bidirectional",
  tristate: "tri_state",
  passive: "passive",
  power_in: "power_in",
  power_out: "power_out",
  open_collector: "open_collector",
  open_emitter: "open_emitter",
  nc: "no_connect",
};

export const toKicadPinType = (t: PinType) => kicadPinType[t];

const font = (size = 1.27): SExpr[] => ["font", ["size", size, size]];

export function effects(opts: { hide?: boolean; justify?: string[]; size?: number } = {}): SExpr[] {
  const e: SExpr[] = ["effects", font(opts.size)];
  if (opts.justify) e.push(["justify", ...opts.justify.map(sym)]);
  return e;
}

export function property(
  name: string,
  val: string,
  at: [number, number, number],
  opts: { hide?: boolean; justify?: string[] } = {},
): SExpr[] {
  return [
    "property",
    name,
    val,
    ["at", ...at],
    ...(opts.hide ? [["hide", yesNo(true)] as SExpr[]] : []),
    ["show_name", yesNo(false)],
    ["do_not_autoplace", yesNo(false)],
    effects(opts),
  ];
}

const stroke = (width = 0.254): SExpr[] => ["stroke", ["width", width], ["type", sym("default")]];
const fill = (type: "none" | "background" | "outline"): SExpr[] => ["fill", ["type", sym(type)]];

const rect = (x1: number, y1: number, x2: number, y2: number, f: "none" | "background") => [
  "rectangle",
  ["start", x1, y1],
  ["end", x2, y2],
  stroke(),
  fill(f),
];

const polyline = (pts: [number, number][], f: "none" | "outline" = "none"): SExpr[] => [
  "polyline",
  ["pts", ...pts.map(([x, y]) => ["xy", x, y] as SExpr[])],
  stroke(),
  fill(f),
];

/** Lib angle points from the connection point toward the body: opposite of outward. */
const libAngle = (outward: number) => (outward + 180) % 360;

function pinExpr(
  type: PinType,
  name: string,
  number: string,
  a: PinAnchor,
  length = PIN_LENGTH,
): SExpr[] {
  return [
    "pin",
    sym(toKicadPinType(type)),
    sym("line"),
    ["at", a.x, a.y, libAngle(a.outward)],
    ["length", length],
    ["name", name, effects()],
    ["number", number, effects()],
  ];
}

function symbolDef(
  name: string,
  opts: {
    refPrefix: string;
    value: string;
    description: string;
    showPinNames: boolean;
    showPinNumbers: boolean;
    box: GeneratedSymbol["box"];
  },
  graphics: SExpr[][],
  pins: SExpr[][],
): SExpr[] {
  const { box } = opts;
  return [
    "symbol",
    name,
    ...(opts.showPinNumbers ? [] : [["pin_numbers", ["hide", yesNo(true)]] as SExpr[]]),
    [
      "pin_names",
      ["offset", 0.508],
      ...(opts.showPinNames ? [] : [["hide", yesNo(true)] as SExpr[]]),
    ],
    ["exclude_from_sim", yesNo(false)],
    ["in_bom", yesNo(true)],
    ["on_board", yesNo(true)],
    ["in_pos_files", yesNo(true)],
    ["duplicate_pin_numbers_are_jumpers", yesNo(false)],
    property("Reference", opts.refPrefix, [box.minX, box.maxY + 1.27, 0], {
      justify: ["left", "bottom"],
    }),
    property("Value", opts.value, [box.minX, box.minY - 1.27, 0], { justify: ["left", "top"] }),
    property("Footprint", "", [0, 0, 0], { hide: true }),
    property("Datasheet", "", [0, 0, 0], { hide: true }),
    property("Description", opts.description, [0, 0, 0], { hide: true }),
    ["symbol", `${name}_0_1`, ...graphics],
    ["symbol", `${name}_1_1`, ...pins],
    ["embedded_fonts", yesNo(false)],
  ];
}

/** Copy of a symbol definition named `partstyle:<name>`, as the schematic's lib_symbols holds it. */
export function qualified(s: GeneratedSymbol): SExpr[] {
  const [head, , ...rest] = s.def;
  return [head as string, `${LIB}:${s.name}`, ...rest];
}

const groundName = /^(A|D|P)?(GND|VSS|VEE)[A-Z0-9_]*$/i;
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
const roundUp = (x: number, step: number) => Math.ceil(x / step - 1e-9) * step;

/**
 * Box symbol from a part record: supplies on top, grounds below, inputs left, outputs and I/O
 * right. A part that supplies power itself (a regulator) takes its supply in on the left, so
 * that power flows left to right through it.
 */
export function symbolForRecord(record: PartRecord): GeneratedSymbol {
  const pins = Object.entries(record.pins)
    .map(([number, p]) => ({ number, ...p }))
    .sort((a, b) => natural(a.number, b.number));
  const left: typeof pins = [];
  const right: typeof pins = [];
  const top: typeof pins = [];
  const bottom: typeof pins = [];
  const allPassive = pins.every((p) => p.type === "passive");
  const supplies = pins.some((p) => p.type === "power_out");

  if (allPassive && pins.length === 2) {
    left.push(pins[0] as (typeof pins)[number]);
    right.push(pins[1] as (typeof pins)[number]);
  } else {
    const leftOrder: PinType[] = ["power_in", "input", "passive"];
    for (const p of pins) {
      if (p.type === "power_in" && groundName.test(p.name)) bottom.push(p);
      else if (p.type === "power_in" && !supplies) top.push(p);
      else if (leftOrder.includes(p.type)) left.push(p);
      else right.push(p);
    }
    left.sort((a, b) => leftOrder.indexOf(a.type) - leftOrder.indexOf(b.type));
  }

  const longest = (side: typeof pins) => Math.max(0, ...side.map((p) => p.name.length));
  const showNames = !allPassive;
  const nameSpace = showNames ? (longest(left) + longest(right)) * CHAR_WIDTH + 2 * GRID : 2 * GRID;
  const halfWidth = Math.max(
    2 * GRID,
    roundUp(nameSpace / 2, GRID),
    roundUp(((Math.max(top.length, bottom.length) + 1) * GRID) / 2, GRID),
  );
  // Tall enough for the names of top and bottom pins, which read downward and upward inside.
  const vertical = showNames ? (longest(top) + longest(bottom)) * CHAR_WIDTH + GRID : 0;
  const rows = Math.max(left.length, right.length, 1, Math.ceil(vertical / GRID) - 1);
  const topPin = GRID * Math.floor((rows - 1) / 2);
  const bodyTop = topPin + GRID;
  const bodyBottom = topPin - GRID * rows;

  const anchors = new Map<string, PinAnchor>();
  const pinExprs: SExpr[][] = [];
  const place = (p: (typeof pins)[number], a: PinAnchor) => {
    anchors.set(p.number, a);
    pinExprs.push(pinExpr(p.type, p.name, p.number, a));
  };
  for (const [i, p] of left.entries()) {
    place(p, { x: -halfWidth - PIN_LENGTH, y: topPin - GRID * i, outward: 180 });
  }
  for (const [i, p] of right.entries()) {
    place(p, { x: halfWidth + PIN_LENGTH, y: topPin - GRID * i, outward: 0 });
  }
  const firstBottom = -GRID * Math.floor((bottom.length - 1) / 2);
  for (const [i, p] of bottom.entries()) {
    place(p, { x: firstBottom + GRID * i, y: bodyBottom - PIN_LENGTH, outward: 270 });
  }
  const firstTop = -GRID * Math.floor((top.length - 1) / 2);
  for (const [i, p] of top.entries()) {
    place(p, { x: firstTop + GRID * i, y: bodyTop + PIN_LENGTH, outward: 90 });
  }

  const box = {
    minX: -halfWidth - PIN_LENGTH,
    maxX: halfWidth + PIN_LENGTH,
    minY: bottom.length > 0 ? bodyBottom - PIN_LENGTH : bodyBottom,
    maxY: top.length > 0 ? bodyTop + PIN_LENGTH : bodyTop,
  };
  return {
    name: record.id,
    def: symbolDef(
      record.id,
      {
        refPrefix: refPrefixFor(record),
        value: partName(record),
        description: record.summary,
        showPinNames: showNames,
        showPinNumbers: true,
        box,
      },
      [rect(-halfWidth, bodyTop, halfWidth, bodyBottom, "background")],
      pinExprs,
    ),
    pins: anchors,
    box,
    refPrefix: refPrefixFor(record),
  };
}

function refPrefixFor(record: PartRecord): string {
  const names = Object.values(record.pins).map((p) => p.name);
  if (names.includes("K") && names.includes("A")) return "D";
  if (Object.values(record.pins).every((p) => p.type === "passive")) return "J";
  return "U";
}

/**
 * The generated generic symbol for a record that names its `generic`, so a real capacitor looks
 * like a capacitor without KiCad's libraries. Undefined when its pads don't line up with the
 * symbol's: pin 1 of a diode is K here, and the polarity of a part must not be drawn backwards.
 */
export function symbolForRecordGeneric(record: PartRecord): GeneratedSymbol | undefined {
  const generic = record.generic === undefined ? undefined : splitGenericText(record.generic);
  if (!generic) return undefined;
  const pins = genericPins(generic.fn, generic.args);
  const fits =
    pins.length === Object.keys(record.pins).length &&
    pins.every((p) => {
      const pad = record.pins[p.number];
      return pad !== undefined && (p.name === p.number || p.name === pad.name);
    });
  return fits ? symbolForGeneric(generic.fn, generic.args) : undefined;
}

/** Symbols for generic parts: two-terminal passives drawn vertically, diodes horizontally. */
export function symbolForGeneric(fn: string, args: string[] = []): GeneratedSymbol | undefined {
  if (fn === "fp") {
    const pins = genericPins(fn, args);
    return symbolForRecord({
      id: `fp${pins.length}`,
      summary: "Board footprint",
      manufacturer: "",
      package: "",
      footprint: "",
      pins: Object.fromEntries(pins.map((p) => [p.number, { name: p.name, type: p.type }])),
      provenance: { extracted_by: "ai", verified_by: null },
      extras: [],
    });
  }
  const polarized = parseGenericSpec(fn, args)?.polarized === true;
  const name = polarized ? "cap_polarized" : fn;
  const vertical = (refPrefix: string, description: string, graphics: SExpr[][]) => {
    const pins = new Map<string, PinAnchor>([
      ["1", { x: 0, y: 3.81, outward: 90 }],
      ["2", { x: 0, y: -3.81, outward: 270 }],
    ]);
    const box = { minX: -1.27, maxX: 1.27, minY: -3.81, maxY: 3.81 };
    return {
      name,
      def: symbolDef(
        name,
        { refPrefix, value: name, description, showPinNames: false, showPinNumbers: false, box },
        graphics,
        [...pins].map(([n, a]) => pinExpr("passive", "", n, a, 1.27)),
      ),
      pins,
      box: { ...box, minX: -2.54, maxX: 2.54 },
      refPrefix,
    };
  };
  const diode = (refPrefix: string, description: string, extra: SExpr[][]) => {
    const pins = new Map<string, PinAnchor>([
      ["1", { x: -3.81, y: 0, outward: 180 }],
      ["2", { x: 3.81, y: 0, outward: 0 }],
    ]);
    const box = { minX: -3.81, maxX: 3.81, minY: -1.27, maxY: 1.27 };
    return {
      name: fn,
      def: symbolDef(
        fn,
        { refPrefix, value: fn, description, showPinNames: false, showPinNumbers: false, box },
        [
          polyline(
            [
              [1.27, 1.27],
              [1.27, -1.27],
              [-1.27, 0],
              [1.27, 1.27],
            ],
            "none",
          ),
          polyline([
            [-1.27, 1.27],
            [-1.27, -1.27],
          ]),
          ...extra,
        ],
        [
          pinExpr("passive", "K", "1", pins.get("1") as PinAnchor, 2.54),
          pinExpr("passive", "A", "2", pins.get("2") as PinAnchor, 2.54),
        ],
      ),
      pins,
      box: { ...box, minY: -2.54, maxY: 2.54 },
      refPrefix,
    };
  };

  switch (fn) {
    case "res":
      return vertical("R", "Resistor", [rect(-1.016, 2.54, 1.016, -2.54, "none")]);
    case "ind":
      return vertical("L", "Inductor", [rect(-1.016, 2.54, 1.016, -2.54, "background")]);
    case "cap":
      return vertical("C", "Capacitor", [
        polyline([
          [-2.032, 0.762],
          [2.032, 0.762],
        ]),
        polyline([
          [-2.032, -0.762],
          [2.032, -0.762],
        ]),
        polyline([
          [0, 2.54],
          [0, 0.762],
        ]),
        polyline([
          [0, -2.54],
          [0, -0.762],
        ]),
        ...(polarized
          ? [
              polyline([
                [-1.778, 1.524],
                [-0.762, 1.524],
              ]),
              polyline([
                [-1.27, 2.032],
                [-1.27, 1.016],
              ]),
            ]
          : []),
      ]);
    case "diode":
      return diode("D", "Diode", []);
    case "led":
      return diode("D", "Light emitting diode", [
        polyline([
          [0, 1.778],
          [1.016, 2.794],
        ]),
        polyline([
          [1.016, 1.778],
          [2.032, 2.794],
        ]),
      ]);
    default:
      return undefined;
  }
}
