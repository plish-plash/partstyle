import type { CktFile, PartSpec, PortKind } from "../ckt/ast.js";
import { printPinRef, printSpec, printStatement } from "../ckt/print.js";
import { globToRegExp } from "../diagnostics.js";
import { isOpenByDesign } from "../netlist/elaborate.js";
import {
  checkGenericArgs,
  type GenericPin,
  genericFootprint,
  generics,
  parseGenericSpec,
  parseGenericText,
} from "../parts/generic.js";
import type { PartLibrary } from "../parts/library.js";
import { isDraft, type PartRecord, type PinType } from "../parts/schema.js";
import { parseQuantity } from "../units.js";
import { type Annotation, formatAnnotationLock } from "./annotate.js";
import type { ParsedNetlist } from "./netlist.js";
import { child, children, readSExpr, type SExpr, value, writeSExpr } from "./sexpr.js";

// --- KiCad's netlist (kicadsexpr), as import needs it -------------------------------------

export interface KicadComp {
  ref: string;
  value: string;
  footprint: string;
  /** User fields (MPN, Manufacturer, LCSC, Spec, ...) by name. */
  fields: Record<string, string>;
  lib: string;
  part: string;
  /** Sheet the symbol is on, as UUIDs relative to the exported root: "/" or "/<uuid>/". */
  sheet: string;
  /** The symbol's UUIDs (one per unit); the same in every instance of a reused sheet. */
  uuid: string;
}

export interface KicadPin {
  num: string;
  name: string;
  type: string;
}

export interface KicadSheet {
  /** "/" or "/amp_left/". */
  names: string;
  tstamps: string;
  file: string;
  title: string;
}

export interface KicadNetlist {
  sheets: KicadSheet[];
  comps: KicadComp[];
  /** Pin tables by `lib:part`. */
  libparts: Map<string, KicadPin[]>;
  nets: { name: string; nodes: { ref: string; pin: string }[] }[];
}

const text = (x: SExpr | undefined): string =>
  x === undefined || Array.isArray(x) ? "" : typeof x === "object" ? x.sym : String(x);

/** Reads what import needs from `kicad-cli sch export netlist --format kicadsexpr`. */
export function parseNetlistForImport(source: string): KicadNetlist {
  const doc = readSExpr(source);
  const sheets = children(child(doc, "design") ?? [], "sheet").map((s) => {
    const tb = child(s, "title_block") ?? [];
    return {
      names: value(s, "name") ?? "/",
      tstamps: value(s, "tstamps") ?? "/",
      file: value(tb, "source") ?? "",
      title: value(tb, "title") ?? "",
    };
  });
  const comps = children(child(doc, "components") ?? [], "comp").map((c) => {
    const fields: Record<string, string> = {};
    for (const f of children(child(c, "fields") ?? [], "field")) {
      const name = value(f, "name");
      if (name) fields[name] = text(f[2]);
    }
    const lib = child(c, "libsource") ?? [];
    const sheetpath = child(c, "sheetpath") ?? [];
    return {
      ref: value(c, "ref") ?? "",
      value: value(c, "value") ?? "",
      footprint: value(c, "footprint") ?? "",
      fields,
      lib: value(lib, "lib") ?? "",
      part: value(lib, "part") ?? "",
      sheet: value(sheetpath, "tstamps") ?? "/",
      uuid: (child(c, "tstamps") ?? []).slice(1).map(text).sort().join(" "),
    };
  });
  const libparts = new Map<string, KicadPin[]>();
  for (const lp of children(child(doc, "libparts") ?? [], "libpart")) {
    const pins = new Map<string, KicadPin>();
    for (const p of children(child(lp, "pins") ?? [], "pin")) {
      const num = value(p, "num") ?? "";
      if (!pins.has(num))
        pins.set(num, { num, name: value(p, "name") ?? "", type: value(p, "type") ?? "" });
    }
    libparts.set(`${value(lp, "lib")}:${value(lp, "part")}`, [...pins.values()]);
  }
  const nets = children(child(doc, "nets") ?? [], "net").map((n) => ({
    name: value(n, "name") ?? "",
    nodes: children(n, "node").map((node) => ({
      ref: value(node, "ref") ?? "",
      pin: value(node, "pin") ?? "",
    })),
  }));
  return { sheets, comps, libparts, nets };
}

// --- Mapping ------------------------------------------------------------------------------

export interface ImportInput {
  /** KiCad project name. */
  project: string;
  /** The root sheet file, as named in the netlists. */
  rootFile: string;
  /** Each sheet file exported on its own (the root's export is the whole design). */
  sheets: Map<string, KicadNetlist>;
  library: PartLibrary;
  /** Whether a `Lib:Name` symbol is in KiCad's stock libraries (drafts then reference it). */
  stockSymbol?: (libId: string) => boolean;
  /** `REF.PIN` that KiCad's ERC reports unconnected; other unconnected pins have no-connect flags. Undefined without ERC. */
  unconnected?: Set<string>;
  /** Text notes by sheet file. */
  notes?: Map<string, string[]>;
  /** Pad numbers of footprints, where known: drafts list pads the symbol lacks as `nc` pins. */
  pads?: Map<string, Set<string>>;
  /** The project as it was, on a re-import: its edits to keep. */
  previous?: { blocks: CktFile[]; annotation: Annotation };
  /** Shown in the notes file. */
  source?: string;
  date?: string;
}

export interface ImportedDraft {
  id: string;
  text: string;
  users: string[];
  from: string;
}

export interface ImportResult {
  /** circuit/<block>.ckt texts. */
  circuits: { file: string; text: string }[];
  drafts: ImportedDraft[];
  annotation: Annotation;
  annotationLock: string;
  /** notes/kicad-import.md */
  notes: string;
  /** Report lines for the person and the AI. */
  report: string[];
  /** KiCad's connectivity minus what import leaves out, to check the imported design against. */
  expected: ParsedNetlist;
  blocks: string[];
}

