import { z } from "zod";
import type { Issue, Location } from "../diagnostics.js";
import { type FlatPart, type Netlist, splitRef } from "../netlist/elaborate.js";

/**
 * The parts of the design context the engine reads. External interfaces are the person's
 * statement of what the outside world does at each connector: context for the AI and for design
 * review, which judge the hazards. The engine only checks that they name a real connector.
 */
const ContextSchema = z.looseObject({
  environment: z.looseObject({ temp_c: z.tuple([z.number(), z.number()]).optional() }).optional(),
  external_interfaces: z
    .array(
      z.looseObject({
        connector: z.string(),
        connects_to: z.string().optional(),
        signal: z.string().optional(),
        hazards: z
          .array(
            z.union([
              z.string(),
              z.looseObject({ hazard: z.string(), accepted: z.string().optional() }),
            ]),
          )
          .default([]),
      }),
    )
    .default([]),
});

/**
 * Checks against the design context in the project file (`data`, its parsed YAML): the operating
 * temperature range, and that each external interface names a part.
 */
export function contextChecks(
  netlist: Netlist,
  data: Record<string, unknown>,
  file: string,
): Issue[] {
  const location: Location = { file, line: 1, col: 1 };
  const issue = (code: string, message: string, subjects: string[]): Issue => ({
    code,
    severity: "warning",
    message,
    location,
    subjects,
  });
  const parsed = ContextSchema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return [
      issue(
        "context.invalid",
        `design context: ${first ? `${first.path.join(".")}: ${first.message}` : "invalid"}; its checks were skipped`,
        [],
      ),
    ];
  }
  const ctx = parsed.data;
  const issues: Issue[] = [];
  for (const { connector } of ctx.external_interfaces) {
    // A refdes (J1), or one qualified by its instance path (PWR/J1), which must agree.
    const slash = connector.lastIndexOf("/");
    const ref = connector.slice(slash + 1);
    const prefix = slash === -1 ? undefined : connector.slice(0, slash + 1);
    const part = netlist.parts.find((p) => p.path === ref);
    if (part && (prefix === undefined || part.prefix === prefix)) continue;
    // The project file is written first: say nothing until the design has parts like it (in
    // the instance it names, if it names one).
    const [letters] = splitRef(ref);
    const like = netlist.parts.some((p) =>
      prefix === undefined ? splitRef(p.path)[0] === letters : p.prefix === prefix,
    );
    if (!like) continue;
    issues.push(
      issue(
        "context.unknown-connector",
        `external interface ${connector} is not a part in the design (name its refdes, e.g. J1)`,
        [connector],
      ),
    );
  }

  // Operating temperature, per record in use.
  const temp = ctx.environment?.temp_c;
  const users = new Map<string, { part: FlatPart; paths: string[] }>();
  for (const p of netlist.parts) {
    if (!p.record) continue;
    const u = users.get(p.record.id) ?? { part: p, paths: [] };
    u.paths.push(p.path);
    users.set(p.record.id, u);
  }
  if (temp) {
    const [lo, hi] = temp;
    for (const [id, u] of users) {
      const range = u.part.record?.temp_c;
      if (!range || (range[0] <= lo && range[1] >= hi)) continue;
      issues.push(
        issue(
          "context.temperature",
          `lib:${id} (${u.paths.join(" ")}) is rated ${range[0]} to ${range[1]} °C; the environment needs ${lo} to ${hi} °C`,
          [id, ...u.paths],
        ),
      );
    }
  }
  return issues;
}
