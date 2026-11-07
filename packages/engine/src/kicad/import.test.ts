import { describe, expect, it } from "vitest";
import { buildLibrary, parsePartRecord } from "../parts/library.js";
import { validateProject } from "../validate.js";
import { buildImport, exposeFlags, type ImportInput, parseNetlistForImport } from "./import.js";
import { compareNetlists } from "./netlist.js";
import { readSExpr, type SExpr, writeSExpr } from "./sexpr.js";

interface Comp {
  ref: string;
  part: string;
  uuid: string;
  value?: string;
  footprint?: string;
  sheet?: string;
  fields?: Record<string, string>;
}

const libparts: Record<string, [num: string, name: string, type: string][]> = {
  R: [
    ["1", "", "passive"],
    ["2", "", "passive"],
  ],
  C: [
    ["1", "", "passive"],
    ["2", "", "passive"],
  ],
  OPA1: [
    ["1", "OUT", "output"],
    ["2", "IN-", "input"],
    ["3", "IN+", "input"],
    ["4", "V-", "power_in"],
    ["5", "V+", "power_in"],
    ["6", "NC", "no_connect"],
    ["7", "TRIM", "input"],
  ],
  Conn_01x03: [
    ["1", "Pin_1", "passive"],
    ["2", "Pin_2", "passive"],
    ["3", "Pin_3", "passive"],
  ],
  PWR_FLAG: [["1", "pwr", "power_out"]],
  TestPoint: [["1", "1", "passive"]],
  SolderJumper_2_Open: [
    ["1", "A", "passive"],
    ["2", "B", "passive"],
  ],
};

/** A kicadsexpr netlist as `kicad-cli sch export netlist` writes it, cut down to what import reads. */
function netlist(
  sheets: [names: string, tstamps: string, file: string][],
  comps: Comp[],
  nets: [name: string, nodes: string[]][],
): string {
  const used = new Set(comps.map((c) => c.part));
  const doc: SExpr[] = [
    "export",
    ["version", "E"],
    [
      "design",
      ...sheets.map(
        ([names, tstamps, file]) =>
          [
            "sheet",
            ["name", names],
            ["tstamps", tstamps],
            ["title_block", ["title", "Test board"], ["source", file]],
          ] as SExpr[],
      ),
    ],
    [
      "components",
      ...comps.map(
        (c) =>
          [
            "comp",
            ["ref", c.ref],
            ["value", c.value ?? c.part],
            ["footprint", c.footprint ?? ""],
            [
              "fields",
              ...Object.entries(c.fields ?? {}).map(([k, v]) => ["field", ["name", k], v]),
            ],
            ["libsource", ["lib", "Test"], ["part", c.part]],
            ["sheetpath", ["names", "/"], ["tstamps", c.sheet ?? "/"]],
            ["tstamps", c.uuid],
          ] as SExpr[],
      ),
    ],
    [
      "libparts",
      ...[...used].map(
        (part) =>
          [
            "libpart",
            ["lib", "Test"],
            ["part", part],
            [
              "pins",
              ...(libparts[part] ?? []).map(([num, name, type]) => [
                "pin",
                ["num", num],
                ["name", name],
                ["type", type],
              ]),
            ],
          ] as SExpr[],
      ),
    ],
    [
      "nets",
      ...nets.map(
        ([name, nodes], i) =>
          [
            "net",
            ["code", String(i + 1)],
            ["name", name],
            ...nodes.map((n) => {
              const [ref, pin] = n.split(".");
              return ["node", ["ref", ref as string], ["pin", pin as string]];
            }),
          ] as SExpr[],
      ),
    ],
  ];
  return writeSExpr(doc);
}

const chip = "Resistor_SMD:R_0603_1608Metric";
const disc = "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm";

/** One channel sheet: an op-amp buffer with an input resistor and a decoupling cap. */
const chanParts = (sheet: string, n: string): Comp[] => [
  { ref: `R${n}`, part: "R", uuid: "r1", value: "4,7K", footprint: chip, sheet },
  { ref: `C${n}`, part: "C", uuid: "c1", value: "100n", footprint: disc, sheet },
  { ref: `U${n}`, part: "OPA1", uuid: "u1", sheet },
];