export const NC_INTENT = "no-connect flag in KiCad";
export const FLAG_SOURCE = "KiCad PWR_FLAG";

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** A .ckt name: KiCad allows characters the grammar reserves. */
export function cktName(s: string): string {
  const out = s.replace(/[\s:{}(),"@#./\\]/g, "_").replace(/^->/, "_>");
  return out === "" ? "_" : out;
}

const idOf = (s: string) => s.replace(/[^A-Za-z0-9._+-]/g, "_").replace(/^[._]+/, "") || "part";

/** `~{RESET}` (KiCad overbar markup) to `~RESET`, the library convention. */
const pinName = (name: string, num: string) => {
  const n = name.replace(/~\{([^}]*)\}/g, "~$1").replace(/\{slash\}/g, "/");
  return n === "" || n === "~" ? num : n;
};

const kicadTypes: Record<string, PinType> = {
  input: "input",
  output: "output",
  bidirectional: "bidir",
  tri_state: "tristate",
  passive: "passive",
  free: "passive",
  unspecified: "passive",
  power_in: "power_in",
  power_out: "power_out",
  open_collector: "open_collector",
  open_emitter: "open_emitter",
  no_connect: "nc",
};

const isFlag = (c: KicadComp) => c.part === "PWR_FLAG";

const fieldNames = {
  mpn: new Set([
    "mpn",
    "manufacturerpartnumber",
    "mfrpartnumber",
    "mfrpn",
    "mfgpartnumber",
    "mfgpn",
    "partnumber",
    "mfrno",
  ]),
  manufacturer: new Set(["manufacturer", "mfr", "mfg", "manufacturername"]),
  lcsc: new Set(["lcsc", "lcscpart", "lcscpartnumber", "lcscpn", "jlcpcbpart", "jlcpart"]),
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function field(c: KicadComp, kind: keyof typeof fieldNames): string {
  for (const [k, v] of Object.entries(c.fields)) {
    if (fieldNames[kind].has(norm(k)) && v.trim() !== "" && v.trim() !== "~") return v.trim();
  }
  return "";
}

interface PinDef {
  number: string;
  name: string;
  type: PinType;
  unused?: "open" | "required";
}

type How = "spec" | "mpn" | "lcsc" | "value" | "generic" | "draft";

interface Resolution {
  spec: PartSpec;
  pins: PinDef[];
  how: How;
  /** Why it is a draft, or what was dropped. */
  note?: string;
  draftKey?: string;
}

const recordPins = (r: PartRecord): PinDef[] =>
  Object.entries(r.pins).map(([number, p]) => ({
    number,
    name: p.name,
    type: p.type,
    ...(p.unused !== undefined && { unused: p.unused }),
  }));

/** A record fits when it has every pin number KiCad's symbol has. */
function fits(r: PartRecord, pins: KicadPin[]): boolean {
  return pins.every((p) => r.pins[p.num] !== undefined);
}

const families: [RegExp, string][] = [
  [/^R(_Small)?(_US)?$/, "res"],
  [/^C(_Small)?(_US)?$/, "cap"],
  [/^L(_Small)?$/, "ind"],
  [/^LED(_Small)?$/, "led"],
];
const colors = /^(red|green|blue|yellow|white|orange|amber|pink|purple|uv|ir)$/i;

/** `res(10k, 1%, 0603)` from a Device:R with value "10k 1%" on an 0603 footprint, if exact. */
function passiveGeneric(
  c: KicadComp,
  pins: KicadPin[],
): { args: string[]; dropped: string[] } | { why: string } | undefined {
  const fn = families.find(([re]) => re.test(c.part))?.[1];
  if (!fn || pins.length !== 2 || !pins.some((p) => p.num === "1")) return undefined;
  const def = generics[fn] as (typeof generics)[string];
  // "4,7K" is a decimal comma, not two arguments.
  const tokens = c.value
    .replace(/(\d),(\d)/g, "$1.$2")
    .split(/[\s/,]+/)
    .filter(Boolean);
  for (const k of ["tolerance", "voltage", "power", "dielectric"]) {
    const v = Object.entries(c.fields).find(([name]) => norm(name) === k)?.[1];
    if (v) tokens.push(v.trim());
  }
  let [first, ...rest] = tokens;
  if (first === undefined) return { why: "no value" };
  if (def.valueUnit === undefined) {
    if (!colors.test(first)) return { why: `value '${c.value}' is not an LED colour` };
    first = first.toLowerCase();
  } else {
    first = first.replace(/ohms?$/i, "Ω");
    const q = parseQuantity(first);
    if (!q || (q.unit !== "" && q.unit !== def.valueUnit)) {
      return { why: `value '${c.value}' is not a ${fn} value` };
    }
    if (q.unit !== "") first = first.slice(0, -q.unit.length);
  }
  const args = [first];
  const dropped: string[] = [];
  for (const t of rest) {
    const spec = parseGenericSpec(fn, [...args, t]);
    if (spec && spec.other.length === 0) args.push(t);
    else dropped.push(t);
  }
  if (c.footprint !== "") {
    const size = /_(\d{4})_\d{4}Metric$/.exec(c.footprint)?.[1];
    const spec = size ? parseGenericSpec(fn, [...args, size]) : undefined;
    if (!spec || genericFootprint(spec) !== c.footprint) {
      return { why: `footprint ${c.footprint} is not a standard chip footprint` };
    }
    args.push(size as string);
  }
  if (checkGenericArgs(fn, args) !== undefined) return { why: `value '${c.value}'` };
  return { args, dropped };
}

/**
 * How a KiCad symbol enters the design: partstyle's own Spec field (a design exported from
 * here), then the MPN or LCSC field against the library, then a generic for plain passives,
 * then the value as an MPN; anything else becomes a draft record.
 */
function resolve(c: KicadComp, kpins: KicadPin[], byMpn: Map<string, PartRecord>): Resolution {
  const lib = (r: PartRecord, how: How): Resolution => ({
    spec: { kind: "lib", id: r.id },
    pins: recordPins(r),
    how,
    ...(c.footprint !== "" &&
      c.footprint !== r.footprint && {
        note: `footprint ${c.footprint} in KiCad differs from lib:${r.id}'s ${r.footprint}; kept the record's`,
      }),
  });
  const notes: string[] = [];
  const mpn = field(c, "mpn");

  // A design exported from here names its spec; a Value, MPN or footprint changed in KiCad
  // since then wins over it.
  const spec = c.fields.Spec?.trim() ?? "";
  if (spec.startsWith("lib:")) {
    const r = byMpn.get(`id:${spec.slice(4)}`);
    const sameMpn = !mpn || !r?.preferred_mpn || norm(mpn) === norm(r.preferred_mpn);
    if (r && fits(r, kpins) && sameMpn) return lib(r, "spec");
  } else if (spec !== "") {
    const g = /^([a-z]+)\((.*)\)$/.exec(spec);
    const fn = g?.[1] ?? "";
    const args = (g?.[2] ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const def = generics[fn];
    const parsed = parseGenericText(spec);
    if (def && parsed && checkGenericArgs(fn, args) === undefined) {
      if (c.value !== "" && c.value !== args[0]) {
        const edited = passiveGeneric({ ...c, footprint: "" }, kpins);
        if (edited && "args" in edited) args[0] = edited.args[0] as string;
      }
      if (c.footprint === "" || genericFootprint(parsed) === c.footprint) {
        return { spec: { kind: "generic", fn, args }, pins: def.pins, how: "spec" };
      }
    }
  }

  if (mpn) {
    const r = byMpn.get(norm(mpn));
    if (r && fits(r, kpins)) return lib(r, "mpn");
    notes.push(
      r ? `MPN ${mpn} is lib:${r.id}, whose pins differ` : `MPN ${mpn} is not in the library`,
    );
  }
  const lcsc = field(c, "lcsc");
  if (lcsc) {
    const r = byMpn.get(`lcsc:${norm(lcsc)}`);
    if (r && fits(r, kpins)) return lib(r, "lcsc");
  }
  const passive = passiveGeneric(c, kpins);
  if (passive && "args" in passive) {
    const fn = families.find(([re]) => re.test(c.part))?.[1] as string;
    if (passive.dropped.length > 0) notes.push(`dropped '${passive.dropped.join(" ")}'`);
    return {
      spec: { kind: "generic", fn, args: passive.args },
      pins: (generics[fn] as { pins: GenericPin[] }).pins,
      how: "generic",
      ...(notes.length > 0 && { note: notes.join("; ") }),
    };
  }
  if (passive) notes.push(passive.why);
  if (!mpn && c.value.length >= 3) {
    const r = byMpn.get(norm(c.value));
    if (r && fits(r, kpins)) return lib(r, "value");
  }

  const pins = kpins.map((p) => ({
    number: p.num,
    name: pinName(p.name, p.num),
    type: kicadTypes[p.type] ?? "passive",
  }));
  return {
    spec: { kind: "lib", id: "" }, // assigned with the other drafts
    pins,
    how: "draft",
    draftKey: [`${c.lib}:${c.part}`, c.value, c.footprint, mpn].join("\u0000"),
    ...(notes.length > 0 && { note: notes.join("; ") }),
  };
}

const safeToken = /^[A-Za-z~_][^\s:{}(),"@#]*$/;

interface LocalPart {
  uuid: string;
  comp: KicadComp;
  ref: string;
  res: Resolution;
  /** The token each pin number is written with in nets: its name when that is unambiguous. */
  token: Map<string, string>;
}

interface LocalNet {
  kicadName: string;
  name: string;
  /** Port name, for nets a parent connects to: the sheet's label, which may differ from `name`. */
  port?: string;
  auto: boolean;
  pins: { part: LocalPart; num: string }[];
  /** Child instance segment and the child file's net index. */
  childRefs: { seg: string; net: number }[];
  flag: boolean;
  /** Pin types anywhere below, for port kinds. */
  types: Set<PinType>;
}

interface FileModel {
  file: string;
  block: string;
  data: KicadNetlist;
  parts: LocalPart[];
  nets: LocalNet[];
  /** `sheet|uuid|pin` → net index. */
  nodeNet: Map<string, number>;
  /** Child sheet segment → its file and instance name. */
  childSheets: Map<string, { file: string; inst: string }>;
  /** Net indices exported as ports, with their names. */
  ports: Set<number>;
}

const seg1 = (sheet: string) => sheet.split("/")[1] ?? "";
const segs = (tstamps: string) => tstamps.split("/").filter(Boolean);

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

const groundName = /gnd|^vss|^0v$|^earth/i;
const railName = /^[+-]|^v(cc|dd|ee|ss|bat|in|sys|bus|ref)/i;

function inferKind(name: string, types: Set<PinType>): PortKind {
  if (groundName.test(name)) return "ground";
  if (types.has("power_out")) return "power_out";
  if (types.has("power_in") || railName.test(name)) return "power_in";
  const out = ["output", "tristate", "open_collector", "open_emitter"].some((t) =>
    types.has(t as PinType),
  );
  if (types.has("bidir") || (out && types.has("input"))) return "bidir";
  if (out) return "output";
  if (types.has("input")) return "input";
  return "passive";
}

/**
 * Turns KiCad's view of a design into partstyle files: one block per sheet file (a reused sheet
 * is one block used twice), ports where nets cross sheets, parts mapped to the library or to
 * generics where exact, and draft records for the rest. On a re-import, the person's intents,
 * net attributes, port kinds, nc statements, waivers and block descriptions are carried over.
 */
export function buildImport(input: ImportInput): ImportResult {
  const report: string[] = [];
  const root = input.sheets.get(input.rootFile);
  if (!root) throw new Error(`no netlist for the root sheet ${input.rootFile}`);

  // Library lookups: by MPN, id and LCSC number. Drafts never match: they are remade.
  const byMpn = new Map<string, PartRecord>();
  for (const { record: r } of input.library.values()) {
    if (isDraft(r)) continue;
    byMpn.set(`id:${r.id}`, r);
    if (r.preferred_mpn && !byMpn.has(norm(r.preferred_mpn))) byMpn.set(norm(r.preferred_mpn), r);
    if (!byMpn.has(norm(r.id))) byMpn.set(norm(r.id), r);
    if (r.sourcing?.lcsc) byMpn.set(`lcsc:${norm(r.sourcing.lcsc)}`, r);
  }

  const previous = new Map((input.previous?.blocks ?? []).map((b) => [b.block.name, b]));
  const prevPinNet = new Map([...previous].map(([name, b]) => [name, pinNets(b, input.library)]));
  const prevLocal = new Map<string, string>();
  for (const [p, ref] of input.previous?.annotation ?? []) {
    const cut = p.lastIndexOf("/") + 1;
    prevLocal.set(`${p.slice(0, cut)}\u0000${ref}`, p.slice(cut));
  }

  // Blocks per sheet file, in page order.
  const files = [...new Set([input.rootFile, ...root.sheets.map((s) => s.file)])].filter(
    (f) => f !== "" && input.sheets.has(f),
  );
  const blockNames = new Set<string>(["main"]);
  const models = new Map<string, FileModel>();
  const skipped: string[] = [];
  for (const file of files) {
    const data = input.sheets.get(file) as KicadNetlist;
    const base = file.replace(/^.*[\\/]/, "").replace(/\.kicad_sch$/, "");
    const block = file === input.rootFile ? "main" : unique(cktName(base), blockNames);
    const childSheets = new Map<string, { file: string; inst: string }>();
    const insts = new Set<string>();
    for (const s of data.sheets) {
      const [seg, ...deeper] = segs(s.tstamps);
      if (seg === undefined || deeper.length > 0) continue;
      const name = s.names.split("/").filter(Boolean).at(-1) ?? seg;
      childSheets.set(seg, { file: s.file, inst: unique(cktName(name), insts) });
    }
    models.set(file, {
      file,
      block,
      data,
      parts: [],
      nets: [],
      nodeNet: new Map(),
      childSheets,
      ports: new Set(),
    });
  }

  // Sheet instances from the whole design, depth first, with partstyle path prefixes.
  interface Inst {
    tstamps: string;
    file: string;
    prefix: string;
  }
  const instances: Inst[] = [];
  const walk = (tstamps: string, file: string, prefix: string) => {
    instances.push({ tstamps, file, prefix });
    const m = models.get(file);
    for (const [seg, c] of m?.childSheets ?? []) {
      if (models.has(c.file)) walk(`${tstamps}${seg}/`, c.file, `${prefix}${c.inst}/`);
    }
  };
  walk("/", input.rootFile, "");
  const rootComp = new Map(root.comps.map((c) => [`${c.sheet}|${c.uuid}`, c]));
  const firstInst = new Map<string, Inst>();
  for (const i of instances) if (!firstInst.has(i.file)) firstInst.set(i.file, i);

  // Parts on each sheet, resolved once per file.
  for (const m of models.values()) {
    const inst = firstInst.get(m.file);
    const taken = new Set<string>();
    const direct = m.data.comps.filter((c) => c.sheet === "/" && !isFlag(c));
    direct.sort((a, b) => natural(a.ref, b.ref));
    for (const c of direct) {
      const kpins = m.data.libparts.get(`${c.lib}:${c.part}`) ?? [];
      if (kpins.length === 0) {
        skipped.push(c.ref);
        continue;
      }
      const kicadRef = (inst && rootComp.get(`${inst.tstamps}|${c.uuid}`)?.ref) ?? c.ref;
      const wanted = prevLocal.get(`${inst?.prefix ?? ""}\u0000${kicadRef}`) ?? kicadRef;
      const ref = taken.has(cktName(wanted)) ? unique(cktName(kicadRef), taken) : cktName(wanted);
      taken.add(ref);
      m.parts.push({ uuid: c.uuid, comp: c, ref, res: resolve(c, kpins, byMpn), token: new Map() });
    }
  }

  // Draft records, one per distinct symbol + value + footprint + MPN.
  const drafts = new Map<string, ImportedDraft & { res: Resolution; comp: KicadComp }>();
  const ids = new Set(
    [...input.library.values()].filter((e) => !isDraft(e.record)).map((e) => e.record.id),
  );
  for (const m of models.values()) {
    for (const p of m.parts) {
      const key = p.res.draftKey;
      if (key === undefined) continue;
      let d = drafts.get(key);
      if (!d) {
        const c = p.comp;
        const mpn = field(c, "mpn");
        const quantity = /^\d/.test(c.value);
        let id = idOf(mpn || (quantity ? `${c.part}_${c.value}` : c.value || c.part));
        if (ids.has(id) && c.footprint) id = idOf(`${id}_${c.footprint.replace(/^.*:/, "")}`);
        id = unique(id, ids);
        // A pad with no symbol pin (an NC pin left off the symbol) is unconnected in KiCad.
        const numbers = new Set(p.res.pins.map((x) => x.number));
        const extra = [...(input.pads?.get(c.footprint) ?? [])].filter(
          (n) => !numbers.has(n) && /^[A-Za-z0-9]+$/.test(n) && !/^MP\d*$/i.test(n),
        );
        const res = {
          ...p.res,
          pins: [
            ...p.res.pins,
            ...extra.map((n) => ({ number: n, name: "NC", type: "nc" as const })),
          ],
        };
        d = { id, text: "", users: [], from: `${c.lib}:${c.part}`, res, comp: c };
        drafts.set(key, d);
      }
      p.res = { ...p.res, pins: d.res.pins, spec: { kind: "lib", id: d.id } };
      d.users.push(`${m.block}/${p.ref}`);
    }
  }
  for (const d of drafts.values()) d.text = draftYaml(d.id, d.comp, d.res, input.stockSymbol);

  // Local nets per sheet file, from that file's own export (its labels name them).
  for (const m of models.values()) {
    const byRef = new Map(m.data.comps.map((c) => [c.ref, c]));
    const partByUuid = new Map(m.parts.map((p) => [p.uuid, p]));
    m.data.nets.forEach((n, i) => {
      const net: LocalNet = {
        kicadName: n.name,
        name: "",
        auto: false,
        pins: [],
        childRefs: [],
        flag: false,
        types: new Set(),
      };
      for (const node of n.nodes) {
        const c = byRef.get(node.ref);
        if (!c) continue;
        m.nodeNet.set(`${c.sheet}|${c.uuid}|${node.pin}`, i);
        if (isFlag(c)) {
          if (c.sheet === "/") net.flag = true;
          continue;
        }
        const kp = m.data.libparts.get(`${c.lib}:${c.part}`)?.find((p) => p.num === node.pin);
        net.types.add(kicadTypes[kp?.type ?? ""] ?? "passive");
        const part = c.sheet === "/" ? partByUuid.get(c.uuid) : undefined;
        if (part) net.pins.push({ part, num: node.pin });
      }
      m.nets.push(net);
    });
  }
  // Child sheet connections, now that every file's nodes are indexed.
  for (const m of models.values()) {
    const byRef = new Map(m.data.comps.map((c) => [c.ref, c]));
    m.data.nets.forEach((n, i) => {
      const net = m.nets[i] as LocalNet;
      const seen = new Set<string>();
      for (const node of n.nodes) {
        const c = byRef.get(node.ref);
        if (!c || c.sheet === "/") continue;
        const seg = seg1(c.sheet);
        const sheet = m.childSheets.get(seg);
        const cm = sheet && models.get(sheet.file);
        const rel = `/${c.sheet.split("/").slice(2).join("/")}`;
        const idx = cm?.nodeNet.get(`${rel}|${c.uuid}|${node.pin}`);
        if (idx === undefined || seen.has(`${seg}|${idx}`)) continue;
        seen.add(`${seg}|${idx}`);
        net.childRefs.push({ seg, net: idx });
      }
    });
  }

  // What each net connects in its own sheet decides whether it is drawn; children's nets that
  // a parent connects to become ports.
  // One pin is kept only when this sheet labels it (`/X`, or a global name); `/child/X` is the
  // child's own label.
  const ownLabel = (name: string) =>
    /^\/[^/]+$/.test(name) || (!name.startsWith("/") && !/^(Net-|unconnected-)/.test(name));
  const used = (m: FileModel, i: number) => {
    const n = m.nets[i] as LocalNet;
    return (
      n.pins.length + n.childRefs.length >= 2 ||
      (n.pins.length === 1 && n.childRefs.length === 0 && ownLabel(n.kicadName))
    );
  };
  for (const m of models.values()) {
    m.nets.forEach((n, i) => {
      if (!used(m, i) && !m.ports.has(i)) return;
      // Several references into one child are each that child's port.
      for (const r of n.childRefs) {
        const cm = models.get(m.childSheets.get(r.seg)?.file ?? "");
        cm?.ports.add(r.net);
      }
    });
  }
  // A port whose net only passes through needs its parent to carry it too: repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of models.values()) {
      for (const i of m.ports) {
        for (const r of (m.nets[i] as LocalNet).childRefs) {
          const cm = models.get(m.childSheets.get(r.seg)?.file ?? "");
          if (cm && !cm.ports.has(r.net)) {
            cm.ports.add(r.net);
            changed = true;
          }
        }
      }
    }
  }

  // Pin tokens: the pin name when it is a plain word, names one pin (or pins all on one net)
  // and is not another pin's number; otherwise the number.
  for (const m of models.values()) {
    const netOf = new Map<string, number>();
    m.nets.forEach((n, i) => {
      for (const p of n.pins) netOf.set(`${p.part.ref}.${p.num}`, i);
    });
    for (const p of m.parts) {
      const numbers = new Set(p.res.pins.map((x) => x.number));
      for (const pin of p.res.pins) {
        const same = p.res.pins.filter((x) => x.name === pin.name);
        const nets = new Set(same.map((x) => netOf.get(`${p.ref}.${x.number}`) ?? `nc${x.number}`));
        const ok =
          safeToken.test(pin.name) &&
          (pin.name === pin.number || !numbers.has(pin.name)) &&
          (same.length === 1 || nets.size === 1);
        p.token.set(pin.number, ok ? pin.name : pin.number);
      }
    }
  }

  // Net names, strongest first: the sheet's own label; the name the net had here before (found
  // by its pins, for nets KiCad drew as bare wires or named after a child's label); a child
  // sheet's label; else the first pin's. Ports take the sheet's label.
  const autoNamed = new Map<string, string[]>();
  const taken = new Map([...models.values()].map((m) => [m, new Set<string>()]));
  const namedNets = (m: FileModel) =>
    m.nets.map((n, i) => ({ n, i })).filter(({ i }) => used(m, i) || m.ports.has(i));
  const last = (kicadName: string) => kicadName.split("/").filter(Boolean).at(-1) ?? kicadName;
  for (const m of models.values()) {
    const t = taken.get(m) as Set<string>;
    for (const { n } of namedNets(m)) {
      if (ownLabel(n.kicadName)) n.name = unique(cktName(last(n.kicadName)), t);
    }
    const prevBlock = previous.get(m.block);
    for (const { n, i } of namedNets(m)) {
      if (!m.ports.has(i) || n.name === "") continue;
      n.port = n.name;
      const was = prevBlock?.nets.find((x) => x.port === n.port)?.name;
      if (was !== undefined && was !== n.name && !t.has(was)) {
        t.delete(n.name);
        t.add(was);
        n.name = was;
      }
    }
  }
  for (const m of models.values()) {
    const t = taken.get(m) as Set<string>;
    const named = namedNets(m);
    const before = prevPinNet.get(m.block);
    for (const { n } of named) {
      if (n.name !== "" || !before) continue;
      const votes = new Map<string, number>();
      const keys = [
        ...n.pins.map((p) => `${p.part.ref}.${p.num}`),
        ...n.childRefs.map((r) => {
          const sheet = m.childSheets.get(r.seg);
          const port = models.get(sheet?.file ?? "")?.nets[r.net]?.port;
          return `${sheet?.inst}.${port}`;
        }),
      ];
      for (const k of keys) {
        const was = before.get(k);
        if (was !== undefined) votes.set(was, (votes.get(was) ?? 0) + 1);
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best !== undefined && !t.has(best)) {
        n.name = best;
        t.add(best);
      }
    }
    for (const { n } of named) {
      if (n.name !== "" || /^(Net-|unconnected-)/.test(n.kicadName)) continue;
      const name = cktName(last(n.kicadName));
      if (!t.has(name)) {
        n.name = name;
        t.add(name);
      }
    }
    for (const { n } of named) {
      if (n.name !== "") continue;
      const first = [...n.pins].sort(
        (a, b) => natural(a.part.ref, b.part.ref) || natural(a.num, b.num),
      )[0];
      const childRef = n.childRefs[0];
      const base = first
        ? `N_${first.part.ref}_${first.part.token.get(first.num) ?? first.num}`
        : `N_${m.childSheets.get(childRef?.seg ?? "")?.inst ?? "X"}`;
      n.name = unique(cktName(base), t);
      n.auto = true;
      autoNamed.set(m.block, [...(autoNamed.get(m.block) ?? []), n.name]);
    }
    for (const i of m.ports) {
      const n = m.nets[i] as LocalNet;
      n.port ??= n.name;
    }
  }

  // Annotation: every instance's KiCad refdes for each block-local part.
  const annotation: Annotation = new Map();
  for (const inst of instances) {
    const m = models.get(inst.file);
    for (const p of m?.parts ?? []) {
      const c = rootComp.get(`${inst.tstamps}|${p.uuid}`);
      if (c) annotation.set(`${inst.prefix}${p.ref}`, c.ref);
    }
  }

  // Write the blocks.
  const circuits: ImportResult["circuits"] = [];
  const counts = new Map<How, number>();
  const notes: string[] = [];
  let ncFlags = 0;
  for (const m of models.values()) {
    const prev = previous.get(m.block);
    const prevPart = new Map(prev?.parts.map((p) => [p.ref, p]));
    const prevNet = new Map(prev?.nets.map((n) => [n.name, n]));
    const prevPort = new Map(prev?.ports.map((p) => [p.name, p]));
    const lines: string[] = [];
    const sheetTitle = root.sheets.find((s) => s.file === m.file)?.title ?? "";
    const rootTitle = root.sheets.find((s) => s.names === "/")?.title ?? "";
    const description =
      prev?.block.description ??
      (m.file === input.rootFile
        ? rootTitle || `KiCad project ${input.project}`
        : sheetTitle && sheetTitle !== rootTitle
          ? sheetTitle
          : `KiCad sheet ${m.file}`);
    lines.push(`block ${m.block} ${quote(description)}`, "");

    const ports = [...m.ports]
      .map((i) => m.nets[i] as LocalNet)
      .map((n) => {
        const name = n.port ?? n.name;
        return { name, kind: prevPort.get(name)?.kind ?? inferKind(name, n.types) };
      })
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || natural(a.name, b.name));
    section(
      lines,
      ports.map((p) => [`port ${p.name}`, `: ${p.kind}`]),
    );

    const uses = [...m.childSheets.values()].filter((c) => models.has(c.file));
    section(
      lines,
      uses.map((c) => [`use ${models.get(c.file)?.block}`, `as ${c.inst}`]),
    );

    section(
      lines,
      m.parts.map((p) => {
        counts.set(p.res.how, (counts.get(p.res.how) ?? 0) + 1);
        if (p.res.note && p.res.how !== "draft") notes.push(`${m.block}/${p.ref}: ${p.res.note}`);
        const intent = prevPart.get(p.ref)?.intent;
        return [`part ${p.ref}`, printSpec(p.res.spec), ...(intent ? [`@ ${intent}`] : [])];
      }),
    );

    const netLines: string[][] = [];
    const byName = (a: LocalNet, b: LocalNet) => natural(a.name, b.name);
    const portNets = [...m.ports].map((i) => m.nets[i] as LocalNet).sort(byName);
    const others = m.nets.filter((_, i) => used(m, i) && !m.ports.has(i)).sort(byName);
    for (const n of [...portNets, ...others]) {
      const refs: string[] = [];
      const pins = [...n.pins].sort(
        (a, b) => natural(a.part.ref, b.part.ref) || natural(a.num, b.num),
      );
      for (const p of pins) {
        const r = `${p.part.ref}.${p.part.token.get(p.num) ?? p.num}`;
        if (!refs.includes(r)) refs.push(r);
      }
      for (const r of n.childRefs) {
        const sheet = m.childSheets.get(r.seg);
        const cm = models.get(sheet?.file ?? "");
        const child = cm?.nets[r.net];
        const port = child?.port ?? child?.name;
        if (sheet && port) refs.push(`${sheet.inst}.${port}`);
      }
      if (refs.length === 0) continue;
      // A net that was here before keeps its pin order and attributes (KiCad has no attributes,
      // and its PWR_FLAGs may be ones the export added).
      const pn = prevNet.get(n.name);
      if (pn) {
        const order = pn.pins.map((p) => `${p.target}.${p.pin}`);
        const rank = (r: string) => (order.includes(r) ? order.indexOf(r) : order.length);
        refs.sort((a, b) => rank(a) - rank(b));
      }
      const attrs: Record<string, string> = pn
        ? pn.attrs
        : { ...(n.flag && { source: FLAG_SOURCE }) };
      const a = Object.entries(attrs);
      netLines.push([
        `net ${n.name}`,
        [
          `: ${refs.join(" ")}`,
          m.ports.has(m.nets.indexOf(n)) ? ` -> port ${n.port ?? n.name}` : "",
          a.length > 0 ? ` {${a.map(([k, v]) => `${k}: ${v}`).join(", ")}}` : "",
          pn?.intent ? ` @ ${pn.intent}` : "",
        ].join(""),
      ]);
    }
    section(lines, netLines);

    // Pins KiCad's ERC accepts as unconnected carry a no-connect flag. The person's nc statements
    // stay while a pin they cover is still open; the ones import wrote follow KiCad's flags.
    const connected = new Set(
      m.nets
        .filter((_, i) => used(m, i) || m.ports.has(i))
        .flatMap((n) => n.pins.map((p) => `${p.part.ref}.${p.num}`)),
    );
    const inst = firstInst.get(m.file);
    const carried = (prev?.ncs ?? []).filter((n) => {
      if (n.intent === NC_INTENT) return false;
      const part = m.parts.find((p) => p.ref === n.pin.target);
      const pattern = globToRegExp(n.pin.pin);
      return part?.res.pins.some(
        (pin) =>
          !connected.has(`${part.ref}.${pin.number}`) &&
          (pattern.test(pin.name) || pattern.test(pin.number)),
      );
    });
    const ncs = carried.map((decl) => printStatement({ kind: "nc", decl }));
    const covered = [
      ...carried.map((n) => printPinRef(n.pin)),
      ...(prev?.waivers ?? [])
        .filter((w) => w.code === "erc.unconnected-pin")
        .map((w) => w.subject),
    ].map(globToRegExp);
    if (input.unconnected) {
      for (const p of m.parts) {
        const kicadRef = (inst && rootComp.get(`${inst.tstamps}|${p.uuid}`)?.ref) ?? p.comp.ref;
        for (const pin of p.res.pins) {
          // A pin that may stay open needs no nc: its flag says nothing new.
          if (isOpenByDesign(pin) || connected.has(`${p.ref}.${pin.number}`)) continue;
          if (input.unconnected.has(`${kicadRef}.${pin.number}`)) continue;
          const subjects = [`${p.ref}.${pin.name}`, `${p.ref}.${pin.number}`, p.ref];
          if (covered.some((re) => subjects.some((s) => re.test(s)))) continue;
          ncs.push(`nc ${p.ref}.${p.token.get(pin.number)} @ ${NC_INTENT}`);
          ncFlags++;
        }
      }
    }
    const waivers = (prev?.waivers ?? []).map((decl) => printStatement({ kind: "waive", decl }));
    if (ncs.length > 0) lines.push(...ncs, "");
    if (waivers.length > 0) lines.push(...waivers, "");
    circuits.push({ file: `circuit/${m.block}.ckt`, text: `${lines.join("\n").trimEnd()}\n` });
  }

  // Report.
  const blocksUsed = new Map<string, number>();
  for (const i of instances) {
    const b = models.get(i.file)?.block ?? "";
    blocksUsed.set(b, (blocksUsed.get(b) ?? 0) + 1);
  }
  const partCount = [...annotation].length;
  report.push(
    `KiCad ${input.project}: ${instances.length} sheet${instances.length === 1 ? "" : "s"} -> blocks ${[
      ...blocksUsed,
    ]
      .map(([b, n]) => (n > 1 ? `${b} x${n}` : b))
      .join(", ")}; ${partCount} parts`,
  );
  const kinds = { generic: 0, library: 0, draft: 0 };
  for (const m of models.values()) {
    for (const p of m.parts) {
      kinds[
        p.res.how === "draft" ? "draft" : p.res.spec.kind === "generic" ? "generic" : "library"
      ]++;
    }
  }
  const matched = (["spec", "mpn", "lcsc", "value"] as const)
    .filter((h) => counts.has(h))
    .map((h) => `${counts.get(h)} by ${h === "spec" ? "partstyle Spec field" : h}`);
  report.push(
    `block parts: ${kinds.library} library, ${kinds.generic} generic, ${kinds.draft} on ${drafts.size} draft record${drafts.size === 1 ? "" : "s"}${matched.length > 0 ? ` (matched ${matched.join(", ")})` : ""}`,
  );
  if (drafts.size > 0) {
    report.push("unresolved parts (draft records in parts/, flagged part.draft until completed):");
    for (const d of drafts.values()) {
      const why = d.res.note ? `; ${d.res.note}` : "";
      report.push(
        `  lib:${d.id} (${d.users.join(" ")}): KiCad ${d.from}, value ${d.comp.value || "-"}${why}`,
      );
    }
  }
  if (notes.length > 0) report.push("notes:", ...notes.map((n) => `  ${n}`));
  if (skipped.length > 0) report.push(`skipped (no pins): ${skipped.join(" ")}`);
  const autoCount = [...autoNamed.values()].reduce((s, l) => s + l.length, 0);
  if (autoCount > 0) {
    report.push(
      `${autoCount} net${autoCount === 1 ? "" : "s"} had no name in KiCad and ${autoCount === 1 ? "is" : "are"} named after a pin (N_REF_PIN); rename the meaningful ones (listed in notes/kicad-import.md)`,
    );
  }
  if (input.unconnected === undefined) {
    report.push(
      "no-connect flags: unknown (KiCad ERC did not run), so unconnected pins are reported",
    );
  } else if (ncFlags > 0) {
    report.push(`no-connect flags: ${ncFlags} pins marked nc`);
  }

  // What KiCad says the design connects, minus what import left out.
  const flags = new Set(root.comps.filter(isFlag).map((c) => c.ref));
  const dropped = new Set([...flags, ...skipped.flatMap((r) => rootRefsOf(root, r, models))]);
  const expected: ParsedNetlist = {
    refs: new Set(root.comps.map((c) => c.ref).filter((r) => !dropped.has(r))),
    nets: root.nets.map((n) => ({
      name: n.name,
      nodes: n.nodes.filter((x) => !dropped.has(x.ref)).map((x) => `${x.ref}.${x.pin}`),
    })),
  };

  return {
    circuits,
    drafts: [...drafts.values()].map(({ id, text, users, from }) => ({ id, text, users, from })),
    annotation,
    annotationLock: formatAnnotationLock(annotation),
    notes: notesMarkdown(input, autoNamed),
    report,
    expected,
    blocks: [...models.values()].map((m) => m.block),
  };
}

/** `REF.NUMBER` (and `INST.PORT`) → net name in a block, with pins resolved as elaboration does. */
function pinNets(b: CktFile, library: PartLibrary): Map<string, string> {
  const tables = new Map<string, PinDef[]>();
  for (const p of b.parts) {
    const pins =
      p.spec.kind === "lib"
        ? (() => {
            const r = library.get(p.spec.id)?.record;
            return r ? recordPins(r) : [];
          })()
        : (generics[p.spec.fn]?.pins ?? []);
    tables.set(p.ref, pins);
  }
  const out = new Map<string, string>();
  for (const n of b.nets) {
    for (const ref of n.pins) {
      if (!tables.has(ref.target)) out.set(`${ref.target}.${ref.pin}`, n.name);
      const pins = tables.get(ref.target) ?? [];
      const byNumber = pins.filter((p) => p.number === ref.pin);
      for (const p of byNumber.length > 0 ? byNumber : pins.filter((x) => x.name === ref.pin)) {
        out.set(`${ref.target}.${p.number}`, n.name);
      }
    }
  }
  return out;
}

/** Every instance's refdes of a skipped part (it was skipped by its first-instance ref). */
function rootRefsOf(root: KicadNetlist, ref: string, models: Map<string, FileModel>): string[] {
  for (const m of models.values()) {
    const c = m.data.comps.find((x) => x.sheet === "/" && x.ref === ref);
    if (c) return root.comps.filter((x) => x.uuid === c.uuid).map((x) => x.ref);
  }
  return [ref];
}

const kindOrder = (k: PortKind) =>
  ["power_in", "power_out", "ground", "input", "output", "bidir", "passive"].indexOf(k);

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Statements aligned in columns, as hand-written .ckt files are, then a blank line. */
function section(lines: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Array.from({ length: cols - 1 }, (_, c) =>
    Math.max(...rows.filter((r) => r.length > c + 1).map((r) => (r[c] as string).length)),
  );
  for (const r of rows) {
    lines.push(
      r
        .map((cell, c) => (c < r.length - 1 ? cell.padEnd(width[c] ?? 0) : cell))
        .join(" ")
        .trimEnd(),
    );
  }
  lines.push("");
}

/** Plain when YAML would read it back as the same string, else quoted (`"1"`, `"~"`, `"no"`). */
const yamlScalar = (s: string) =>
  /^[A-Za-z_][\w+\-/.]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s)
    ? s
    : JSON.stringify(s);

