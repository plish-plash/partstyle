import { isMap, isScalar, type Node, type Pair, parseDocument } from "yaml";

const KEY = "in_inventory";

const isFlag = (p: Pair) => isScalar(p.key) && p.key.value === KEY;
const rangeOf = (x: unknown) => (x as Node).range as [number, number, number];

/**
 * A record's text with `sourcing.in_inventory` set or removed. Only that entry changes: records
 * cache a datasheet in whatever style they were written, which rewriting the document would lose.
 */
export function setInventoryFlag(text: string, inInventory: boolean): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const doc = parseDocument(text);
  const sourcing = doc.get("sourcing", true);
  if (!isMap(sourcing) || sourcing.items.length === 0 || !sourcing.range) {
    if (!inInventory) return text;
    if (sourcing === undefined) return `${text.trimEnd()}${eol}sourcing: { ${KEY}: true }${eol}`;
    doc.set("sourcing", doc.createNode({ [KEY]: true }));
    return doc.toString({ lineWidth: 0 });
  }

  const pairs = sourcing.items as Pair[];
  const flag = pairs.find(isFlag);
  if (sourcing.flow) {
    const kept = pairs
      .filter((p) => p !== flag)
      .map((p) => text.slice(rangeOf(p.key)[0], rangeOf(p.value ?? p.key)[1]));
    const items = [...kept, ...(inInventory ? [`${KEY}: true`] : [])];
    const map = items.length > 0 ? `{ ${items.join(", ")} }` : "{}";
    const [start, end] = sourcing.range;
    return text.slice(0, start) + map + text.slice(end);
  }

  const lineStart = (at: number) => text.lastIndexOf("\n", at) + 1;
  const first = rangeOf(pairs[0]?.key)[0];
  const line = `${text.slice(lineStart(first), first)}${KEY}: true${eol}`;
  if (!flag) {
    if (!inInventory) return text;
    return text.slice(0, lineStart(first)) + line + text.slice(lineStart(first));
  }
  const start = lineStart(rangeOf(flag.key)[0]);
  const next = text.indexOf("\n", start);
  const rest = next === -1 ? "" : text.slice(next + 1);
  return text.slice(0, start) + (inInventory ? line : "") + rest;
}
