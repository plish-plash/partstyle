export type ParamValue = number | boolean | string;

export type ParamDef = (
  | {
      key: string;
      label: string;
      type: "number";
      min: number;
      max: number;
      step: number;
      default: number;
    }
  | { key: string; label: string; type: "boolean"; default: boolean }
  | { key: string; label: string; type: "enum"; options: string[]; default: string }
) & {
  /**
   * Marks a parameter as a visual preference that end users may adjust, as a sentence explaining
   * it to them. Leave it out of anything that turns behaviour on or off or sets a number of passes.
   */
  preference?: string;
};

export interface RuleDef {
  id: string;
  title: string;
  description: string;
  group: "Flow" | "Placement" | "Power" | "Wiring";
  enabled: boolean;
  params: ParamDef[];
}

/**
 * Every layout rule. The tester builds its controls from this list, so a rule added here appears
 * there with no UI work.
 */
export const RULES: RuleDef[] = [
  {
    id: "signal-left-right",
    title: "Signal flows left to right",
    description:
      "Places sources left of sinks, judged by pin type (output, input) and port direction. It decides only where IC pin sides do not, such as a chain of passives. Off: declaration order decides.",
    group: "Flow",
    enabled: true,
    params: [],
  },
  {
    id: "follow-pin-side",
    title: "Follow the pin side",
    description:
      "A part joins the side of an IC its pin faces, so parts surround an MCU instead of queuing on one side.",
    group: "Flow",
    enabled: true,
    params: [],
  },
  {
    id: "min-crossings",
    title: "Minimize crossings",
    description:
      "Orders parts within each column by the average height of what they connect to, using the fixed pin order.",
    group: "Flow",
    enabled: true,
    params: [
      { key: "sweeps", label: "Sweeps", type: "number", min: 1, max: 12, step: 1, default: 4 },
    ],
  },
  {
    id: "straighten-wires",
    title: "Straighten wires",
    description:
      "Moves each part vertically so as many of its wires as possible run straight from the previous column.",
    group: "Placement",
    enabled: true,
    params: [
      {
        key: "maxShift",
        label: "Max shift",
        type: "number",
        min: 0,
        max: 60,
        step: 1,
        default: 30,
        preference: "How far a part may move up or down to straighten its wires.",
      },
    ],
  },
  {
    id: "shunt-hang",
    title: "Shunts hang from their wire",
    description:
      "A part from a wire to ground hangs below it; one to a rail stands above it. Off: shunts are set aside in a row under the block.",
    group: "Placement",
    enabled: true,
    params: [
      {
        key: "spacing",
        label: "Column spacing",
        type: "number",
        min: 3,
        max: 10,
        step: 1,
        default: 5,
        preference: "The distance between neighbouring parts hanging from a wire.",
      },
      { key: "pairStacks", label: "Stack up/down pairs", type: "boolean", default: true },
    ],
  },
  {
    id: "chain-rows",
    title: "Series chains",
    description:
      "Treats parts in a row that end at a rail, such as a resistor and LED, as one unit. Hang: a vertical column off the wire, stepped so wires do not cross. Inline: a horizontal row ending in the power symbol. Off: the resistor sits in line with the wire and only the LED hangs.",
    group: "Placement",
    enabled: true,
    params: [
      {
        key: "endStyle",
        label: "End style",
        type: "enum",
        options: ["hang", "inline"],
        default: "hang",
      },
      {
        key: "rowPitch",
        label: "Row pitch",
        type: "number",
        min: 3,
        max: 10,
        step: 1,
        default: 4,
        preference: "The smallest distance between neighbouring rows of wires.",
      },
    ],
  },
  {
    id: "align-hangers",
    title: "Line up hanging parts",
    description:
      "Matching parts hanging from neighbouring rows sit level with each other, on stems of different lengths, instead of following the pins in a staircase.",
    group: "Placement",
    enabled: true,
    params: [],
  },
  {
    id: "pack-groups",
    title: "Pack separate groups",
    description:
      "Parts that share only rails form separate groups. These sort by size and fill rows, so declaration order does not change the arrangement. Off: they stack in one column in declaration order.",
    group: "Placement",
    enabled: true,
    params: [
      {
        key: "aspect",
        label: "Width / height",
        type: "number",
        min: 0.5,
        max: 3,
        step: 0.1,
        default: 1.4,
        preference: "The shape separate groups of parts pack into. Higher is wider.",
      },
      {
        key: "gap",
        label: "Gap",
        type: "number",
        min: 2,
        max: 12,
        step: 1,
        default: 5,
        preference: "The space between separate groups of parts.",
      },
    ],
  },
  {
    id: "decoupling-near-pin",
    title: "Decoupling near the IC",
    description:
      "Rail-to-ground parts go in the nearest empty space to the IC whose rail they share, placed last so they never push anything aside. Side sets which side they prefer. Off: they collect in a row under the block.",
    group: "Placement",
    enabled: true,
    params: [
      {
        key: "side",
        label: "Side",
        type: "enum",
        options: ["above", "below"],
        default: "above",
        preference: "Which side of the part they serve decoupling capacitors prefer.",
      },
      {
        key: "spacing",
        label: "Spacing",
        type: "number",
        min: 3,
        max: 10,
        step: 1,
        default: 5,
        preference: "The distance between decoupling capacitors.",
      },
    ],
  },
  {
    id: "power-top-bottom",
    title: "Power flows top to bottom",
    description:
      "Puts the rail end of a vertical part on top and the ground end at the bottom. Off: every shunt hangs below its wire.",
    group: "Power",
    enabled: true,
    params: [],
  },
  {
    id: "local-power-symbols",
    title: "Local power symbols",
    description:
      "Draws a rail or ground symbol at each connected pin instead of wiring the rail. Rails always point up, grounds down.",
    group: "Power",
    enabled: true,
    params: [
      { key: "shareAdjacent", label: "Share adjacent pins", type: "boolean", default: true },
    ],
  },
  {
    id: "negative-rails",
    title: "Negative rails point down",
    description:
      "Rails below ground, such as -15V, hang their symbols downward. A symbol on a part's top pin may still point up, as on a capacitor between ground and the rail. Off: they point up like any other rail.",
    group: "Power",
    enabled: true,
    params: [],
  },
  {
    id: "power-risers",
    title: "Power risers from side pins",
    description:
      "A rail or ground pin on the side of a part runs straight up or down to a symbol just past the part, crossing other pin wires if it must. These crossings do not count against the layout. Off: the symbol sits on a short row beside the pin, and rows are spread to fit it.",
    group: "Power",
    enabled: true,
    params: [
      {
        key: "gap",
        label: "Gap past part",
        type: "number",
        min: 0,
        max: 6,
        step: 1,
        default: 1,
        preference: "How far past a part the power symbol of a side pin sits.",
      },
    ],
  },
  {
    id: "route-costs",
    title: "Wire routing weights",
    description:
      "Costs the grid router trades off. Fork off corner is the extra cost of branching partway along a wire instead of carrying on straight from a corner, so higher values gather junctions on corners. Off: plain shortest paths, one pass.",
    group: "Wiring",
    enabled: true,
    params: [
      {
        key: "bend",
        label: "Bend",
        type: "number",
        min: 0,
        max: 30,
        step: 1,
        default: 4,
        preference: "How strongly wires avoid corners.",
      },
      {
        key: "crossing",
        label: "Crossing",
        type: "number",
        min: 0,
        max: 60,
        step: 1,
        default: 8,
        preference: "How strongly wires avoid crossing. Higher values allow longer routes.",
      },
      {
        key: "fork",
        label: "Fork off corner",
        type: "number",
        min: 0,
        max: 12,
        step: 1,
        default: 3,
        preference: "How strongly a branch starts at a corner rather than partway along a wire.",
      },
      {
        key: "clearance",
        label: "Near parts",
        type: "number",
        min: 0,
        max: 10,
        step: 1,
        default: 1,
        preference: "How strongly wires keep away from parts.",
      },
      {
        key: "ripupPasses",
        label: "Rip-up passes",
        type: "number",
        min: 0,
        max: 5,
        step: 1,
        default: 1,
      },
    ],
  },
  {
    id: "label-fallback",
    title: "Net labels for tangled nets",
    description:
      "A net is drawn with labels instead when its wires would cross too many others or wander far out of their way. Off: every net stays a wire.",
    group: "Wiring",
    enabled: true,
    params: [
      {
        key: "crossingLimit",
        label: "Crossing limit",
        type: "number",
        min: 1,
        max: 12,
        step: 1,
        default: 3,
        preference: "How many wires a net may cross before it is drawn with labels.",
      },
      {
        key: "detourLimit",
        label: "Detour limit",
        type: "number",
        min: 4,
        max: 80,
        step: 2,
        default: 20,
        preference: "How far out of its way a net may run before it is drawn with labels.",
      },
    ],
  },
];