function draftYaml(
  id: string,
  c: KicadComp,
  res: Resolution,
  stockSymbol: ImportInput["stockSymbol"],
): string {
  // A project's cached copy of a stock symbol (`myproj:R`) is usually Device's.
  const libId = `${c.lib}:${c.part}`;
  const symbol = stockSymbol?.(libId)
    ? libId
    : stockSymbol?.(`Device:${c.part}`)
      ? `Device:${c.part}`
      : undefined;
  const datasheet = c.fields.Datasheet?.trim() ?? "";
  const pkg = c.footprint === "" ? "" : (c.footprint.replace(/^.*:/, "").split("_")[0] ?? "");
  const summary = c.fields.Description?.trim() || `${c.value || c.part} (KiCad symbol ${libId})`;
  const optional = (key: string, v: string) => (v === "" ? [] : [`${key}: ${yamlScalar(v)}`]);
  const lines = [
    `# Draft from KiCad import (symbol ${libId}, value ${c.value || "-"}). Complete it from the`,
    "# datasheet (identity, ratings, requirements), then set provenance.extracted_by to ai or human.",
    `id: ${yamlScalar(id)}`,
    `summary: ${yamlScalar(summary)}`,
    ...optional("manufacturer", field(c, "manufacturer")),
    ...optional("preferred_mpn", field(c, "mpn")),
    ...optional("package", pkg),
    ...optional("footprint", c.footprint),
    ...(symbol ? [`kicad_symbol: ${yamlScalar(symbol)}`] : []),
    "pins:",
    ...[...res.pins]
      .sort((a, b) => natural(a.number, b.number))
      .map((p) => `  ${p.number}: { name: ${yamlScalar(p.name)}, type: ${p.type} }`),
    "provenance:",
    ...(datasheet && datasheet !== "~" ? [`  datasheet: { url: ${yamlScalar(datasheet)} }`] : []),
    "  extracted_by: kicad",
    "  verified_by: null",
  ];
  return `${lines.join("\n")}\n`;
}

