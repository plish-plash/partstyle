import { z } from "zod";
import { parseGenericText } from "./generic.js";

export const pinTypes = [
  "input",
  "output",
  "bidir",
  "tristate",
  "passive",
  "power_in",
  "power_out",
  "open_collector",
  "open_emitter",
  "nc",
] as const;
export type PinType = (typeof pinTypes)[number];

export const PinSchema = z.strictObject({
  name: z.string().min(1).describe("Pin name as printed in the datasheet, e.g. IN, PB3, ~RESET"),
  type: z.enum(pinTypes).describe("Electrical type, used by ERC"),
  note: z.string().optional(),
});

export const PartRecordSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9._+-]+$/, "id may contain only letters, digits and . _ + -")
      .describe("Library id and file name, referenced as lib:<id>; the MPN with / replaced by _"),
    manufacturer: z.string().min(1),
    mpn: z.string().min(1),
    summary: z.string().min(1).describe("One line: what it is, key ratings, package"),
    package: z.string().min(1),
    footprint: z.string().min(1).describe("KiCad footprint, Library:Footprint"),
    kicad_symbol: z
      .string()
      .regex(/^[^:\s]+:[^:\s]+$/, "must be Library:Symbol")
      .optional()
      .describe(
        "KiCad library symbol for export, e.g. Connector_Generic:Conn_01x03; found by MPN when omitted; pin numbers must match",
      ),
    pins: z
      .record(z.string().regex(/^[A-Za-z0-9]+$/, "pin numbers are alphanumeric"), PinSchema)
      .refine((pins) => Object.keys(pins).length > 0, "a part needs at least one pin")
      .describe("Keyed by pin/pad number"),
    ratings: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe("Absolute maximum and key ratings, e.g. vin_max: 35V"),
    requirements: z
      .array(z.string())
      .optional()
      .describe("External components and conditions the datasheet requires"),
    notes: z.array(z.string()).optional().describe("Gotchas and application notes"),
    generic: z
      .string()
      .refine(
        (t) => parseGenericText(t) !== undefined,
        "must be a generic spec such as cap(100n, 50V, X7R, 10%, 0603)",
      )
      .optional()
      .describe(
        "For a concrete passive: the generic it satisfies, so cap()/res()/... can resolve to it at BOM time",
      ),
    sourcing: z
      .strictObject({
        lcsc: z.string().nullable().optional(),
        digikey: z.string().nullable().optional(),
        mouser: z.string().nullable().optional(),
        lifecycle: z.enum(["active", "nrnd", "obsolete", "unknown"]).optional(),
      })
      .optional(),
    provenance: z.strictObject({
      datasheet: z
        .strictObject({
          url: z.string(),
          sha256: z.string().nullable().optional(),
        })
        .optional(),
      extracted_by: z.enum(["ai", "human"]),
      verified_by: z
        .enum(["human"])
        .nullable()
        .describe("null until checked against the datasheet"),
    }),
  })
  .describe("A real part: identity, pinout and distilled datasheet facts");

export type PartRecord = z.infer<typeof PartRecordSchema>;

export function partRecordJsonSchema(): unknown {
  return z.toJSONSchema(PartRecordSchema);
}