export interface RuleState {
  enabled: boolean;
  params: Record<string, ParamValue>;
}

export type RuleConfig = Record<string, RuleState>;
/** A partial override: unnamed rules and parameters keep their defaults. */
export type RuleOverrides = Record<
  string,
  { enabled?: boolean; params?: Record<string, ParamValue> }
>;

export function defaultRules(): RuleConfig {
  const out: RuleConfig = {};
  for (const r of RULES) {
    out[r.id] = {
      enabled: r.enabled,
      params: Object.fromEntries(r.params.map((p) => [p.key, p.default])),
    };
  }
  return out;
}

export function resolveRules(overrides: RuleOverrides = {}): RuleConfig {
  const out = defaultRules();
  for (const [id, o] of Object.entries(overrides)) {
    const r = out[id];
    if (!r) continue;
    if (o.enabled !== undefined) r.enabled = o.enabled;
    if (o.params) {
      for (const [k, v] of Object.entries(o.params)) if (k in r.params) r.params[k] = v;
    }
  }
  return out;
}

/** The difference from the defaults, for short URLs and presets. */
export function diffRules(config: RuleConfig): RuleOverrides {
  const base = defaultRules();
  const out: RuleOverrides = {};
  for (const [id, r] of Object.entries(config)) {
    const b = base[id];
    if (!b) continue;
    const params = Object.fromEntries(
      Object.entries(r.params).filter(([k, v]) => b.params[k] !== v),
    );
    const changed = Object.keys(params).length > 0;
    if (r.enabled !== b.enabled || changed) {
      out[id] = {
        ...(r.enabled !== b.enabled ? { enabled: r.enabled } : {}),
        ...(changed ? { params } : {}),
      };
    }
  }
  return out;
}

