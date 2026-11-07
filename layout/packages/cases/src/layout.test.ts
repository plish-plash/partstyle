import {
  fingerprint,
  layoutBlock,
  measure,
  type ParamDef,
  type Preferences,
  preferenceGroups,
  preferenceOverrides,
  preferenceProblem,
  RULES,
  type RuleOverrides,
} from "@partstyle/layout";
import { describe, expect, it } from "vitest";
import { shuffleInput } from "./builder.js";
import { CASES } from "./cases.js";

describe.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
  const result = layoutBlock(c.input);
  const { metrics, issues } = measure(c.input, result);

  it("has no broken connections or collisions", () => {
    expect(issues.filter((i) => ["opens", "shorts", "unrouted"].includes(i.metric))).toEqual([]);
    expect(issues.filter((i) => ["overlaps", "wiresThroughParts"].includes(i.metric))).toEqual([]);
  });

  it("stays on the grid", () => {
    expect(metrics.offGrid).toBe(0);
  });

  it("points rails up and grounds down", () => {
    expect(metrics.powerWrongWay).toBe(0);
    for (const s of result.power) {
      if (s.role === "ground") expect(s.outward).toBe(270);
      else if (!s.name.startsWith("-")) expect(s.outward).toBe(90);
    }
  });

  it("places every part once", () => {
    expect(result.parts.map((p) => p.id).sort()).toEqual(c.input.parts.map((p) => p.id).sort());
  });

  it("keeps connector rail symbols beside the connector", () => {
    for (const part of result.parts) {
      if (part.kind !== "connector") continue;
      for (const pin of part.pins) {
        const net = c.input.nets.find((n) => n.name === pin.net);
        if (!net || net.role === "signal" || pin.outward === 90 || pin.outward === 270) continue;
        const near = result.power.some(
          (s) =>
            s.net === net.name &&
            s.at.x >= part.box.x - 6 &&
            s.at.x <= part.box.x + part.box.w + 6 &&
            s.at.y >= part.box.y - 6 &&
            s.at.y <= part.box.y + part.box.h + 6,
        );
        expect(near, `${part.ref}.${pin.name}`).toBe(true);
      }
    }
  });

  it("gives flagged nets a marker", () => {
    for (const net of c.input.nets.filter((n) => n.flagged)) {
      expect(result.markers.filter((m) => m.net === net.name)).toHaveLength(1);
    }
  });

  it("dots exactly the points where three or more things meet", () => {
    const key = (net: string, p: { x: number; y: number }) => `${net}@${p.x},${p.y}`;
    const arms = new Map<string, Set<string>>();
    for (const w of result.wires) {
      const dx = Math.sign(w.b.x - w.a.x);
      const dy = Math.sign(w.b.y - w.a.y);
      const steps = Math.abs(w.b.x - w.a.x) + Math.abs(w.b.y - w.a.y);
      for (let i = 0; i < steps; i++) {
        const p = { x: w.a.x + dx * i, y: w.a.y + dy * i };
        const q = { x: p.x + dx, y: p.y + dy };
        arms.set(key(w.net, p), (arms.get(key(w.net, p)) ?? new Set()).add(key("", q)));
        arms.set(key(w.net, q), (arms.get(key(w.net, q)) ?? new Set()).add(key("", p)));
      }
    }
    const counts = new Map([...arms].map(([k, set]) => [k, set.size]));
    for (const { net, at } of [
      ...result.parts.flatMap((p) => p.pins),
      ...result.power,
      ...result.markers,
      ...result.labels,
    ]) {
      if (net !== undefined) counts.set(key(net, at), (counts.get(key(net, at)) ?? 0) + 1);
    }
    const expected = [...counts].filter(([, n]) => n >= 3).map(([k]) => k);
    expect(result.junctions.map((j) => key(j.net, j.at)).sort()).toEqual(expected.sort());
  });

  it("gives the same drawing every time", () => {
    expect(layoutBlock(c.input)).toEqual(result);
  });

  it("leaves IC pin positions alone", () => {
    for (const part of result.parts) {
      if (part.pins.length <= 2) continue;
      expect(part.rotation).toBe(0);
      const source = c.input.parts.find((p) => p.id === part.id);
      const mirror = part.mirror ? -1 : 1;
      for (const pin of part.pins) {
        const local = source?.pins.find((p) => p.id === pin.id);
        expect(pin.at.x).toBe(part.at.x + mirror * (local?.x ?? 0));
        expect(pin.at.y).toBe(part.at.y + (local?.y ?? 0));
      }
    }
  });
});

