import { isGroundNet } from "../checks/nets.js";
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

    const ground = isGroundNet(net);
    const external = net.attrs.source !== undefined;
    const powerIn = pins.filter((p) => p.type === "power_in");
    // Ground needs no source: a net named GND is ground whether or not it crosses a port.
    const sourced = pins.some((p) => p.type === "power_out") || external || ground;
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
    if (inputs.length > 0 && !external && !pins.some((p) => signalSources.has(p.type))) {
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

    // An open-collector (or open-emitter) output only pulls one way: something must pull the
    // other. A resistor, a supply on the net, or a stated source will do.
    for (const [type, way] of [
      ["open_collector", "up"],
      ["open_emitter", "down"],
    ] as const) {
      const open = pins.filter((p) => p.type === type);
      const pulled = external || pins.some((p) => p.type === "passive" || p.type === "power_out");
      if (open.length === 0 || pulled) continue;
      issues.push(
        netIssue(
          net,
          "erc.no-pull",
          "warning",
          `${open.map(pinLabel).join(", ")} ${open.length > 1 ? "are" : "is"} ${type.replace("_", "-")} and nothing pulls the net ${way}; ` +
            `add a pull-${way} resistor, or {source: ...} if one is outside the design`,
          open,
        ),
      );
    }

    // A datasheet NC pin may be bonded to something inside the part.
    const ncPins = pins.filter((p) => p.type === "nc");
    if (ncPins.length > 0) {
      issues.push(
        netIssue(
          net,
          "erc.nc-pin-connected",
          "warning",
          `${ncPins.map(pinLabel).join(", ")} ${ncPins.length > 1 ? "are" : "is"} a no-connect pin; ` +
            "leave it open, or make it passive in the part record if the datasheet allows wiring it",
          ncPins,
        ),
      );
    }

    // A supply output on ground is almost always a short (a virtual-ground IC is the exception).
    const supplies = pins.filter((p) => p.type === "power_out");
    if (ground && supplies.length > 0) {
      issues.push(
        netIssue(
          net,
          "erc.power-out-on-ground",
          "warning",
          `${supplies.map(pinLabel).join(", ")} ${supplies.length > 1 ? "are supply outputs" : "is a supply output"} on ground net ${net.name}, which shorts it`,
          supplies,
        ),
      );
    }
  }
  return issues;
}
