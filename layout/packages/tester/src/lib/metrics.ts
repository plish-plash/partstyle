import type { Metrics } from "@partstyle/layout";

export interface MetricRow {
  key: keyof Metrics;
  label: string;
  /** Which direction is an improvement. */
  better: "low" | "high" | "none";
  unit?: string;
}

export const METRIC_ROWS: MetricRow[] = [
  { key: "crossings", label: "Crossings", better: "low" },
  { key: "railCrossings", label: "Power and label crossings", better: "none" },
  { key: "powerWire", label: "Power wire length", better: "low" },
  { key: "straightPercent", label: "Straight 2-pin nets", better: "high", unit: "%" },
  { key: "bends", label: "Bends", better: "low" },
  { key: "wireLength", label: "Wire length", better: "low" },
  { key: "labels", label: "Net labels", better: "low" },
  { key: "signalBackwards", label: "Backward signals", better: "low" },
  { key: "powerWrongWay", label: "Power wrong way", better: "low" },
  { key: "shuntMisplaced", label: "Misplaced shunts", better: "low" },
  { key: "width", label: "Width", better: "none" },
  { key: "height", label: "Height", better: "none" },
];

/** `good`, `bad` or `same` for a change in a metric. */
export function deltaKind(row: MetricRow, now: number, then: number) {
  if (now === then || row.better === "none") return "same";
  return (row.better === "low") === now < then ? "good" : "bad";
}
