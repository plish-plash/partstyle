import type { PortKind } from "../ckt/ast.js";

/** Schematic coordinates in mm, y down (KiCad's sheet convention). */
export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pin's connection point on the sheet. */
export interface PlacedPin {
  number: string;
  at: Pt;
  /** Direction pointing away from the symbol body, degrees (0 right, 90 up, 180 left, 270 down). */
  outward: number;
  /** Block-local net, if connected. */
  net?: string;
}

/** One unit of a part's symbol placed on a sheet. */
export interface PlacedUnit {
  /** Block-local refdes (`C1`); the sheet is shared by every instance of the block. */
  ref: string;
  /** Part path in the block's first instance, for looking up BOM and record data. */
  path: string;
  libId: string;
  unit: number;
  /** Symbol origin. */
  at: Pt;
  /** Counter-clockwise rotation (0, 90, 180, 270); only two-terminal parts are turned. */
  rotation: number;
  /** Mirrored left to right (KiCad's `mirror y`), before rotation; only unturned parts are. */
  mirror: boolean;
  /** Extent including pins, for selection and hit-testing. */
  box: Rect;
  pins: PlacedPin[];
  /** Reference and Value fields: from the KiCad symbol's own placement when it has one. */
  refField: PlacedText;
  valueField: PlacedText;
}

/** A text field: anchor, rotation (0 or 90) and KiCad justification (`left`, `bottom`, ...). */
export interface PlacedText {
  at: Pt;
  angle: number;
  justify: string[];
}

/** A `use` instance drawn as a hierarchical sheet. */
export interface PlacedSheet {
  instance: string;
  block: string;
  at: Pt;
  size: { w: number; h: number };
  /** Sheet pins; ports on power nets have none (power symbols connect globally). */
  pins: { port: string; kind: PortKind; at: Pt; outward: number; net?: string }[];
}

export interface PlacedLabel {
  kind: "local" | "hier";
  text: string;
  /** Block-local net. */
  net: string;
  at: Pt;
  /** Direction the text extends from the connection point. */
  angle: number;
  /** Hierarchical label shape (input, output, bidirectional, passive). */
  shape?: string;
}

/** A KiCad power symbol (or PWR_FLAG) whose drawing points `outward` from `at`. */
export interface PlacedPower {
  libId: string;
  /** Global net name (the symbol's Value); "PWR_FLAG" for flags. */
  name: string;
  net: string;
  at: Pt;
  outward: number;
  /** Rotation applied to the library symbol (degrees, counter-clockwise). */
  rotation: number;
  /** Where the name is drawn (centred). */
  valueAt: Pt;
  hideValue: boolean;
  flag: boolean;
}

/** An orthogonal wire segment. */
export interface WireSegment {
  net: string;
  a: Pt;
  b: Pt;
}

export interface SheetLayout {
  block: string;
  width: number;
  height: number;
  units: PlacedUnit[];
  sheets: PlacedSheet[];
  labels: PlacedLabel[];
  power: PlacedPower[];
  wires: WireSegment[];
  junctions: { net: string; at: Pt }[];
  noConnects: Pt[];
}