function notesMarkdown(input: ImportInput, autoNamed: Map<string, string[]>): string {
  const lines = [
    "# KiCad import",
    "",
    `Imported from \`${input.source ?? input.project}\`${input.date ? ` on ${input.date}` : ""}. Re-importing replaces`,
    "circuit/ but keeps intents, net attributes, port kinds, nc statements, waivers and block descriptions.",
    "",
  ];
  if (autoNamed.size > 0) {
    lines.push(
      "## Nets named by import",
      "",
      "KiCad named these automatically; rename the meaningful ones.",
      "",
    );
    for (const [b, names] of autoNamed) lines.push(`- ${b}: ${names.join(", ")}`);
    lines.push("");
  }
  const notes = [...(input.notes ?? [])].filter(([, t]) => t.length > 0);
  if (notes.length > 0) {
    lines.push("## Text notes from the schematic", "");
    for (const [file, texts] of notes) {
      lines.push(`### ${file}`, "", ...texts.map((t) => `- ${t.replace(/\n/g, " / ")}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * A copy of a sheet in which PWR_FLAGs are ordinary symbols, so KiCad's netlist shows which nets
 * they mark as supplied (it leaves power symbols out). Only ever written to a temporary copy.
 */
export function exposeFlags(source: string): string {
  const doc = readSExpr(source);
  const flagId = (id: SExpr | undefined) => typeof id === "string" && /(^|:)PWR_FLAG$/.test(id);
  const visit = (list: SExpr[], inFlag: boolean) => {
    list.forEach((x, i) => {
      if (!Array.isArray(x)) {
        if (inFlag && typeof x === "string" && x.startsWith("#")) list[i] = `FLAG${x.slice(1)}`;
        return;
      }
      if (x[0] === "lib_symbols") {
        for (const s of children(x, "symbol")) {
          const p = s.findIndex((c) => Array.isArray(c) && c[0] === "power");
          if (flagId(s[1]) && p >= 0) s.splice(p, 1);
        }
        return;
      }
      visit(x, inFlag || (x[0] === "symbol" && flagId(child(x, "lib_id")?.[1])));
    });
  };
  visit(doc, false);
  return `${writeSExpr(doc)}\n`;
}

/** Text notes on a sheet: `(text "...")` and text boxes. */
export function sheetNotes(source: string): string[] {
  const doc = readSExpr(source);
  return [...children(doc, "text"), ...children(doc, "text_box")]
    .map((t) => text(t[1]).trim())
    .filter(Boolean);
}