const chan = netlist([["/", "/", "chan.kicad_sch"]], chanParts("/", "1"), [
  ["/IN", ["R1.1"]],
  ["Net-(R1-Pad2)", ["R1.2", "U1.3"]],
  ["/OUT", ["U1.1", "U1.2"]],
  ["GND", ["U1.4", "C1.2"]],
  ["+5V", ["U1.5", "C1.1"]],
  ["unconnected-(U1-TRIM-Pad7)", ["U1.7"]],
]);

/** A header feeding two copies of the channel sheet, with PWR_FLAGs on its supply pins. */
const top = netlist(
  [
    ["/", "/", "top.kicad_sch"],
    ["/CH_A/", "/sa/", "chan.kicad_sch"],
    ["/CH B/", "/sb/", "chan.kicad_sch"],
  ],
  [
    { ref: "J1", part: "Conn_01x03", uuid: "j1", fields: { MPN: "HDR-3" } },
    { ref: "FLAG01", part: "PWR_FLAG", uuid: "f1" },
    { ref: "FLAG02", part: "PWR_FLAG", uuid: "f2" },
    ...chanParts("/sa/", "1"),
    ...chanParts("/sb/", "11"),
  ],
  [
    ["GND", ["J1.3", "FLAG01.1", "U1.4", "C1.2", "U11.4", "C11.2"]],
    ["+5V", ["J1.1", "FLAG02.1", "U1.5", "C1.1", "U11.5", "C11.1"]],
    ["/SIG", ["J1.2", "R1.1", "R11.1"]],
    ["/CH_A/OUT", ["U1.1", "U1.2"]],
    ["/CH B/OUT", ["U11.1", "U11.2"]],
    ["Net-(R1-Pad2)", ["R1.2", "U1.3"]],
    ["Net-(R11-Pad2)", ["R11.2", "U11.3"]],
    ["unconnected-(U1-TRIM-Pad7)", ["U1.7"]],
    ["unconnected-(U11-TRIM-Pad7)", ["U11.7"]],
  ],
);

const record = (id: string, mpn: string, pins: Record<string, [string, string]>) =>
  [
    `id: ${id}`,
    "manufacturer: ACME",
    `preferred_mpn: ${mpn}`,
    `summary: ${id}`,
    "package: X",
    "footprint: Lib:X",
    "pins:",
    ...Object.entries(pins).map(([n, [name, type]]) => `  ${n}: { name: ${name}, type: ${type} }`),
    "provenance: { extracted_by: ai, verified_by: null }",
  ].join("\n");

const library = buildLibrary([
  {
    file: "lib/HDR3.yaml",
    layer: "global",
    text: record("HDR3", "HDR-3", {
      1: ["P1", "passive"],
      2: ["P2", "passive"],
      3: ["P3", "passive"],
    }),
  },
  {
    file: "lib/OPA1.yaml",
    layer: "global",
    text: record("OPA1", "OPA1", {
      1: ["OUT", "output"],
      2: ["IN-", "input"],
      3: ["IN+", "input"],
      4: ["V-", "power_in"],
      5: ["V+", "power_in"],
      6: ["NC", "nc"],
      7: ["TRIM", "input"],
    }),
  },
]).library;

const input = (over: Partial<ImportInput> = {}): ImportInput => ({
  project: "test",
  rootFile: "top.kicad_sch",
  sheets: new Map([
    ["top.kicad_sch", parseNetlistForImport(top)],
    ["chan.kicad_sch", parseNetlistForImport(chan)],
  ]),
  library,
  unconnected: new Set(),
  ...over,
});

/** The imported files as a project, validated. */
function load(x: ReturnType<typeof buildImport>) {
  return validateProject({
    project: { file: "partstyle-project.yaml", text: "name: test\n" },
    circuits: x.circuits,
    parts: [
      ...[...library.values()].map((e) => ({
        file: e.file,
        text: e.text,
        layer: "global" as const,
      })),
      ...x.drafts.map((d) => ({
        file: `parts/${d.id}.yaml`,
        text: d.text,
        layer: "project" as const,
      })),
    ],
    ...(x.annotationLock && { annotation: { file: "annotation.lock", text: x.annotationLock } }),
  });
}