describe("specific placements", () => {
  const layout = (id: string) => {
    const c = CASES.find((x) => x.id === id);
    if (!c) throw new Error(id);
    return layoutBlock(c.input);
  };
  const pin = (r: ReturnType<typeof layout>, part: string, id: string) => {
    const found = r.parts.find((p) => p.id === part)?.pins.find((p) => p.id === id);
    if (!found) throw new Error(`${part}.${id}`);
    return found;
  };
  const box = (r: ReturnType<typeof layout>, part: string) => {
    const found = r.parts.find((p) => p.id === part);
    if (!found) throw new Error(part);
    return found.box;
  };

  it("stands a flyback diode on the corner above the drain", () => {
    const r = layout("mosfet-switch");
    expect(pin(r, "D1", "1").at.x).toBe(pin(r, "Q1", "D").at.x);
  });

  it("slides source connectors in together and leaves the far column alone", () => {
    const r = layout("mcu-full-qfp");
    expect(box(r, "J5").x + box(r, "J5").w).toBe(box(r, "J4").x + box(r, "J4").w);
    expect(box(r, "J1").x).toBe(box(r, "J2").x);
    expect(box(r, "J1").x).toBe(box(r, "J3").x);
    expect(box(r, "U1").x - (box(r, "J5").x + box(r, "J5").w)).toBeLessThan(16);
  });

  it("runs the step straight into the first resistor of a stepped group", () => {
    const r = layout("mcu-full-qfp");
    const net = pin(r, "R10", "1");
    expect(r.wires.filter((w) => w.net === net.net).length).toBeLessThanOrEqual(2);
    const lefts = ["R10", "R9", "R8"].map((id) => box(r, id).x);
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  });
});

describe("symbol definitions", () => {
  it("lays upright and horizontal two-terminal symbols out alike", () => {
    const upright = CASES.find((c) => c.id === "sheet-upright-symbols");
    if (!upright) throw new Error("case");
    const flat = {
      ...upright.input,
      parts: upright.input.parts.map((p) => {
        const span = Math.abs((p.pins[1]?.y ?? 0) - (p.pins[0]?.y ?? 0));
        return {
          ...p,
          box: { x: 0, y: -1, w: span, h: 2 },
          pins: p.pins.map((q, i) => ({
            ...q,
            x: i === 0 ? 0 : span,
            y: 0,
            outward: (i === 0 ? 180 : 0) as 0 | 180,
          })),
        };
      }),
    };
    const pinsOf = (r: ReturnType<typeof layoutBlock>) =>
      r.parts.flatMap((p) => p.pins.map((q) => `${p.id}.${q.id} ${q.at.x},${q.at.y}`)).sort();
    expect(pinsOf(layoutBlock(upright.input))).toEqual(pinsOf(layoutBlock(flat)));
  });
});

describe("group packing", () => {
  it("is not much taller than wide", () => {
    const c = CASES.find((x) => x.id === "sheet-disconnected-groups");
    if (!c) throw new Error("case");
    const r = layoutBlock(c.input);
    expect(r.bounds.h).toBeLessThan(r.bounds.w * 1.1);
  });
});

describe("declaration order", () => {
  const seeds = Array.from({ length: 12 }, (_, i) => i + 1);

  it("shuffling keeps the same circuit and is repeatable", () => {
    for (const c of CASES) {
      const once = shuffleInput(c.input, 3);
      expect(once).toEqual(shuffleInput(c.input, 3));
      expect(once.parts.map((p) => p.id).sort()).toEqual(c.input.parts.map((p) => p.id).sort());
    }
  });

  it.each(seeds)("shuffle %i keeps every case intact", (seed) => {
    for (const c of CASES) {
      const input = shuffleInput(c.input, seed);
      const { metrics, issues } = measure(input, layoutBlock(input));
      expect(metrics.hardFailures, `${c.id}: ${issues.map((i) => i.message).join("; ")}`).toBe(0);
    }
  });
});

describe("every rule", () => {
  const drawn = (c: (typeof CASES)[number], overrides: RuleOverrides) => {
    return fingerprint(layoutBlock(c.input, overrides));
  };

  it.each(RULES.map((r) => r.id))("%s changes at least one case when turned off", (id) => {
    const changed = CASES.filter((c) => drawn(c, {}) !== drawn(c, { [id]: { enabled: false } }));
    expect(changed.length).toBeGreaterThan(0);
  });
});

