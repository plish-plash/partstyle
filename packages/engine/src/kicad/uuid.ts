/**
 * Deterministic UUIDs from names. KiCad links PCB footprints to schematic symbols by UUID path,
 * so re-exporting the same design must give the same UUIDs for "Update PCB" to keep placement.
 * Pure JS (no node:crypto) so the engine stays browser-safe; this is not a security hash.
 */
function fnv1a64(text: string, seed: bigint): bigint {
  let h = 0xcbf29ce484222325n ^ seed;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

export function stableUuid(...parts: string[]): string {
  const key = parts.join("\u0000");
  const hex = (
    fnv1a64(key, 0n).toString(16).padStart(16, "0") +
    fnv1a64(key, 0x9e3779b97f4a7c15n).toString(16).padStart(16, "0")
  ).split("");
  hex[12] = "5"; // version
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16); // variant
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