const text = (x: ReturnType<typeof buildImport>, block: string) =>
  x.circuits.find((c) => c.file === `circuit/${block}.ckt`)?.text ?? "";

describe("buildImport", () => {
  it("makes a block per sheet file, with ports where nets cross sheets", () => {
    const x = buildImport(input());
    expect(x.blocks).toEqual(["main", "chan"]);
    expect(text(x, "main")).toBe(
      [
        'block main "Test board"',
        "",
        "use chan as CH_A",
        "use chan as CH_B",
        "",
        "part J1 lib:HDR3",
        "",
        "net +5V : J1.P1 CH_A.+5V CH_B.+5V {source: KiCad PWR_FLAG}",
        "net GND : J1.P3 CH_A.GND CH_B.GND {source: KiCad PWR_FLAG}",
        "net SIG : J1.P2 CH_A.IN CH_B.IN",
        "",
      ].join("\n"),
    );
    expect(text(x, "chan")).toBe(
      [
        'block chan "KiCad sheet chan.kicad_sch"',
        "",
        "port +5V : power_in",
        "port GND : ground",
        "port IN  : passive",
        "",
        "part C1 lib:C_100n",
        "part R1 res(4.7K, 0603)",
        "part U1 lib:OPA1",
        "",
        "net +5V    : C1.1 U1.V+ -> port +5V",
        "net GND    : C1.2 U1.V- -> port GND",
        "net IN     : R1.1 -> port IN",
        "net N_R1_2 : R1.2 U1.IN+",
        "net OUT    : U1.OUT U1.IN-",
        "",
        "nc U1.TRIM @ no-connect flag in KiCad",
        "",
      ].join("\n"),
    );
    // The block has the first copy's KiCad refdes; the second copy's are reserved for it.
    expect(x.annotationLock).toContain("CH_B/R1 R11\n");
    expect(x.annotationLock).not.toContain("CH_A/");
  });

  it("produces a design that elaborates to exactly KiCad's connectivity, refdes and all", () => {
    const x = buildImport(input());
    const result = load(x);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(["part.draft"]);
    expect(result.netlist?.parts.map((p) => p.path).sort()).toEqual(
      ["C1", "C11", "J1", "R1", "R11", "U1", "U11"].sort(),
    );
    const expected = x.expected ?? { refs: new Set<string>(["missing"]), nets: [] };
    expect(
      compareNetlists(result.netlist ?? { parts: [], nets: [], refs: new Map() }, expected),
    ).toEqual([]);
  });

  it("only adds to a project: blocks take free names and the root is never main", () => {
    const x = buildImport(input({ existingBlocks: ["main", "chan"], rootBlock: "test" }));
    expect(x.blocks).toEqual(["test", "chan_2"]);
    expect(text(x, "test")).toMatch(/^block test "Test board"\n\nuse chan_2 as CH_A\n/);
    expect(x.circuits.map((c) => c.file)).toEqual(["circuit/test.ckt", "circuit/chan_2.ckt"]);
  });

  it("imports selected sheets, with nets to the rest as ports", () => {
    const x = buildImport(input({ select: ["CH_A"] }));
    expect(x.blocks).toEqual(["chan"]);
    expect(text(x, "chan")).toContain("port IN  : passive");
    // KiCad's netlist is the whole design's, so a part of it cannot be checked against it.
    expect(x.expected).toBeUndefined();
    expect(buildImport(input({ select: ["chan.kicad_sch"] })).blocks).toEqual(["chan"]);
    expect(() => buildImport(input({ select: ["NOPE"] }))).toThrow(
      "no sheet 'NOPE' (sheets: CH_A, CH B)",
    );
  });

  it("writes draft records that validate, flagged by part.draft", () => {
    const x = buildImport(input());
    expect(x.drafts.map((d) => [d.id, d.users])).toEqual([["C_100n", ["C1"]]]);
    const draft = x.drafts[0]?.text ?? "";
    expect(draft).toContain(`footprint: "${disc}"`);
    expect(draft).toContain('  1: { name: "1", type: passive }');
    const { record, issues } = parsePartRecord(draft, "C_100n.yaml");
    expect(issues).toEqual([]);
    expect(record?.provenance.extracted_by).toBe("kicad");
    expect(record?.preferred_mpn).toBeUndefined();
    expect(x.report.join("\n")).toContain(
      `lib:C_100n (C1): KiCad Test:C, value 100n; footprint ${disc} is not a standard chip footprint`,
    );
    const issue = load(x).issues.find((i) => i.code === "part.draft");
    expect(issue?.message).toMatch(/^lib:C_100n \(C1 C11\) is a draft from KiCad import/);
  });

  it("turns test points and solder jumpers into footprints, not drafts", () => {
    const sheet = netlist(
      [["/", "/", "top.kicad_sch"]],
      [
        { ref: "TP1", part: "TestPoint", uuid: "a1", footprint: "TestPoint:TP_Pad" },
        { ref: "JP1", part: "SolderJumper_2_Open", uuid: "a2", footprint: "Jumper:SJ_Open" },
      ],
      [
        ["N", ["TP1.1", "JP1.1"]],
        ["M", ["JP1.2"]],
      ],
    );
    const x = buildImport(
      input({ sheets: new Map([["top.kicad_sch", parseNetlistForImport(sheet)]]) }),
    );
    expect(x.drafts).toEqual([]);
    expect(text(x, "main")).toContain("part TP1 fp(TestPoint:TP_Pad)");
    expect(text(x, "main")).toContain("part JP1 fp(Jumper:SJ_Open, 2)");
  });

  it("adds footprint pads the symbol lacks to drafts as nc pins", () => {
    const x = buildImport(input({ pads: new Map([[disc, new Set(["1", "2", "3"])]]) }));
    expect(x.drafts[0]?.text).toContain("  3: { name: NC, type: nc }");
  });

  it("does not mark pins KiCad reports unconnected as nc", () => {
    const x = buildImport(input({ unconnected: new Set(["U1.7"]) }));
    expect(text(x, "chan")).not.toMatch(/^nc /m);
    const { unconnected: _, ...withoutErc } = input();
    expect(buildImport(withoutErc).report.join("\n")).toContain("no-connect flags: unknown");
  });

  it("ignores a Spec field: a plain passive comes from its value and footprint", () => {
    const withSpec = netlist(
      [["/", "/", "top.kicad_sch"]],
      [
        {
          ref: "R1",
          part: "R",
          uuid: "r",
          value: "22k",
          footprint: chip,
          fields: { Spec: "res(10k, 1%, 0603)" },
        },
      ],
      [["/A", ["R1.1", "R1.2"]]],
    );
    const x = buildImport(
      input({ sheets: new Map([["top.kicad_sch", parseNetlistForImport(withSpec)]]) }),
    );
    expect(text(x, "main")).toContain("part R1 res(22k, 0603)");
  });

  it("names nets KiCad left unnamed after a pin, and reports them", () => {
    const x = buildImport(input());
    expect(x.report.join("\n")).toContain("1 net had no name in KiCad and is named after a pin");
    expect(x.notes).toContain("- chan: N_R1_2");
  });
});

describe("exposeFlags", () => {
  it("turns PWR_FLAGs into ordinary symbols in the copy KiCad exports", () => {
    const sch = writeSExpr([
      "kicad_sch",
      ["lib_symbols", ["symbol", "power:PWR_FLAG", ["power"], ["pin_names"]]],
      [
        "symbol",
        ["lib_id", "power:PWR_FLAG"],
        ["property", "Reference", "#FLG01"],
        ["instances", ["project", "x", ["path", "/u", ["reference", "#FLG01"]]]],
      ],
      ["symbol", ["lib_id", "power:GND"], ["property", "Reference", "#PWR01"]],
    ]);
    const out = exposeFlags(sch);
    expect(out).not.toContain("#FLG01");
    expect(out).toContain('"FLAGFLG01"');
    expect(out).toContain('"#PWR01"');
    const libSymbol = readSExpr(out)[1] as SExpr[];
    expect(JSON.stringify(libSymbol)).not.toContain('["power"]');
  });
});
