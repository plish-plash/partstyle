import type {
  LayoutResult,
  MetricIssue,
  Metrics,
  ParamValue,
  RuleConfig,
  RuleOverrides,
} from "@partstyle/layout";
import * as engine from "@partstyle/layout";
import type { Category, TestCase } from "@partstyle/layout-cases";
import { CASES, shuffleInput } from "@partstyle/layout-cases";

export interface CaseRun {
  result?: LayoutResult;
  metrics?: Metrics;
  issues: MetricIssue[];
  error?: string;
  ms: number;
  /** Identifies the drawing, to spot which cases a change touched. */
  print: string;
}

export type CompareRun = Pick<CaseRun, "result" | "metrics" | "print">;
export type View = "case" | "gallery" | "compare";
export type Verdict = "good" | "needs-work" | "bad";

export interface Note {
  verdict?: Verdict;
  note: string;
  updatedAt?: string;
  /** What was changed in response to the last note. */
  resolved?: string;
  /** Identifies the drawing that was judged. */
  print?: string;
  shuffle?: number;
}

/** A short stand-in for a drawing, small enough to keep with each note. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

interface Baseline {
  name: string;
  createdAt: string;
  rules: RuleOverrides;
  cases: Record<string, CompareRun>;
}

let lib = engine;
let shuffle = shuffleInput;
let cases = $state.raw<TestCase[]>(CASES);

function run(c: TestCase, overrides: RuleOverrides, seed: number): CaseRun {
  const start = performance.now();
  try {
    const input = shuffle(c.input, seed);
    const result = lib.layoutBlock(input, overrides);
    const { metrics, issues } = lib.measure(input, result);
    return {
      result,
      metrics,
      issues,
      ms: performance.now() - start,
      print: lib.fingerprint(result),
    };
  } catch (e) {
    return { issues: [], error: String(e), ms: 0, print: `error:${String(e)}` };
  }
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let overrides: RuleOverrides = {};
  try {
    overrides = JSON.parse(p.get("rules") ?? "{}");
  } catch {
    overrides = {};
  }
  const seed = Number(p.get("shuffle") ?? 0);
  return {
    id: p.get("case"),
    view: p.get("view") as View | null,
    overrides,
    seed: Number.isInteger(seed) ? seed : 0,
  };
}

class Tester {
  ruleDefs = $state.raw(lib.RULES);
  rules = $state<RuleConfig>(lib.defaultRules());
  caseId = $state(CASES[0]?.id ?? "");
  view = $state<View>("case");
  runs = $state.raw(new Map<string, CaseRun>());
  /** Results before the last code reload. */
  previous = $state.raw(new Map<string, CaseRun>());
  defaults = $state.raw(new Map<string, CaseRun>());
  /** Current rules, in the order the case was written. */
  declared = $state.raw(new Map<string, CaseRun>());
  /** Which shuffle of the declaration order is showing; 0 is as written. */
  seed = $state(0);
  reloads = $state(0);
  lastReload = $state<string | null>(null);

  compareTo = $state("previous");
  baselines = $state<string[]>([]);
  presets = $state<string[]>([]);
  loadedBaseline = $state.raw<Baseline | null>(null);
  notes = $state<Record<string, Note>>({});
  status = $state("");

  overlays = $state({ grid: true, columns: false, roles: false, text: true });
  selectedPart = $state<string | null>(null);
  hoverNet = $state<string | null>(null);

  constructor() {
    const h = readHash();
    if (h.id && CASES.some((c) => c.id === h.id)) this.caseId = h.id;
    if (h.view) this.view = h.view;
    this.seed = h.seed;
    this.rules = lib.resolveRules(h.overrides);
    this.recompute();
    this.defaults = this.computeAll({}, 0);
    this.previous = this.runs;
    void this.loadLists();
  }

  get cases() {
    return cases;
  }

  get current(): TestCase | undefined {
    return cases.find((c) => c.id === this.caseId);
  }

  get run(): CaseRun | undefined {
    return this.runs.get(this.caseId);
  }

  get overrides(): RuleOverrides {
    return lib.diffRules($state.snapshot(this.rules));
  }

  get changedRuleCount() {
    return Object.keys(this.overrides).length;
  }

  get grouped(): [Category, TestCase[]][] {
    const groups = new Map<Category, TestCase[]>();
    for (const c of cases) {
      const list = groups.get(c.category) ?? [];
      list.push(c);
      groups.set(c.category, list);
    }
    return [...groups.entries()];
  }

  /** What the current results are measured against. */
  get reference(): { label: string; get: (id: string) => CompareRun | undefined } {
    if (this.compareTo === "previous") {
      return { label: "Before last reload", get: (id) => this.previous.get(id) };
    }
    if (this.compareTo === "defaults") {
      return { label: "Default rules", get: (id) => this.defaults.get(id) };
    }
    if (this.compareTo === "declared") {
      return { label: "As declared", get: (id) => this.declared.get(id) };
    }
    const b = this.loadedBaseline;
    return { label: b ? `Baseline ${b.name}` : "Baseline", get: (id) => b?.cases[id] };
  }

  isChanged(id: string): boolean {
    const now = this.runs.get(id);
    const then = this.reference.get(id);
    return now !== undefined && then !== undefined && then.print !== now.print;
  }

  /** Whether the layout differs from the one that was judged, so the verdict may be out of date. */
  isStale(id: string): boolean {
    const n = this.notes[id];
    const now = this.runs.get(id);
    if (!n?.verdict || !n.print || !now || (n.shuffle ?? 0) !== this.seed) return false;
    return n.print !== hash(now.print);
  }

  private computeAll(overrides: RuleOverrides, seed: number) {
    const out = new Map<string, CaseRun>();
    for (const c of cases) out.set(c.id, run(c, overrides, seed));
    return out;
  }

  recompute() {
    this.runs = this.computeAll(this.overrides, this.seed);
    this.declared = this.seed === 0 ? this.runs : this.computeAll(this.overrides, 0);
    this.syncHash();
  }

  shuffle() {
    this.seed += 1;
    if (this.compareTo === "previous") void this.setCompare("declared");
    this.recompute();
  }

  unshuffle() {
    this.seed = 0;
    this.recompute();
  }

  /** New engine code arrived: keep the old results for comparison and rerun everything. */
  onReload() {
    this.previous = this.runs;
    this.ruleDefs = lib.RULES;
    this.rules = lib.resolveRules(this.overrides);
    this.reloads += 1;
    this.lastReload = new Date().toLocaleTimeString();
    this.recompute();
    this.defaults = this.computeAll({}, 0);
  }

  private syncHash() {
    const p = new URLSearchParams();
    p.set("case", this.caseId);
    p.set("view", this.view);
    const o = this.overrides;
    if (Object.keys(o).length > 0) p.set("rules", JSON.stringify(o));
    if (this.seed !== 0) p.set("shuffle", String(this.seed));
    history.replaceState(null, "", `#${p.toString()}`);
  }

  select(id: string) {
    this.caseId = id;
    this.selectedPart = null;
    if (this.view === "gallery") this.view = "case";
    this.syncHash();
  }

  setView(v: View) {
    this.view = v;
    this.syncHash();
  }

  step(by: number) {
    const list = this.grouped.flatMap(([, l]) => l);
    const i = list.findIndex((c) => c.id === this.caseId);
    const next = list[(i + by + list.length) % list.length];
    if (next) this.select(next.id);
  }

  setEnabled(id: string, on: boolean) {
    const r = this.rules[id];
    if (r) r.enabled = on;
    this.recompute();
  }

  setParam(id: string, key: string, value: ParamValue) {
    const r = this.rules[id];
    if (r) r.params[key] = value;
    this.recompute();
  }

  resetRules() {
    this.rules = lib.defaultRules();
    this.recompute();
  }

  async loadLists() {
    try {
      const [baselines, presets, feedback] = await Promise.all([
        fetch("/api/baselines").then((r) => r.json()),
        fetch("/api/presets").then((r) => r.json()),
        fetch("/api/feedback").then((r) => r.json()),
      ]);
      this.baselines = baselines;
      this.presets = presets;
      this.notes = feedback.cases ?? {};
    } catch (e) {
      this.status = `Could not reach the dev server: ${e}`;
    }
  }

  async setCompare(target: string) {
    this.compareTo = target;
    if (target !== "previous" && target !== "defaults" && target !== "declared") {
      const res = await fetch(`/api/baselines/${encodeURIComponent(target)}`);
      if (res.ok) this.loadedBaseline = await res.json();
    }
  }

  private flash(message: string) {
    this.status = message;
    setTimeout(() => {
      if (this.status === message) this.status = "";
    }, 3000);
  }

  async saveBaseline(name: string) {
    const body: Baseline = {
      name,
      createdAt: new Date().toISOString(),
      rules: this.overrides,
      cases: Object.fromEntries(
        [...this.runs].map(([id, r]) => [
          id,
          {
            ...(r.result ? { result: r.result } : {}),
            ...(r.metrics ? { metrics: r.metrics } : {}),
            print: r.print,
          },
        ]),
      ),
    };
    const res = await fetch(`/api/baselines/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!res.ok) return this.flash("Names can use letters, digits, - and _");
    await this.loadLists();
    await this.setCompare(name);
    this.flash(`Saved baseline ${name}`);
  }

  async savePreset(name: string) {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(this.overrides),
    });
    if (!res.ok) return this.flash("Names can use letters, digits, - and _");
    await this.loadLists();
    this.flash(`Saved preset ${name}`);
  }

  async loadPreset(name: string) {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    this.rules = lib.resolveRules(await res.json());
    this.recompute();
  }

  async saveNote(verdict: Verdict | undefined, note: string) {
    const r = this.run;
    const res = await fetch("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        caseId: this.caseId,
        verdict,
        note,
        rules: this.overrides,
        metrics: r?.metrics,
        snapshot: r?.result,
        ...(r ? { print: hash(r.print) } : {}),
        ...(this.seed !== 0 ? { shuffle: this.seed } : {}),
      }),
    });
    if (res.ok) {
      this.notes = (await res.json()).cases;
      this.flash("Saved");
    } else {
      this.flash("Could not save");
    }
  }
}

export const app = new Tester();

if (import.meta.hot) {
  import.meta.hot.accept(["@partstyle/layout", "@partstyle/layout-cases"], ([e, c]) => {
    if (e) lib = e as unknown as typeof engine;
    if (c) {
      const module = c as unknown as { CASES: TestCase[]; shuffleInput: typeof shuffleInput };
      cases = module.CASES;
      shuffle = module.shuffleInput;
    }
    app.onReload();
  });
  import.meta.hot.on("tester:notes", () => {
    void app.loadLists();
  });
}