describe("preferences", () => {
  const params = preferenceGroups().flatMap((g) => g.params.map((p) => [g.rule, p] as const));
  const set = (entries: (readonly [string, string, number | string])[]): RuleOverrides => {
    const prefs: Preferences = {};
    for (const [rule, key, value] of entries) prefs[rule] = { ...prefs[rule], [key]: value };
    return preferenceOverrides(prefs);
  };
  const ends = (p: ParamDef): (number | string)[] =>
    p.type === "number" ? [p.min, p.max] : p.type === "enum" ? p.options : [];

  it.each(params.map(([rule, p]) => [`${rule}.${p.key}`, rule, p] as const))(
    "%s changes at least one case",
    (_name, rule, p) => {
      const changed = CASES.filter((c) =>
        ends(p).some(
          (v) =>
            fingerprint(layoutBlock(c.input, set([[rule, p.key, v]]))) !==
            fingerprint(layoutBlock(c.input)),
        ),
      );
      expect(changed.length).toBeGreaterThan(0);
    },
  );

  it.each([0, 1])("keeps every case intact with all of them at one extreme (%i)", (end) => {
    const overrides = set(
      params.map(([rule, p]) => [rule, p.key, ends(p)[end] as number | string]),
    );
    for (const c of CASES) {
      const { metrics, issues } = measure(c.input, layoutBlock(c.input, overrides));
      expect(metrics.hardFailures, `${c.id}: ${issues.map((i) => i.message).join("; ")}`).toBe(0);
    }
  });

  it("refuses anything that is not a preference, or out of range", () => {
    expect(preferenceProblem("label-fallback", "detourLimit", 40)).toBeUndefined();
    expect(preferenceProblem("decoupling-near-pin", "side", "below")).toBeUndefined();
    expect(preferenceProblem("label-fallback", "detourLimit", 81)).toContain("from 4 to 80");
    expect(preferenceProblem("shunt-hang", "spacing", 4.5)).toContain("steps of 1");
    expect(preferenceProblem("decoupling-near-pin", "side", "left")).toContain("one of");
    expect(preferenceProblem("route-costs", "ripupPasses", 2)).toContain("not a layout");
    expect(preferenceProblem("min-crossings", "sweeps", 2)).toContain("not a layout");
    expect(preferenceProblem("chain-rows", "endStyle", "inline")).toContain("not a layout");
  });
});

describe("labels", () => {
  // A low limit turns as many nets as possible into labels.
  const overrides = { "label-fallback": { params: { crossingLimit: 1, detourLimit: 4 } } };

  it.each(CASES.map((c) => [c.id, c] as const))("%s keeps label stubs short", (_id, c) => {
    const r = layoutBlock(c.input, overrides);
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const stops = new Set(r.junctions.map((j) => key(j.at)));
    for (const part of r.parts) for (const p of part.pins) stops.add(key(p.at));
    for (const label of r.labels.filter((l) => l.kind === "local")) {
      // Walk back along the stub to the pin or wire it leaves: at most one corner.
      let at = label.at;
      let from: { x: number; y: number } | undefined;
      let segments = 0;
      while (!stops.has(key(at))) {
        const next = r.wires.find(
          (w) =>
            w.net === label.net &&
            (key(w.a) === key(at) || key(w.b) === key(at)) &&
            (from === undefined || (key(w.a) !== key(from) && key(w.b) !== key(from))),
        );
        if (!next) break;
        segments++;
        from = at;
        at = key(next.a) === key(at) ? next.b : next.a;
      }
      expect([label.text, segments <= 2]).toEqual([label.text, true]);
    }
  });
});

describe("every rule setting", () => {
  const settings: [string, RuleOverrides][] = [];
  for (const rule of RULES) {
    settings.push([`${rule.id} off`, { [rule.id]: { enabled: false } }]);
    for (const p of rule.params) {
      if (p.type === "number") {
        settings.push([`${rule.id}.${p.key}=min`, { [rule.id]: { params: { [p.key]: p.min } } }]);
        settings.push([`${rule.id}.${p.key}=max`, { [rule.id]: { params: { [p.key]: p.max } } }]);
      } else if (p.type === "boolean") {
        const params = { [p.key]: !p.default };
        settings.push([`${rule.id}.${p.key} flipped`, { [rule.id]: { params } }]);
      } else {
        for (const option of p.options) {
          const params = { [p.key]: option };
          settings.push([`${rule.id}.${p.key}=${option}`, { [rule.id]: { params } }]);
        }
      }
    }
  }

  it.each(settings)("%s keeps every case intact", (_name, overrides) => {
    for (const c of CASES) {
      const r = layoutBlock(c.input, overrides);
      expect(r.parts.length).toBe(c.input.parts.length);
      const { metrics, issues } = measure(c.input, r);
      expect(metrics.hardFailures, `${c.id}: ${issues.map((i) => i.message).join("; ")}`).toBe(0);
    }
  });
});
