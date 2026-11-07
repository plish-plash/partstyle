/**
 * All coordinates are integer grid units with y pointing down. One unit is the 2.54 mm pin grid,
 * so a Partstyle adapter scales by 2.54.
 */
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

/** Direction a pin points away from its part: 0 right, 90 up, 180 left, 270 down. */
export type Direction = 0 | 90 | 180 | 270;
/** Counter-clockwise, as seen on the sheet. */
export type Rotation = 0 | 90 | 180 | 270;

export type PinType =
  | "input"
  | "output"
  | "bidir"
  | "tristate"
  | "passive"
  | "power_in"
  | "power_out"
  | "open_collector"
  | "open_emitter"
  | "nc";

export type PartKind =
  | "resistor"
  | "capacitor"
  | "inductor"
  | "ferrite"
  | "diode"
  | "led"
  | "crystal"
  | "transistor"
  | "opamp"
  | "connector"
  | "ic"
  /** A child sheet on its parent. Inputs sit on the left, outputs on the right. */
  | "sheet";

export type NetRole = "signal" | "power" | "ground";

export interface LayoutPin {
  id: string;
  name: string;
  /** Connection point relative to the part origin, before rotation. */
  x: number;
  y: number;
  outward: Direction;
  type: PinType;
  net?: string;
}

export interface LayoutPart {
  /** Unique within the block: one symbol unit of a multi-unit part is one layout part. */
  id: string;
  ref: string;
  value?: string;
  kind: PartKind;
  /** Declaration order, which breaks every tie. */
  order: number;
  /** Extent relative to the origin, pins included. */
  box: Rect;
  pins: LayoutPin[];
}

export interface LayoutNet {
  name: string;
  role: NetRole;
  /** Set when the net leaves the block; a signal port is drawn as a port label. */
  port?: "input" | "output" | "bidir";
  /** A rail whose symbols hang down, such as one below ground. */
  pointsDown?: boolean;
  /** Asks for a marker: a free spot on the net, in `LayoutResult.markers`. */
  flagged?: boolean;
}

export interface LayoutInput {
  name: string;
  parts: LayoutPart[];
  nets: LayoutNet[];
}

export interface PlacedPin {
  id: string;
  name: string;
  at: Pt;
  outward: Direction;
  type: PinType;
  net?: string;
}

export interface TextField {
  text: string;
  at: Pt;
  anchor: "start" | "middle" | "end";
}

/** What the engine decided a part is. */
export type PartRole =
  | "anchor"
  | "series"
  | "shunt"
  | "chain"
  | "decoupling"
  | "feedback"
  | "bridge"
  | "free";

export interface PlacedPart {
  id: string;
  ref: string;
  value?: string;
  kind: PartKind;
  at: Pt;
  rotation: Rotation;
  mirror: boolean;
  /** Extent on the sheet, pins included. */
  box: Rect;
  pins: PlacedPin[];
  text: TextField[];
  role: PartRole;
  /** Column along the signal flow, for overlays. */
  column: number;
}

export interface Wire {
  net: string;
  a: Pt;
  b: Pt;
}

export interface PowerSymbol {
  net: string;
  name: string;
  role: "power" | "ground";
  at: Pt;
  outward: 90 | 270;
  /** Extent of the drawn symbol. */
  box: Rect;
  showName: boolean;
}

export interface NetLabel {
  net: string;
  text: string;
  kind: "local" | "port";
  at: Pt;
  /** Which way the text runs from `at`. */
  outward: Direction;
  box: Rect;
}

/** A free spot on a net for something extra to attach, drawn pointing `outward` from `at`. */
export interface Marker {
  net: string;
  at: Pt;
  outward: Direction;
  box: Rect;
}

export interface Junction {
  net: string;
  at: Pt;
}

export interface TraceEntry {
  rule: string;
  note: string;
}

export interface LayoutResult {
  name: string;
  parts: PlacedPart[];
  wires: Wire[];
  junctions: Junction[];
  power: PowerSymbol[];
  labels: NetLabel[];
  noConnects: Pt[];
  markers: Marker[];
  /** Extent of everything drawn. */
  bounds: Rect;
  /** Rules that decided where each part went, by part id. */
  trace: Record<string, TraceEntry[]>;
  /** Connections the router could not make. Always a layout failure. */
  unrouted: { net: string; at: Pt }[];
}
