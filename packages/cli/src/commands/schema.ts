import { partRecordJsonSchema } from "@partstyle/engine";
import type { CommandResult } from "./types.js";

const schemas: Record<string, () => unknown> = {
  part: partRecordJsonSchema,
};

export function schemaCommand(name: string | undefined): CommandResult {
  const make = name === undefined ? undefined : schemas[name];
  if (!make) {
    return {
      stdout: "",
      stderr: `usage: partstyle schema <${Object.keys(schemas).join("|")}>`,
      exitCode: 2,
    };
  }
  return { stdout: JSON.stringify(make(), null, 2), exitCode: 0 };
}
