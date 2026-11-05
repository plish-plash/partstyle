import type { Issue } from "../diagnostics.js";
import { type FlatNet, type FlatPin, isOpenByDesign, type Netlist } from "../netlist/elaborate.js";
import type { PinType } from "../parts/schema.js";

const drivers: ReadonlySet<PinType> = new Set(["output", "power_out"]);
const signalSources: ReadonlySet<PinType> = new Set([
  "output",
  "power_out",
  "bidir",
  "tristate",
  "passive",
  "open_collector",
  "open_emitter",
]);

function pinLabel(pin: FlatPin): string {
  return `${pin.part}.${pin.name}`;
}

function pinSubjects(pin: FlatPin): string[] {
  return [`${pin.part}.${pin.name}`, `${pin.part}.${pin.number}`, pin.part];
}

function netIssue(
  net: FlatNet,
  code: string,
  severity: Issue["severity"],
  message: string,
  pins: FlatPin[] = [],
): Issue {
  return {
    code,
    severity,
    message: `${net.name}: ${message}`,
    location: net.location,
    subjects: [...net.aliases, ...pins.flatMap(pinSubjects)],
  };
}

/** Structural ERC over the flattened netlist. Port usage is checked during elaboration. */
export function runErc(netlist: Netlist): Issue[] {
  const issues: Issue[] = [];

  for (const part of netlist.parts) {
    for (const pin of part.pins) {
      if (pin.net !== undefined || isOpenByDesign(pin)) continue;
      const power = pin.type === "power_in";
      const hint = !power
        ? "; connect it, or mark it nc if it is open on purpose"
        : pin.open
          ? "; a power pin cannot be nc"
          : "";
      issues.push({
        code: "erc.unconnected-pin",
        severity: power ? "error" : "warning",
        message: `${pinLabel(pin)} (pin ${pin.number}, ${pin.type}) is not connected${hint}`,
        location: part.location,
        subjects: pinSubjects(pin),
      });
    }
  }

  for (const net of netlist.nets) {
    const pins = net.pins;
    if (pins.length < 2) {
      const only = pins[0];
      issues.push(
        netIssue(
          net,
          "erc.single-pin-net",
          "warning",
          only ? `only ${pinLabel(only)} is on this net` : "net has no pins",
          pins,
        ),
      );
    }

    const driving = pins.filter((p) => drivers.has(p.type));
    if (new Set(driving.map((p) => p.part)).size > 1) {
      issues.push(
        netIssue(
          net,
          "erc.output-conflict",
          "error",
          `${driving.map(pinLabel).join(", ")} all drive this net`,
          driving,
        ),
      );
    }

    const powerIn = pins.filter((p) => p.type === "power_in");
    const sourced =
      pins.some((p) => p.type === "power_out") ||
      net.attrs.source !== undefined ||
      net.portKinds.includes("ground");
    if (powerIn.length > 0 && !sourced) {
      issues.push(
        netIssue(
          net,
          "erc.unsourced-power",
          "error",
          `${powerIn.map(pinLabel).join(", ")} ${powerIn.length > 1 ? "need" : "needs"} power ` +
            "but no power_out pin is on this net; " +
            "if it is supplied externally or through a passive part, add {source: <where from>}",
          powerIn,
        ),
      );
    }

    const inputs = pins.filter((p) => p.type === "input");
    if (inputs.length > 0 && !pins.some((p) => signalSources.has(p.type))) {
      issues.push(
        netIssue(
          net,
          "erc.undriven-input",
          "warning",
          `${inputs.map(pinLabel).join(", ")} ${inputs.length > 1 ? "are" : "is"} not driven by anything`,
          inputs,
        ),
      );
    }
  }
  return issues;
}
