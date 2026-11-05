import { type Approval, type Approvals, approvalStatus } from "./approvals.js";
import type { StatementKind } from "./ckt/ast.js";
import { printSpec } from "./ckt/print.js";
import type { Issue } from "./diagnostics.js";
import { type SymbolGraphics, symbolGraphics } from "./drawing/graphics.js";
import type { Drawing } from "./drawing/prepare.js";
import type { SheetLayout } from "./drawing/types.js";
import type { FlatPart } from "./netlist/elaborate.js";
import { type PartRecord, type PinType, partName, requirementText } from "./parts/schema.js";
import { type Supplier, TOP_BLOCK } from "./project/config.js";
import type { Comment, Focus, ReviewMode } from "./review.js";
import type { AppliedWaiver, ValidationResult } from "./validate.js";
import type { ChangeOp } from "./versions/diff.js";
import { countIssues } from "./views.js";

export interface PartInfo {
  path: string;
  /** Flat refdes, as exported to KiCad. */
  ref: string;
  spec: string;
  value: string;
  intent?: string;
  record?: {
    id: string;
    preferredMpn?: string;
    manufacturer: string;
    summary: string;
    package: string;
    footprint: string;
    verified: boolean;
    ratings: Record<string, string>;
    requirements: string[];
    notes: string[];
    /** Where the record lives, relative to the project. */
    file: string;
  };
  bom: { status: "library" | "resolved" | "unresolved" | "board"; footprint?: string };
  pins: { number: string; name: string; type: PinType; net?: string }[];
  /** The sign-off on this part, if any; `changed` when it has changed since. */
  approval?: Pick<Approval, "by" | "at"> & { status: "approved" | "changed" };
  /** The datasheet and supplier searches, for checking the part. */
  links: PartLink[];
}

export interface PartLink {
  label: string;
  url: string;
}

const supplierSearches: Record<Supplier, { label: string; search: string }> = {
  lcsc: { label: "LCSC", search: "https://www.lcsc.com/search?q=" },
  digikey: { label: "DigiKey", search: "https://www.digikey.com/en/products/result?keywords=" },
  mouser: { label: "Mouser", search: "https://www.mouser.com/c/?q=" },
};

const genericWords: Record<string, string> = {
  res: "resistor",
  cap: "capacitor",
  ind: "inductor",
};

/**
 * Where to check a part: its datasheet, or a search for it, and a search at each of the project's
 * suppliers, by the supplier's own part number where the record has one. An unresolved generic
 * searches by its spec.
 */
function partLinks(
  part: FlatPart,
  r: PartRecord | undefined,
  suppliers: readonly Supplier[],
): PartLink[] {
  const spec = part.spec;
  if (spec.kind === "generic" && spec.fn === "fp") return []; // nothing to buy
  const term = r
    ? partName(r)
    : spec.kind === "lib"
      ? spec.id
      : `${genericWords[spec.fn] ?? spec.fn} ${spec.args.join(" ")}`;
  const sheet = r?.provenance.datasheet?.url;
  const web = `https://www.google.com/search?q=${encodeURIComponent(`${term} datasheet`)}`;
  const datasheet =
    sheet && /^https?:\/\//i.test(sheet)
      ? [{ label: "Datasheet", url: sheet }]
      : r
        ? [{ label: "Find datasheet", url: web }]
        : [];
  return [
    ...datasheet,
    ...suppliers.map((s) => ({
      label: supplierSearches[s].label,
      url: supplierSearches[s].search + encodeURIComponent(r?.sourcing?.[s] || term),
    })),
  ];
}

export interface ViewerSheet {
  block: string;
  description?: string;
  /** Every placement of this block; the sheet geometry is shared. */
  instances: {
    prefix: string;
    page: number;
    /** Block-local net name → flat net name in this instance. */
    nets: Record<string, string>;
  }[];
  layout: SheetLayout;
}

/** A statement change, flattened for the viewer: `C3.2` in changeset `C3`. */
export interface ChangeItem {
  id: string;
  block: string;
  kind: StatementKind;
  key: string;
  op: ChangeOp;
  /** One line, as `diff` prints it. */
  text: string;
}

/** A variant: what it has of its own, and which of those blocks main changed since the copy. */
export interface VariantSummary {
  name: string;
  description?: string;
  /** Whether it overrides parts of the project file. */
  projectFile: boolean;
  /** Its own block files (circuit/x.ckt). */
  blocks: string[];
  diverged: string[];
}

/**
 * Checkpoint, changesets, pending changes and variants: what the review panel shows. For a
 * variant, changesets and pending changes are the variant's own.
 */
export interface VersionState {
  /** Whether the project is in a git repository, so checkpoints work. */
  git: boolean;
  mode: ReviewMode;
  checkpoint?: { id: string; message: string; date: string };
  changesets: { id: string; source: string; note?: string; time: string; items: ChangeItem[] }[];
  pending: { id: string; created: string; log: string[] }[];
  /** Everything changed since the checkpoint, for highlighting on the sheets. */
  changed: Omit<ChangeItem, "id" | "text">[];
  variants: VariantSummary[];
  /** For a variant: where it differs from main, for highlighting on its sheets. */
  vsMain?: Omit<ChangeItem, "id" | "text">[];
}

