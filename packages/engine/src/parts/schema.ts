import { z } from "zod";
import { parseQuantity } from "../units.js";
import { parseGenericText, passiveValue } from "./generic.js";

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

const pinOrNet = z.string().min(1);

/** A requirement with a check: its shape must be exact, since the engine acts on it. */
const CheckedRequirement = z
  .looseObject({
    text: z.string().min(1),
    cap: z
      .strictObject({
        from: pinOrNet,
        to: pinOrNet.optional(),
        min: quantity("F", "100n"),
        each: z.boolean().optional(),
      })
      .optional(),
    res: z
      .strictObject({
        from: pinOrNet,
        to: pinOrNet.optional(),
        min: quantity("Ω", "4.7k").optional(),
        max: quantity("Ω", "10k").optional(),
      })
      .optional(),
    tie: z.strictObject({ from: pinOrNet, to: pinOrNet }).optional(),
  })
  .refine(
    (r) => [r.cap, r.res, r.tie].filter((c) => c !== undefined).length <= 1,
    "a requirement has at most one check (cap, res or tie)",
  );

/** A datasheet requirement: text, plus optionally one check the engine verifies on every change. */
export type Requirement = string | z.infer<typeof CheckedRequirement>;

export const requirementText = (r: Requirement) => (typeof r === "string" ? r : r.text);

export interface PartPin {
  /** Pin name as printed in the datasheet, e.g. IN, PB3, ~RESET. */
  name: string;
  /** Electrical type, used by ERC. */
  type: PinType;
  /**
   * Absolute maximum voltage relative to ground, checked against the net's voltage. Text that is
   * not a voltage (`VCC + 0.3V`) is kept for reading but cannot be checked.
   */
  vmax?: string;
  /** What the datasheet says about leaving it unconnected. */
  unused?: "open" | "required";
  note?: string;
  /** Anything else the YAML says about the pin, for reading. */
  extra?: Record<string, unknown>;
}

/**
 * A part record as the engine uses it: one electrical part in one package, read from YAML that
 * caches its datasheet. The YAML may hold more than this: anything else is kept in the file for
 * reading, and only the names of those sections reach here (`extras`).
 */
export interface PartRecord {
  /** Library id and file name, referenced as lib:<id>. */
  id: string;
  /** One line: what it is, key ratings, package. */
  summary: string;
  /** Empty when not known. */
  manufacturer: string;
  package: string;
  /** KiCad footprint, Library:Footprint. */
  footprint: string;
  /** The orderable part to buy. */
  preferred_mpn?: string;
  /** KiCad library symbol for export; found by name when omitted. */
  kicad_symbol?: string;
  /** Keyed by pin/pad number. */
  pins: Record<string, PartPin>;
  ratings?: Record<string, unknown>;
  /** Operating temperature range in °C, checked against the project's environment. */
  temp_c?: [number, number];
  requirements?: Requirement[];
  notes?: string[];
  /**
   * For a concrete passive, LED or diode: the generic it satisfies. It is drawn and valued like
   * that generic, and offered as a candidate for generics it satisfies.
   */
  generic?: string;
  sourcing?: {
    lcsc?: string | null;
    digikey?: string | null;
    mouser?: string | null;
    lifecycle?: string;
    /** The person has this part already. */
    in_inventory?: boolean;
  };
  provenance: {
    datasheet?: { url?: string };
    /** kicad: a draft made by KiCad import from a symbol, still to be completed. */
    extracted_by: "ai" | "human" | "kicad";
    /** null until a person checks it against the datasheet. */
    verified_by: "human" | null;
  };
  /** Top-level sections of the YAML the engine does not read. */
  extras: string[];
}

/** What the engine cannot work without; everything else is read field by field. */
const RequiredFields = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9._+-]+$/, "id may contain only letters, digits and . _ + -"),
  summary: z.string().min(1),
  pins: z
    .record(
      z.string().regex(/^[A-Za-z0-9]+$/, "pin numbers are alphanumeric"),
      z.looseObject({
        name: z.union([z.string().min(1), z.number()]),
        type: z.enum(pinTypes).default("passive"),
      }),
    )
    .refine((pins) => Object.keys(pins).length > 0, "a part needs at least one pin"),
});

/** The top-level keys the engine reads; any other is a free-form section. */
const knownKeys: ReadonlySet<string> = new Set([
  "id",
  "summary",
  "manufacturer",
  "package",
  "footprint",
  "preferred_mpn",
  "kicad_symbol",
  "pins",
  "ratings",
  "temp_c",
  "requirements",
  "notes",
  "generic",
  "sourcing",
  "provenance",
]);

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Scalars the YAML may give as numbers: `package: 0603`, `lcsc: 12345`. */
const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

export interface RecordReading {
  /** Absent when the record lacks something the engine needs: see `problems`. */
  record?: PartRecord;
  problems: string[];
  /** Fields that look like a mistake and were left out of what the engine uses. */
  warnings: string[];
  /** Fine as they stand, but worth saying once, when the record is written. */
  notes: string[];
}

/**
 * Reads a record's YAML data. Records cache a datasheet, so this refuses only what the engine
 * cannot work without. A field it cannot use stays in the file and is reported, never rejected.
 */
