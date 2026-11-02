import type { Location } from "../diagnostics.js";

export const portKinds = [
  "power_in",
  "power_out",
  "ground",
  "input",
  "output",
  "bidir",
  "passive",
] as const;
export type PortKind = (typeof portKinds)[number];

export interface BlockDecl {
  name: string;
  description?: string;
  location: Location;
}

export interface PortDecl {
  name: string;
  kind: PortKind;
  location: Location;
}

export type PartSpec =
  | { kind: "lib"; id: string }
  | { kind: "generic"; fn: string; args: string[] };

/**
 * How a part or sheet is drawn (`[2 r90 flip]`): the human's layout, kept by the AI. Omitted
 * items are chosen automatically.
 */
export interface LayoutHint {
  /** Position in the signal chain: groups are drawn left to right by stage. */
  stage?: number;
  /** Counter-clockwise rotation of a two-terminal part. */
  rotation?: 0 | 90 | 180 | 270;
  /** Mirrored left to right (`flip`), or kept as the library draws it (`noflip`). */
  flip?: boolean;
}

export interface PartDecl {
  ref: string;
  spec: PartSpec;
  layout?: LayoutHint;
  intent?: string;
  location: Location;
}

/** `REF.PIN` for a part pin, or `INST.PORT` for a port of a `use` instance. */
export interface PinRef {
  target: string;
  pin: string;
  location: Location;
}

export interface NetDecl {
  name: string;
  pins: PinRef[];
  /** Port this net is exported as (`-> port NAME`). */
  port?: string;
  attrs: Record<string, string>;
  intent?: string;
  location: Location;
}

export interface UseDecl {
  block: string;
  instance: string;
  layout?: LayoutHint;
  intent?: string;
  location: Location;
}

export interface WaiverDecl {
  /** Refdes, pinref or net name; `*` matches any run of characters. */
  subject: string;
  code?: string;
  reason: string;
  location: Location;
}

export interface CktFile {
  file: string;
  block: BlockDecl;
  ports: PortDecl[];
  parts: PartDecl[];
  nets: NetDecl[];
  uses: UseDecl[];
  waivers: WaiverDecl[];
}

/** One parsed .ckt line. */
export type Statement =
  | { kind: "block"; decl: BlockDecl }
  | { kind: "port"; decl: PortDecl }
  | { kind: "part"; decl: PartDecl }
  | { kind: "net"; decl: NetDecl }
  | { kind: "use"; decl: UseDecl }
  | { kind: "waive"; decl: WaiverDecl };

export type StatementKind = Statement["kind"];