/** Everything the viewer shows, as one JSON document. */
export interface ViewerModel {
  project: string;
  top: string;
  summary: { errors: number; warnings: number; waived: number };
  issues: Issue[];
  /** What waivers hide, so the person can review them. */
  waivers: AppliedWaiver[];
  sheets: ViewerSheet[];
  symbols: Record<string, SymbolGraphics>;
  parts: Record<string, PartInfo>;
  nets: Record<string, { pins: string[]; attrs: Record<string, string>; aliases: string[] }>;
  comments: Comment[];
  focus: Focus;
  /** Review and versioning state; the server adds it fresh to every model it sends. */
  versions?: VersionState;
  /** The variant shown, when not the main line. */
  variant?: string;
  /** A pending change drawn as if accepted, with what it changes. */
  preview?: { id: string; changed: Omit<ChangeItem, "id" | "text">[] };
}

/** Builds the viewer's data from a prepared drawing and the validation it came from. */
export function buildViewerModel(
  drawing: Drawing,
  result: ValidationResult,
  review: { comments: Comment[]; focus: Focus },
  approvals: Approvals = new Map(),
): ViewerModel {
  const { netlist, plan } = drawing;
  const flatByAlias = new Map<string, string>();
  for (const n of netlist.nets) for (const a of n.aliases) flatByAlias.set(a, n.name);

  const sheets: ViewerSheet[] = [];
  const symbols: Record<string, SymbolGraphics> = {};
  const symbolsByLibId = new Map([...drawing.symbols.values()].map((s) => [s.libId, s]));
  for (const [block, layout] of drawing.sheets) {
    const decl = result.blocks.find((b) => b.block.name === block);
    sheets.push({
      block,
      ...(decl?.block.description !== undefined && { description: decl.block.description }),
      instances: plan.instancesOf(block).map((i) => ({
        prefix: i.prefix,
        page: i.page,
        nets: Object.fromEntries(
          (decl?.nets ?? []).flatMap((n) => {
            const flat = flatByAlias.get(i.prefix + n.name);
            return flat ? [[n.name, flat]] : [];
          }),
        ),
      })),
      layout,
    });
    for (const u of layout.units) {
      const s = symbolsByLibId.get(u.libId);
      if (s && !symbols[u.libId]) symbols[u.libId] = symbolGraphics(s.def);
    }
    for (const p of layout.power) {
      if (!symbols[p.libId]) symbols[p.libId] = symbolGraphics(drawing.power.byLibId(p.libId).def);
    }
  }
  sheets.sort((a, b) => (a.instances[0]?.page ?? 0) - (b.instances[0]?.page ?? 0));

  const parts: Record<string, PartInfo> = {};
  for (const p of netlist.parts) {
    const entry = drawing.bomByPath.get(p.path);
    const r = entry?.record ?? p.record;
    const libEntry = r && result.library.get(r.id);
    parts[p.path] = {
      path: p.path,
      ref: drawing.annotation.get(p.path) ?? p.path,
      spec: printSpec(p.spec),
      value: entry?.value ?? printSpec(p.spec),
      ...(p.intent !== undefined && { intent: p.intent }),
      ...(r && {
        record: {
          id: r.id,
          ...(r.preferred_mpn !== undefined && { preferredMpn: r.preferred_mpn }),
          manufacturer: r.manufacturer,
          summary: r.summary,
          package: r.package,
          footprint: r.footprint,
          verified: r.provenance.verified_by !== null,
          ratings: Object.fromEntries(
            Object.entries(r.ratings ?? {}).map(([k, v]) => [
              k,
              typeof v === "object" ? JSON.stringify(v) : String(v),
            ]),
          ),
          requirements: (r.requirements ?? []).map(requirementText),
          notes: r.notes ?? [],
          file: libEntry?.file ?? "",
        },
      }),
      bom: {
        status: entry?.status ?? "unresolved",
        ...(entry?.footprint !== undefined && { footprint: entry.footprint }),
      },
      pins: p.pins.map((pin) => ({
        number: pin.number,
        name: pin.name,
        type: pin.type,
        ...(pin.net !== undefined && { net: pin.net }),
      })),
      links: partLinks(p, r, drawing.config.sourcing.suppliers),
    };
    const approval = approvals.get(p.path);
    const status = approvalStatus(p, approvals);
    if (approval && status !== "none") {
      (parts[p.path] as PartInfo).approval = { status, by: approval.by, at: approval.at };
    }
  }

  const nets: ViewerModel["nets"] = {};
  for (const n of netlist.nets) {
    nets[n.name] = {
      pins: n.pins.map((p) => `${p.part}.${p.name}`),
      attrs: n.attrs,
      aliases: n.aliases,
    };
  }

  const { errors, warnings } = countIssues(result);
  return {
    project: drawing.config.name,
    top: TOP_BLOCK,
    summary: { errors, warnings, waived: result.waived },
    issues: [...result.issues, ...drawing.issues],
    waivers: result.waivers,
    sheets,
    symbols,
    parts,
    nets,
    comments: review.comments,
    focus: review.focus,
  };
}