export function readPartRecord(data: unknown): RecordReading {
  const required = RequiredFields.safeParse(data);
  if (!required.success) {
    return {
      problems: required.error.issues.map(
        (i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`,
      ),
      warnings: [],
      notes: [],
    };
  }
  const raw = required.data as Record<string, unknown>;
  const warnings: string[] = [];
  const notes: string[] = [];

  const pins: Record<string, PartPin> = {};
  for (const [number, p] of Object.entries(required.data.pins)) {
    const pin: PartPin = { name: String(p.name), type: p.type };
    const vmax = typeof p.vmax === "number" ? `${p.vmax}V` : text(p.vmax);
    if (vmax !== undefined) {
      const q = parseQuantity(vmax);
      if (q === undefined) {
        pin.vmax = vmax;
        notes.push(`pins.${number}.vmax '${vmax}' is kept but not checked: not a voltage`);
      } else if (q.unit === "V" || q.unit === "") {
        pin.vmax = vmax;
      } else {
        warnings.push(`pins.${number}.vmax '${vmax}' is not a voltage, e.g. 6V`);
      }
    }
    if (p.unused === "open" || p.unused === "required") {
      pin.unused = p.unused;
    } else if (p.unused !== undefined) {
      warnings.push(`pins.${number}.unused must be open or required`);
    }
    const note = text(p.note);
    if (note !== undefined) pin.note = note;
    const known = ["name", "type", "vmax", "unused", "note"];
    const extra = Object.entries(p).filter(([k]) => !known.includes(k));
    if (extra.length > 0) pin.extra = Object.fromEntries(extra);
    pins[number] = pin;
  }

  const record: PartRecord = {
    id: required.data.id,
    summary: required.data.summary,
    manufacturer: text(raw.manufacturer) ?? "",
    package: text(raw.package) ?? "",
    footprint: text(raw.footprint) ?? "",
    pins,
    provenance: readProvenance(raw.provenance),
    extras: Object.keys(raw).filter((k) => !knownKeys.has(k)),
  };

  const mpn = text(raw.preferred_mpn);
  if (mpn) record.preferred_mpn = mpn;
  const symbol = text(raw.kicad_symbol);
  if (symbol) record.kicad_symbol = symbol;
  if (isMapping(raw.ratings)) record.ratings = raw.ratings;

  if (raw.temp_c !== undefined) {
    const t = z.tuple([z.number(), z.number()]).safeParse(raw.temp_c);
    if (t.success) record.temp_c = t.data;
    else warnings.push("temp_c must be [min, max] in °C; the temperature check is skipped");
  }

  if (raw.generic !== undefined) {
    const generic = text(raw.generic);
    if (generic !== undefined && parseGenericText(generic) !== undefined) {
      record.generic = generic;
    } else {
      warnings.push("generic must be a spec such as cap(100n, 50V, X7R, 10%, 0603); it is ignored");
    }
  }

  if (raw.requirements !== undefined) {
    const list = Array.isArray(raw.requirements) ? raw.requirements : [raw.requirements];
    record.requirements = list.flatMap((r: unknown, i): Requirement[] => {
      if (typeof r === "string") return [r];
      const checked = CheckedRequirement.safeParse(r);
      if (checked.success) return [checked.data];
      const first = checked.error.issues[0];
      const why = first ? `${first.path.join(".")} ${first.message}`.trim() : "invalid";
      const wording = isMapping(r) ? text(r.text) : undefined;
      warnings.push(
        `requirements.${i}: ${why}; ${wording === undefined ? "ignored" : "kept as text, unchecked"}`,
      );
      return wording === undefined ? [] : [wording];
    });
  }

  if (raw.notes !== undefined) {
    const list = Array.isArray(raw.notes) ? raw.notes : [raw.notes];
    record.notes = list.map((n: unknown) => text(n) ?? JSON.stringify(n));
  }

  if (isMapping(raw.sourcing)) {
    const s = raw.sourcing;
    const code = (v: unknown) => (v === null ? null : text(v));
    const lcsc = code(s.lcsc);
    const digikey = code(s.digikey);
    const mouser = code(s.mouser);
    const lifecycle = text(s.lifecycle);
    const inInventory = typeof s.in_inventory === "boolean" ? s.in_inventory : undefined;
    if (s.in_inventory !== undefined && inInventory === undefined) {
      warnings.push("sourcing.in_inventory must be true or false; it is ignored");
    }
    record.sourcing = {
      ...(lcsc !== undefined && { lcsc }),
      ...(digikey !== undefined && { digikey }),
      ...(mouser !== undefined && { mouser }),
      ...(lifecycle !== undefined && { lifecycle }),
      ...(inInventory !== undefined && { in_inventory: inInventory }),
    };
  }
  return { record, problems: [], warnings, notes };
}

function readProvenance(raw: unknown): PartRecord["provenance"] {
  const p = isMapping(raw) ? raw : {};
  const by = p.extracted_by === "human" || p.extracted_by === "kicad" ? p.extracted_by : "ai";
  const sheet = typeof p.datasheet === "string" ? p.datasheet : undefined;
  const url = sheet ?? (isMapping(p.datasheet) ? text(p.datasheet.url) : undefined);
  return {
    extracted_by: by,
    verified_by: p.verified_by === "human" ? "human" : null,
    ...(url !== undefined && { datasheet: { url } }),
  };
}

/** A record KiCad import drafted from a symbol: pins and footprint only, no datasheet facts. */
export const isDraft = (r: PartRecord) => r.provenance.extracted_by === "kicad";

/** What to call the part on a schematic or a BOM. */
export const partName = (r: PartRecord) => r.preferred_mpn ?? r.id;

/** A part's Value: `100n` for a concrete passive, as its generic shows, else its name. */
export const partValue = (r: PartRecord) =>
  (r.generic === undefined ? undefined : passiveValue(r.generic)) ?? partName(r);