/** Saved preferences: values by rule id, then parameter key. */
export type Preferences = Record<string, Record<string, number | string>>;

export interface PreferenceGroup {
  rule: string;
  title: string;
  params: ParamDef[];
}

/** The parameters end users may adjust, by rule. */
export function preferenceGroups(): PreferenceGroup[] {
  return RULES.flatMap((r) => {
    const params = r.params.filter((p) => p.preference !== undefined);
    return params.length > 0 ? [{ rule: r.id, title: r.title, params }] : [];
  });
}

/** Why a preference cannot be set to this value, if it cannot. */
export function preferenceProblem(rule: string, key: string, value: unknown): string | undefined {
  const param = preferenceGroups()
    .find((g) => g.rule === rule)
    ?.params.find((p) => p.key === key);
  if (!param) return "is not a layout preference";
  if (param.type === "enum") {
    return param.options.includes(value as string)
      ? undefined
      : `must be one of ${param.options.join(", ")}`;
  }
  if (param.type === "number") {
    const n = typeof value === "number" ? value : Number.NaN;
    const steps = (n - param.min) / param.step;
    return n >= param.min && n <= param.max && Math.abs(steps - Math.round(steps)) < 1e-9
      ? undefined
      : `must be from ${param.min} to ${param.max} in steps of ${param.step}`;
  }
  return "is not a layout preference";
}

/** Saved preferences as rule overrides, for `layoutBlock`. */
export const preferenceOverrides = (prefs: Preferences): RuleOverrides =>
  Object.fromEntries(Object.entries(prefs).map(([rule, params]) => [rule, { params }]));

export class Rules {
  constructor(readonly config: RuleConfig) {}
  on(id: string): boolean {
    return this.config[id]?.enabled ?? false;
  }
  num(id: string, key: string): number {
    return this.config[id]?.params[key] as number;
  }
  bool(id: string, key: string): boolean {
    return this.config[id]?.params[key] as boolean;
  }
  str(id: string, key: string): string {
    return this.config[id]?.params[key] as string;
  }
}
