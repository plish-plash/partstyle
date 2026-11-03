import { z } from "zod";
import { parseQuantity } from "../units.js";
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

const quantity = (unit: string, example: string) =>
  z.string().refine((v) => {
    const q = parseQuantity(v);
    return q !== undefined && (q.unit === unit || q.unit === "");
  }, `must be a quantity in ${unit}, e.g. ${example}`);

export const PinSchema = z.strictObject({
  name: z.string().min(1).describe("Pin name as printed in the datasheet, e.g. IN, PB3, ~RESET"),
  type: z.enum(pinTypes).describe("Electrical type, used by ERC"),
  vmax: quantity("V", "6V")
    .optional()
    .describe(
      "Absolute maximum voltage on this pin relative to ground; checked against the net's voltage",
    ),
  note: z.string().optional(),
});

const pinOrNet = z
  .string()
  .min(1)
  .describe("A pin name or number of this part, or a net name; omitted means ground");

/**
 * A datasheet requirement: text for people and design review, plus optionally one check the
 * engine verifies on every change.
 */
export const RequirementSchema = z.union([
  z.string(),
  z
    .strictObject({
      text: z.string().min(1),
      cap: z
        .strictObject({
          from: pinOrNet,
          to: pinOrNet.optional(),
          min: quantity("F", "100n"),
          each: z.boolean().optional().describe("One capacitor per pin with this name"),
        })
        .optional()
        .describe("A capacitor of at least min between the pin and ground (or `to`)"),
      res: z
        .strictObject({
          from: pinOrNet,
          to: pinOrNet.optional(),
          min: quantity("Ω", "4.7k").optional(),
          max: quantity("Ω", "10k").optional(),
        })
        .optional()
        .describe("A resistor between the pin and ground (or `to`), within min..max"),
      tie: z
        .strictObject({ from: pinOrNet, to: pinOrNet })
        .optional()
        .describe("The pin must be on the same net as `to` (a pin or net, e.g. VIN or GND)"),
    })
    .refine(
      (r) => [r.cap, r.res, r.tie].filter((c) => c !== undefined).length <= 1,
      "a requirement has at most one check (cap, res or tie)",
    ),
]);

export type Requirement = z.infer<typeof RequirementSchema>;

export const requirementText = (r: Requirement) => (typeof r === "string" ? r : r.text);

export const PartRecordSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9._+-]+$/, "id may contain only letters, digits and . _ + -")
      .describe("Library id and file name, referenced as lib:<id>; the MPN with / replaced by _"),
    manufacturer: z.string(),
    mpn: z.string(),
    summary: z.string().min(1).describe("One line: what it is, key ratings, package"),
    package: z.string(),
    footprint: z.string().describe("KiCad footprint, Library:Footprint"),
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
    temp_c: z
      .tuple([z.number(), z.number()])
      .optional()
      .describe("Operating temperature range in °C, checked against the project's environment"),
    requirements: z
      .array(RequirementSchema)
      .optional()
      .describe(
        "External components and conditions the datasheet requires: text, or {text, cap|res|tie} to have it checked",
      ),
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
      extracted_by: z
        .enum(["ai", "human", "kicad"])
        .describe("kicad: a draft made by KiCad import from a symbol, still to be completed"),
      verified_by: z
        .enum(["human"])
        .nullable()
        .describe("null until checked against the datasheet"),
    }),
  })
  .superRefine((r, ctx) => {
    // Only an import draft may leave identity fields empty; completing it means filling them.
    if (r.provenance.extracted_by === "kicad") return;
    for (const key of ["manufacturer", "mpn", "package", "footprint"] as const) {
      if (r[key] === "") {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "must not be empty (only a KiCad import draft may leave it empty)",
        });
      }
    }
  })
  .describe("A real part: identity, pinout and distilled datasheet facts");

/** A record KiCad import drafted from a symbol: pins and footprint only, no datasheet facts. */
export const isDraft = (r: PartRecord) => r.provenance.extracted_by === "kicad";

export type PartRecord = z.infer<typeof PartRecordSchema>;

export function partRecordJsonSchema(): unknown {
  return z.toJSONSchema(PartRecordSchema);
}
